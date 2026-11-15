// SPEC-2026-11-10-kaneo-card-agent-collaboration T2: task-scoped bearer
// capability. A task link grants exactly one card and its CURRENT same-project
// `subtask` descendant tree — recalculated on every request. Everything else
// fails closed with the same generic 404: wrong token type, out-of-tree ids,
// cross-project ids, revoked/expired links, agent-controlled tasks, and
// manifest-redacted descriptions.
//
// This module owns the explicit allowlisted task DTO. It must never reuse
// `fullGetTaskDetail` or any project share payload, and it never exposes
// blocks/related edges, assignee identity, workspace ids, or execution state.
import { and, asc, count, desc, eq, inArray, lt, max, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import {
  assertContentAssetKeyMatchesContext,
  createContentAssetUploadUrl,
  deleteS3Object,
  getPrivateObjectMeta,
  getPrivateObjectPrefix,
  isImageContentType,
  validateFullLinkUploadInput,
} from "../storage/s3";
import { lockProjectTaskLanes } from "../task/lock-project-task-lanes";
import { assertTaskContentRevision } from "../task/content-revision";
import { normalizeWorkMarkerCounts } from "../task/work-marker-counts";
import {
  assertValidPriority,
  assertValidTaskStatus,
  VIRTUAL_STATUSES,
} from "../task/validate-task-fields";
import { claimTaskNumber } from "../task/controllers/claim-task-numbers";
import {
  getFullLinkUploadUsage,
  isProjectAgentControlledStrict,
  isTaskAgentControlled,
} from "./full-access";
import {
  appendShareActionAudit,
  type ResolvedShareLink,
} from "./resolve-share-link";

const notFound = () => new HTTPException(404, { message: "Not found" });
const GUEST_ACTOR_LABEL = "Share link holder";
const MAX_SUBTREE_DEPTH = 32;

// Upload caps mirror the full-link policy: images/attachments onto cards are
// quota-bound per link and per resource, never a free-for-all.
const FULL_LINK_MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
const FULL_LINK_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const FULL_LINK_MAX_FILES_PER_RESOURCE = 20;
const COMMENTS_DEFAULT_LIMIT = 10;
const COMMENTS_MAX_LIMIT = 50;

type ShareTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ShareQueryExecutor = typeof db | ShareTransaction;

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

export type TaskShareScope = {
  rootTaskId: string;
  projectId: string;
  root: typeof schema.taskTable.$inferSelect;
  tasks: typeof schema.taskTable.$inferSelect[];
  manifestProject: boolean;
};
// Cycle-safe BFS over explicit `subtask` edges, all within the root's project.
// Any cycle, depth overflow, missing row, cross-project child, or task that
// touches a run/schedule/phase-card fails the WHOLE link closed with 404.
export async function resolveTaskShareScope(
  link: ResolvedShareLink,
  executor: ShareQueryExecutor = db,
): Promise<TaskShareScope> {
  const [root] = await executor
    .select()
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, link.resourceId))
    .limit(1);
  if (!root) throw notFound();
  return resolveTaskSubtreeScope(root.id, root.projectId, executor);
}

// SPEC-2026-11-10 T4: shared subtree resolver. Both the task-share bearer
// link and the agent-session card binding authorize over exactly this shape:
// the root card plus its CURRENT same-project subtask descendant tree,
// re-resolved per request, failing closed on cycles/depth/cross-project/
// agent-controlled rows.
export async function resolveTaskSubtreeScope(
  rootTaskId: string,
  expectedProjectId: string,
  executor: ShareQueryExecutor = db,
): Promise<TaskShareScope> {
  const [root] = await executor
    .select()
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, rootTaskId))
    .limit(1);
  if (!root) throw notFound();
  if (root.projectId !== expectedProjectId) throw notFound();

  const projectId = root.projectId;
  const tasksById = new Map<string, typeof schema.taskTable.$inferSelect>([
    [root.id, root],
  ]);
  let frontier = [root.id];
  let depth = 0;

  while (frontier.length > 0) {
    if (depth > MAX_SUBTREE_DEPTH) throw notFound();
    const childEdges = await executor
      .select({
        sourceTaskId: schema.taskRelationTable.sourceTaskId,
        targetTaskId: schema.taskRelationTable.targetTaskId,
      })
      .from(schema.taskRelationTable)
      .where(
        and(
          inArray(schema.taskRelationTable.sourceTaskId, frontier),
          eq(schema.taskRelationTable.relationType, "subtask"),
        ),
      );
    const nextChildIds = new Set<string>();
    for (const edge of childEdges) {
      // An edge back to any visited task is a cycle. Multiple parents for a
      // child also violate the tree contract, so reject duplicate targets.
      if (tasksById.has(edge.targetTaskId) || nextChildIds.has(edge.targetTaskId)) {
        throw notFound();
      }
      nextChildIds.add(edge.targetTaskId);
    }
    const unseenChildIds = [...nextChildIds];
    if (unseenChildIds.length === 0) {
      frontier = [];
      continue;
    }
    const childTasks = await executor
      .select()
      .from(schema.taskTable)
      .where(inArray(schema.taskTable.id, unseenChildIds));
    if (childTasks.length !== unseenChildIds.length) throw notFound();
    for (const child of childTasks) {
      if (child.projectId !== projectId) throw notFound();
      // A task inside the tree that participates in a run/schedule/phase-card
      // makes the entire link unusable — descriptions of such trees are
      // execution data and no heuristic may split them.
      if (await isTaskAgentControlled(child.id)) throw notFound();
      tasksById.set(child.id, child);
    }
    frontier = childTasks.map((child) => child.id);
    depth++;
  }

  if (await isTaskAgentControlled(root.id)) throw notFound();

  return {
    rootTaskId: root.id,
    projectId,
    root,
    tasks: [...tasksById.values()],
    manifestProject: await isProjectAgentControlledStrict(projectId),
  };
}

export async function assertTaskInShareScope(
  scope: TaskShareScope,
  taskId: string,
): Promise<typeof schema.taskTable.$inferSelect> {
  const task = scope.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw notFound();
  // The dynamic tree can change between resolve and write; re-verify the
  // concrete row still belongs to the same project.
  if (task.projectId !== scope.projectId) throw notFound();
  return task;
}

function statusLabelMap(
  columns: Array<{ slug: string; name: string }>,
): Map<string, string> {
  return new Map(columns.map((column) => [column.slug, column.name]));
}

// ---------------------------------------------------------------------------
// DTO builders — explicit allowlists only
// ---------------------------------------------------------------------------

type ShareTaskDto = {
  id: string;
  number: number | null;
  title: string;
  description: string | null;
  status: string;
  statusLabel: string | null;
  priority: string | null;
  startDate: Date | null;
  dueDate: Date | null;
  contentRevision: number;
  workMarkerCounts: ReturnType<typeof normalizeWorkMarkerCounts>;
  labels: Array<{ id: string; name: string; color: string | null }>;
  assetRefs: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    surface: string;
    taskId: string;
  }>;
};

async function buildTaskShareDtos(
  scope: TaskShareScope,
  tasks: typeof scope.tasks,
): Promise<ShareTaskDto[]> {
  if (tasks.length === 0) return [];
  const taskIds = tasks.map((task) => task.id);
  const columns = await db
    .select({ slug: schema.columnTable.slug, name: schema.columnTable.name })
    .from(schema.columnTable)
    .where(eq(schema.columnTable.projectId, scope.projectId));
  const labelByTask = statusLabelMap(columns);

  const labels = await db
    .select({
      id: schema.labelTable.id,
      name: schema.labelTable.name,
      color: schema.labelTable.color,
      taskId: schema.labelTable.taskId,
    })
    .from(schema.labelTable)
    .where(inArray(schema.labelTable.taskId, taskIds));

  const assets = await db
    .select({
      id: schema.assetTable.id,
      filename: schema.assetTable.filename,
      mimeType: schema.assetTable.mimeType,
      size: schema.assetTable.size,
      surface: schema.assetTable.surface,
      taskId: schema.assetTable.taskId,
    })
    .from(schema.assetTable)
    .where(
      and(
        inArray(schema.assetTable.taskId, taskIds),
        inArray(schema.assetTable.surface, ["description", "comment"]),
      ),
    );

  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    number: task.number,
    // Manifest projects hide descriptions project-wide, read-only.
    description:
      scope.manifestProject || !task.description ? null : task.description,
    status: task.status,
    statusLabel: labelByTask.get(task.status) ?? null,
    priority: task.priority,
    startDate: task.startDate,
    dueDate: task.dueDate,
    contentRevision: task.contentRevision,
    workMarkerCounts: normalizeWorkMarkerCounts(task.workMarkerCounts),
    labels: labels
      .filter((label) => label.taskId === task.id)
      .map((label) => ({ id: label.id, name: label.name, color: label.color })),
    assetRefs: assets
      .filter(
        (asset): asset is typeof assets[number] & { taskId: string } =>
          asset.taskId === task.id,
      )
      .map((asset) => ({
        id: asset.id,
        filename: asset.filename,
        mimeType: asset.mimeType,
        size: asset.size,
        surface: asset.surface,
        taskId: asset.taskId,
      })),
  }));
}

async function loadCommentsPage(taskId: string, cursor?: string, rawLimit?: string) {
  const parsedLimit = rawLimit ? Number(rawLimit) : COMMENTS_DEFAULT_LIMIT;
  const limit = Number.isInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), COMMENTS_MAX_LIMIT)
    : COMMENTS_DEFAULT_LIMIT;

  const conditions: SQL[] = [
    eq(schema.activityTable.taskId, taskId),
    eq(schema.activityTable.type, "comment"),
  ];
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conditions.push(lt(schema.activityTable.createdAt, cursorDate));
    }
  }

  const rows = await db
    .select({
      id: schema.activityTable.id,
      content: schema.activityTable.content,
      createdAt: schema.activityTable.createdAt,
      updatedAt: schema.activityTable.updatedAt,
      userId: schema.activityTable.userId,
      externalUserName: schema.activityTable.externalUserName,
      externalSource: schema.activityTable.externalSource,
      authorName: schema.userTable.name,
    })
    .from(schema.activityTable)
    .leftJoin(schema.userTable, eq(schema.activityTable.userId, schema.userTable.id))
    .where(and(...conditions))
    .orderBy(desc(schema.activityTable.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map((row) => {
    const authorType = row.userId
      ? "member"
      : row.externalSource === "share-link"
        ? "guest"
        : "system";
    return {
      id: row.id,
      content: row.content ?? "",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      authorName: row.authorName ?? row.externalUserName ?? GUEST_ACTOR_LABEL,
      authorType,
    };
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

async function loadProjectColumns(projectId: string) {
  return db
    .select({
      slug: schema.columnTable.slug,
      name: schema.columnTable.name,
      isFinal: schema.columnTable.isFinal,
    })
    .from(schema.columnTable)
    .where(eq(schema.columnTable.projectId, projectId))
    .orderBy(asc(schema.columnTable.position));
}

// Parent breadcrumbs are computed inside `buildTaskShareSubtreePayload` with
// a direct edge lookup; no separate helper is needed.

export async function buildTaskShareRootPayload(link: ResolvedShareLink) {
  const scope = await resolveTaskShareScope(link);
  const columns = await loadProjectColumns(scope.projectId);
  const [dto] = await buildTaskShareDtos(scope, [scope.root]);
  if (!dto) throw notFound();
  const subtaskDtos = await buildTaskShareDtos(
    scope,
    scope.tasks.filter((task) => task.id !== scope.rootTaskId),
  );
  const commentsPage = await loadCommentsPage(scope.rootTaskId);

  return {
    permission: link.permission,
    rootTaskId: scope.rootTaskId,
    // Adapter/cache scope only: carries no authority and no project metadata.
    scopeProjectId: scope.projectId,
    // Both permissions need the same lane names to render the shared card on
    // the owner board. This is board scaffolding, not project enumeration.
    statusOptions: columns.map((column) => ({
      slug: column.slug,
      name: column.name,
      isFinal: column.isFinal,
    })),
    root: dto,
    subtasks: subtaskDtos,
    commentsPage,
  };
}

export async function buildTaskShareSubtreePayload(
  link: ResolvedShareLink,
  taskId: string,
) {
  const scope = await resolveTaskShareScope(link);
  const task = await assertTaskInShareScope(scope, taskId);
  const columns = await loadProjectColumns(scope.projectId);
  const [dto] = await buildTaskShareDtos(scope, [task]);
  if (!dto) throw notFound();
  const childEdges = await db
    .select({
      id: schema.taskRelationTable.id,
      targetTaskId: schema.taskRelationTable.targetTaskId,
      position: schema.taskRelationTable.position,
    })
    .from(schema.taskRelationTable)
    .where(
      and(
        eq(schema.taskRelationTable.sourceTaskId, task.id),
        eq(schema.taskRelationTable.relationType, "subtask"),
      ),
    );
  const childTasks = childEdges
    .map((edge) => scope.tasks.find((candidate) => candidate.id === edge.targetTaskId))
    .filter((candidate): candidate is typeof schema.taskTable.$inferSelect =>
      Boolean(candidate),
    );
  const subtaskDtos = await buildTaskShareDtos(scope, childTasks);
  const commentsPage = await loadCommentsPage(task.id);

  // Parent breadcrumb only when the parent is inside this shared subtree.
  const [parentEdge] = await db
    .select({ sourceTaskId: schema.taskRelationTable.sourceTaskId })
    .from(schema.taskRelationTable)
    .where(
      and(
        eq(schema.taskRelationTable.targetTaskId, task.id),
        eq(schema.taskRelationTable.relationType, "subtask"),
      ),
    )
    .limit(1);
  const parentId = parentEdge?.sourceTaskId;
  const parent =
    parentId && scope.tasks.some((candidate) => candidate.id === parentId)
      ? {
          id: parentId,
          title:
            scope.tasks.find((candidate) => candidate.id === parentId)?.title ??
            "",
        }
      : null;

  return {
    permission: link.permission,
    rootTaskId: scope.rootTaskId,
    scopeProjectId: scope.projectId,
    statusOptions: columns.map((column) => ({
      slug: column.slug,
      name: column.name,
      isFinal: column.isFinal,
    })),
    task: dto,
    parent,
    subtasks: subtaskDtos,
    // Edit links need the relation ids to drive the scoped reorder route;
    // view links never receive them.
    subtaskRelations:
      link.permission === "edit"
        ? childEdges.map((edge) => ({
            relationId: edge.id,
            targetTaskId: edge.targetTaskId,
            position: edge.position,
          }))
        : undefined,
    commentsPage,
  };
}

// ---------------------------------------------------------------------------
// Guest writes — task-share action matrix
// ---------------------------------------------------------------------------

async function reloadScopeForWrite(
  link: ResolvedShareLink,
): Promise<TaskShareScope> {
  // Fresh resolve per mutation: deleted/moved/re-scoped cards must not be
  // writable through a cached scope.
  return resolveTaskShareScope(link);
}

function assertDescriptionAllowed(scope: TaskShareScope, hasDescription: boolean) {
  if (scope.manifestProject && hasDescription) {
    throw new HTTPException(403, {
      message:
        "Descriptions are read-only in manifest projects; this link cannot write them.",
    });
  }
}

function stripCapabilityAssetTokensForTask(content: string): string {
  // Guest editors paste capability URLs back; normalize to canonical
  // token-free refs before persisting (same contract as full links).
  return content.replace(
    /(?:https?:\/\/[^/\s]+)?\/api\/share\/(?:task|project)\/[A-Za-z0-9_-]{43}\/asset\/([A-Za-z0-9_-]+)/g,
    "/asset/$1",
  );
}

export async function taskShareUpdateTask(
  link: ResolvedShareLink,
  taskId: string,
  body: {
    patch: {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      startDate?: string | null;
      dueDate?: string | null;
    };
    expectedContentRevision: number;
  },
) {
  const scope = await reloadScopeForWrite(link);
  const task = await assertTaskInShareScope(scope, taskId);
  assertDescriptionAllowed(scope, body.patch.description !== undefined);

  const updates: Partial<typeof schema.taskTable.$inferInsert> = {};
  if (body.patch.title !== undefined) updates.title = body.patch.title;
  if (body.patch.description !== undefined) {
    updates.description = stripCapabilityAssetTokensForTask(
      body.patch.description,
    );
  }
  if (body.patch.priority !== undefined) {
    assertValidPriority(body.patch.priority);
    updates.priority = body.patch.priority;
  }
  if (body.patch.status !== undefined && body.patch.status !== task.status) {
    await assertValidTaskStatus(body.patch.status, scope.projectId);
    if (
      VIRTUAL_STATUSES.includes(
        body.patch.status as (typeof VIRTUAL_STATUSES)[number],
      )
    ) {
      throw new HTTPException(400, {
        message: "Share links cannot set planned or archived status",
      });
    }
    const [column] = await db
      .select({ id: schema.columnTable.id })
      .from(schema.columnTable)
      .where(
        and(
          eq(schema.columnTable.projectId, scope.projectId),
          eq(schema.columnTable.slug, body.patch.status),
        ),
      )
      .limit(1);
    updates.status = body.patch.status;
    updates.columnId = column?.id ?? null;
  }
  if (body.patch.startDate !== undefined) {
    updates.startDate = body.patch.startDate
      ? new Date(body.patch.startDate)
      : null;
  }
  if (body.patch.dueDate !== undefined) {
    updates.dueDate = body.patch.dueDate ? new Date(body.patch.dueDate) : null;
  }
  if (Object.keys(updates).length === 0) {
    throw new HTTPException(400, { message: "No valid card fields to update" });
  }

  const updated = await db.transaction(async (tx) => {
    if (updates.status !== undefined) {
      await lockProjectTaskLanes(tx, [scope.projectId]);
    }
    const [locked] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id))
      .for("update")
      .limit(1);
    if (!locked) throw notFound();
    await assertTaskContentRevision(tx, task.id, body.expectedContentRevision);
    if (updates.status !== undefined) {
      const [targetColumn] = await tx
        .select({ id: schema.columnTable.id })
        .from(schema.columnTable)
        .where(
          and(
            eq(schema.columnTable.projectId, scope.projectId),
            eq(schema.columnTable.slug, updates.status),
          ),
        )
        .for("update")
        .limit(1);
      updates.columnId = targetColumn?.id ?? null;
    }
    const [row] = await tx
      .update(schema.taskTable)
      .set({ ...updates, contentRevision: locked.contentRevision + 1 })
      .where(eq(schema.taskTable.id, task.id))
      .returning();
    if (!row) throw notFound();
    await appendShareActionAudit(link, "task.update", tx);
    return row;
  });

  return {
    task: {
      id: updated.id,
      title: updated.title,
      description: scope.manifestProject ? null : updated.description,
      status: updated.status,
      priority: updated.priority,
      startDate: updated.startDate,
      dueDate: updated.dueDate,
      contentRevision: updated.contentRevision,
    },
    contentRevision: updated.contentRevision,
  };
}

export async function taskShareCreateSubtask(
  link: ResolvedShareLink,
  parentTaskId: string,
  body: {
    expectedParentContentRevision: number;
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    startDate?: string;
    dueDate?: string;
  },
) {
  const scope = await reloadScopeForWrite(link);
  const parent = await assertTaskInShareScope(scope, parentTaskId);
  assertDescriptionAllowed(scope, body.description !== undefined);

  const status = body.status || "to-do";
  const priority = body.priority || "no-priority";
  await assertValidTaskStatus(status, scope.projectId);
  if (VIRTUAL_STATUSES.includes(status as (typeof VIRTUAL_STATUSES)[number])) {
    throw new HTTPException(400, {
      message: "Share links cannot set planned or archived status",
    });
  }
  assertValidPriority(priority);

  const result = await db.transaction(async (tx) => {
    await lockProjectTaskLanes(tx, [scope.projectId]);
    const [lockedParent] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, parent.id))
      .for("update")
      .limit(1);
    if (!lockedParent) throw notFound();
    await assertTaskContentRevision(
      tx,
      parent.id,
      body.expectedParentContentRevision,
    );

    const taskNumber = await claimTaskNumber(scope.projectId, tx);
    const [column] = await tx
      .select({ id: schema.columnTable.id })
      .from(schema.columnTable)
      .where(
        and(
          eq(schema.columnTable.projectId, scope.projectId),
          eq(schema.columnTable.slug, status),
        ),
      )
      .limit(1);
    const [maxPositionResult] = await tx
      .select({ maxPosition: max(schema.taskTable.position) })
      .from(schema.taskTable)
      .where(
        and(
          eq(schema.taskTable.projectId, scope.projectId),
          column?.id
            ? eq(schema.taskTable.columnId, column.id)
            : eq(schema.taskTable.status, status),
        ),
      );

    // Atomic fresh child + subtask edge; no arbitrary relation writes.
    const [child] = await tx
      .insert(schema.taskTable)
      .values({
        projectId: scope.projectId,
        userId: null,
        title: body.title,
        description: body.description ?? "",
        status,
        columnId: column?.id ?? null,
        position: (maxPositionResult?.maxPosition ?? 0) + 1,
        startDate: body.startDate ? new Date(body.startDate) : null,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        priority,
        number: taskNumber,
      })
      .returning();
    if (!child) throw notFound();

    const [maxEdgePosition] = await tx
      .select({ value: max(schema.taskRelationTable.position) })
      .from(schema.taskRelationTable)
      .where(
        and(
          eq(schema.taskRelationTable.sourceTaskId, parent.id),
          eq(schema.taskRelationTable.relationType, "subtask"),
        ),
      );
    const [relation] = await tx
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId: parent.id,
        targetTaskId: child.id,
        relationType: "subtask",
        position: (maxEdgePosition?.value ?? -1) + 1,
      })
      .returning();
    if (!relation) throw notFound();

    const [bumpedParent] = await tx
      .update(schema.taskTable)
      .set({ contentRevision: lockedParent.contentRevision + 1 })
      .where(eq(schema.taskTable.id, parent.id))
      .returning({ contentRevision: schema.taskTable.contentRevision });
    if (!bumpedParent) throw notFound();

    await appendShareActionAudit(link, "task.subtask.create", tx, child.id);
    return { child, relation, parentContentRevision: bumpedParent.contentRevision };
  });

  return {
    task: {
      id: result.child.id,
      number: result.child.number,
      title: result.child.title,
      description: scope.manifestProject ? null : result.child.description,
      status: result.child.status,
      priority: result.child.priority,
      startDate: result.child.startDate,
      dueDate: result.child.dueDate,
      contentRevision: result.child.contentRevision,
    },
    relation: {
      id: result.relation.id,
      sourceTaskId: result.relation.sourceTaskId,
      targetTaskId: result.relation.targetTaskId,
      position: result.relation.position,
    },
    parentContentRevision: result.parentContentRevision,
  };
}

export async function taskShareReorderSubtask(
  link: ResolvedShareLink,
  relationId: string,
  body: { position: number; expectedParentContentRevision: number },
) {
  const scope = await reloadScopeForWrite(link);
  if (
    !Number.isInteger(body.position) ||
    body.position < 0 ||
    body.position > 10000
  ) {
    throw new HTTPException(400, { message: "Invalid position" });
  }

  const result = await db.transaction(async (tx) => {
    const [relation] = await tx
      .select()
      .from(schema.taskRelationTable)
      .where(eq(schema.taskRelationTable.id, relationId))
      .for("update")
      .limit(1);
    if (
      !relation ||
      relation.relationType !== "subtask" ||
      !scope.tasks.some((candidate) => candidate.id === relation.sourceTaskId)
    ) {
      throw notFound();
    }
    // The moved child must stay inside the scope too.
    if (
      !scope.tasks.some((candidate) => candidate.id === relation.targetTaskId)
    ) {
      throw notFound();
    }

    const [lockedParent] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, relation.sourceTaskId))
      .for("update")
      .limit(1);
    if (!lockedParent) throw notFound();
    await assertTaskContentRevision(
      tx,
      relation.sourceTaskId,
      body.expectedParentContentRevision,
    );

    // Reindex sibling edges: the target moves to `position`, siblings keep
    // their relative order and shift around it.
    const siblings = await tx
      .select({ id: schema.taskRelationTable.id, targetTaskId: schema.taskRelationTable.targetTaskId })
      .from(schema.taskRelationTable)
      .where(
        and(
          eq(schema.taskRelationTable.sourceTaskId, relation.sourceTaskId),
          eq(schema.taskRelationTable.relationType, "subtask"),
        ),
      )
      .orderBy(asc(schema.taskRelationTable.position), asc(schema.taskRelationTable.createdAt))
      .for("update");
    const others = siblings.filter((sibling) => sibling.id !== relation.id);
    const ordered = [...others];
    ordered.splice(Math.min(body.position, others.length), 0, {
      id: relation.id,
      targetTaskId: relation.targetTaskId,
    });
    for (const [index, sibling] of ordered.entries()) {
      await tx
        .update(schema.taskRelationTable)
        .set({ position: index })
        .where(eq(schema.taskRelationTable.id, sibling.id));
    }

    const [bumpedParent] = await tx
      .update(schema.taskTable)
      .set({ contentRevision: lockedParent.contentRevision + 1 })
      .where(eq(schema.taskTable.id, relation.sourceTaskId))
      .returning({ contentRevision: schema.taskTable.contentRevision });
    if (!bumpedParent) throw notFound();

    await appendShareActionAudit(link, "task.subtask.reorder", tx, relation.id);
    return {
      relation: { id: relation.id, position: Math.min(body.position, others.length) },
      parentContentRevision: bumpedParent.contentRevision,
    };
  });

  return result;
}

async function assertLabelInTaskWorkspace(
  tx: ShareTransaction,
  labelId: string,
  projectId: string,
) {
  const [label] = await tx
    .select({
      id: schema.labelTable.id,
      workspaceId: schema.labelTable.workspaceId,
      taskId: schema.labelTable.taskId,
      name: schema.labelTable.name,
      color: schema.labelTable.color,
    })
    .from(schema.labelTable)
    .where(eq(schema.labelTable.id, labelId))
    .for("update")
    .limit(1);
  if (!label) throw notFound();
  const [project] = await tx
    .select({ workspaceId: schema.projectTable.workspaceId })
    .from(schema.projectTable)
    .where(eq(schema.projectTable.id, projectId))
    .limit(1);
  if (!project || label.workspaceId !== project.workspaceId) {
    throw notFound();
  }
  return label;
}

export async function taskShareAttachLabel(
  link: ResolvedShareLink,
  taskId: string,
  labelId: string,
) {
  const scope = await reloadScopeForWrite(link);
  const task = await assertTaskInShareScope(scope, taskId);
  return db.transaction(async (tx) => {
    const label = await assertLabelInTaskWorkspace(tx, labelId, scope.projectId);
    // Attach/detach only — never create or delete workspace labels.
    const [updated] = await tx
      .update(schema.labelTable)
      .set({ taskId: task.id })
      .where(eq(schema.labelTable.id, label.id))
      .returning({ id: schema.labelTable.id, taskId: schema.labelTable.taskId });
    if (!updated) throw notFound();
    await appendShareActionAudit(link, "task.label.attach", tx, label.id);
    return {
      labelId: updated.id,
      taskId: updated.taskId,
    };
  });
}

export async function taskShareDetachLabel(
  link: ResolvedShareLink,
  taskId: string,
  labelId: string,
) {
  const scope = await reloadScopeForWrite(link);
  const task = await assertTaskInShareScope(scope, taskId);
  return db.transaction(async (tx) => {
    const label = await assertLabelInTaskWorkspace(tx, labelId, scope.projectId);
    if (label.taskId !== task.id) throw notFound();
    await tx
      .update(schema.labelTable)
      .set({ taskId: null })
      .where(eq(schema.labelTable.id, label.id));
    await appendShareActionAudit(link, "task.label.detach", tx, label.id);
    return { labelId: label.id, taskId: null };
  });
}

export async function taskShareCreateComment(
  link: ResolvedShareLink,
  taskId: string,
  content: string,
) {
  const scope = await reloadScopeForWrite(link);
  const task = await assertTaskInShareScope(scope, taskId);
  const safeContent = stripCapabilityAssetTokensForTask(content);

  const created = await db.transaction(async (tx) => {
    const [activity] = await tx
      .insert(schema.activityTable)
      .values({
        taskId: task.id,
        type: "comment",
        userId: null,
        content: safeContent,
        // Link attribution without a fake user; no mention/assignee side
        // effects and never a steering trigger.
        externalUserName: GUEST_ACTOR_LABEL,
        externalSource: "share-link",
        eventData: { shareLinkId: link.id },
      })
      .returning();
    if (!activity) {
      throw new HTTPException(500, { message: "Failed to create comment" });
    }

    const referencedAssetIds = [
      ...new Set(
        (safeContent.match(/\/(?:api\/)?asset\/([a-z0-9]+)/gi) ?? []).map(
          (ref) => ref.split("/asset/")[1] ?? "",
        ),
      ),
    ].filter(Boolean);
    if (referencedAssetIds.length > 0) {
      // Only assets already attached to in-scope tasks may be bound to the
      // new comment.
      await tx
        .update(schema.assetTable)
        .set({ activityId: activity.id })
        .where(
          and(
            inArray(schema.assetTable.taskId, scope.tasks.map((t) => t.id)),
            eq(schema.assetTable.surface, "comment"),
            inArray(schema.assetTable.id, referencedAssetIds),
          ),
        );
    }

    await appendShareActionAudit(link, "comment.create", tx, activity.id);
    return activity;
  });

  return {
    commentId: created.id,
    content: created.content ?? "",
    createdAt: created.createdAt,
    authorName: GUEST_ACTOR_LABEL,
  };
}

// ---------------------------------------------------------------------------
// Asset upload/read (share-scoped tickets)
// ---------------------------------------------------------------------------

type TaskUploadOwnerType = "task_description" | "task_comment";

function assertUploadOwnerInScope(
  scope: TaskShareScope,
  // Surface is part of the contract signature; scope containment is what
  // actually guards here.
  _ownerType: TaskUploadOwnerType,
  ownerId: string,
) {
  if (!scope.tasks.some((candidate) => candidate.id === ownerId)) {
    throw notFound();
  }
}

async function resolveTaskUploadOwner(
  ownerType: TaskUploadOwnerType,
  ownerId: string,
) {
  const [task] = await db
    .select({
      id: schema.taskTable.id,
      projectId: schema.taskTable.projectId,
      workspaceId: schema.projectTable.workspaceId,
    })
    .from(schema.taskTable)
    .innerJoin(
      schema.projectTable,
      eq(schema.taskTable.projectId, schema.projectTable.id),
    )
    .where(eq(schema.taskTable.id, ownerId))
    .limit(1);
  if (!task) throw notFound();
  return {
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    taskId: task.id,
    ownerType,
    ownerId,
    surface: ownerType === "task_comment" ? "comment" : "description",
  };
}

function resourceAssetWhere(owner: {
  taskId: string;
  surface: string;
}): SQL | undefined {
  return and(
    eq(schema.assetTable.taskId, owner.taskId),
    inArray(schema.assetTable.surface, ["description", "comment"]),
  );
}

export async function taskShareCreateUploadTicket(
  link: ResolvedShareLink,
  input: {
    ownerType: TaskUploadOwnerType;
    ownerId: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  const scope = await reloadScopeForWrite(link);
  if (link.permission !== "edit") throw notFound();
  assertUploadOwnerInScope(scope, input.ownerType, input.ownerId);
  // Manifest projects keep description surfaces read-only; comment surfaces
  // on ordinary tasks stay writable.
  if (input.ownerType === "task_description" && scope.manifestProject) {
    throw new HTTPException(403, {
      message: "Descriptions are read-only in manifest projects.",
    });
  }
  const owner = await resolveTaskUploadOwner(input.ownerType, input.ownerId);

  try {
    validateFullLinkUploadInput(input.contentType, input.size);
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : "Invalid upload",
    });
  }
  if (input.size > FULL_LINK_MAX_BYTES_PER_FILE) {
    throw new HTTPException(400, {
      message: "Upload exceeds the 10MB per-file share-link limit.",
    });
  }

  const [usage, resourceCount] = await Promise.all([
    getFullLinkUploadUsage({ shareLinkId: link.id }),
    countScopeAssets(resourceAssetWhere(owner)),
  ]);
  if (usage.totalSize + input.size > FULL_LINK_MAX_TOTAL_BYTES) {
    throw new HTTPException(400, {
      message: "Share-link upload quota exceeded (100MB total).",
    });
  }
  if (resourceCount >= FULL_LINK_MAX_FILES_PER_RESOURCE) {
    throw new HTTPException(400, {
      message: "This resource already has the maximum number of files.",
    });
  }

  const upload = await createContentAssetUploadUrl({
    workspaceId: owner.workspaceId,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    filename: input.filename,
    contentType: input.contentType,
  });
  await appendShareActionAudit(link, "asset.upload-ticket");
  return upload;
}

async function countScopeAssets(where: SQL | undefined): Promise<number> {
  const [row] = await db
    .select({ fileCount: count() })
    .from(schema.assetTable)
    .where(where);
  return Number(row?.fileCount ?? 0);
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return [137, 80, 78, 71, 13, 10, 26, 10].every(
    (value, index) => bytes[index] === value,
  );
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function hasContainerBrand(bytes: Uint8Array, brands: string[]): boolean {
  if (asciiAt(bytes, 4, 4) !== "ftyp") return false;
  for (let offset = 8; offset + 4 <= bytes.length; offset += 4) {
    if (brands.includes(asciiAt(bytes, offset, 4))) return true;
  }
  return false;
}

function hasValidImageSignature(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case "image/png":
    case "image/apng":
      return hasPngSignature(bytes);
    case "image/jpeg":
    case "image/jpg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(asciiAt(bytes, 0, 6));
    case "image/webp":
      return asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP";
    case "image/avif":
      return hasContainerBrand(bytes, ["avif", "avis"]);
    case "image/heic":
      return hasContainerBrand(bytes, ["heic", "heix", "hevc", "hevx"]);
    case "image/heif":
      return hasContainerBrand(bytes, ["heif", "heim", "hevc", "hevx", "mif1", "msf1"]);
    default:
      return false;
  }
}

export async function taskShareFinalizeUpload(
  link: ResolvedShareLink,
  input: {
    ownerType: TaskUploadOwnerType;
    ownerId: string;
    key: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  const scope = await reloadScopeForWrite(link);
  if (link.permission !== "edit") throw notFound();
  assertUploadOwnerInScope(scope, input.ownerType, input.ownerId);
  if (input.ownerType === "task_description" && scope.manifestProject) {
    throw new HTTPException(403, {
      message: "Descriptions are read-only in manifest projects.",
    });
  }
  const owner = await resolveTaskUploadOwner(input.ownerType, input.ownerId);

  const normalizedKey = input.key.trim();
  if (
    !assertContentAssetKeyMatchesContext(normalizedKey, {
      workspaceId: owner.workspaceId,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
    })
  ) {
    throw new HTTPException(400, {
      message: "Upload key does not match the content resource.",
    });
  }

  try {
    validateFullLinkUploadInput(input.contentType, input.size);
  } catch (error) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : "Invalid upload",
    });
  }
  if (input.size > FULL_LINK_MAX_BYTES_PER_FILE) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "Upload exceeds the 10MB per-file share-link limit.",
    });
  }

  let actual: { contentType?: string; contentLength?: number };
  try {
    actual = await getPrivateObjectMeta(normalizedKey);
  } catch {
    throw new HTTPException(404, {
      message: "Staged upload not found. Upload the file first.",
    });
  }
  const actualLength = actual.contentLength ?? 0;
  const actualType =
    (actual.contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (actualLength <= 0 || actualLength !== input.size) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "Uploaded file size does not match the finalized metadata.",
    });
  }
  if (actualType !== input.contentType.toLowerCase().split(";")[0]?.trim()) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "Uploaded file type does not match the finalized metadata.",
    });
  }

  if (isImageContentType(actualType)) {
    let prefix: Uint8Array;
    try {
      prefix = await getPrivateObjectPrefix(normalizedKey);
    } catch {
      await deleteS3Object(normalizedKey).catch(() => {});
      throw new HTTPException(503, {
        message: "Could not verify the uploaded image. Try uploading it again.",
      });
    }
    if (!hasValidImageSignature(actualType, prefix)) {
      await deleteS3Object(normalizedKey).catch(() => {});
      throw new HTTPException(400, {
        message: "Uploaded image bytes do not match the declared image type.",
      });
    }
  }

  const [usage, resourceCount] = await Promise.all([
    getFullLinkUploadUsage({ shareLinkId: link.id }),
    countScopeAssets(resourceAssetWhere(owner)),
  ]);
  if (usage.totalSize + actualLength > FULL_LINK_MAX_TOTAL_BYTES) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "Share-link upload quota exceeded (100MB total).",
    });
  }
  if (resourceCount >= FULL_LINK_MAX_FILES_PER_RESOURCE) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "This resource already has the maximum number of files.",
    });
  }

  const assetId = await db.transaction(async (tx) => {
    // Re-verify the owner's scope membership under the link lock: a card
    // moved/unlinked between ticket and finalize must fail closed.
    const freshScope = await resolveTaskShareScope(link, tx);
    if (!freshScope.tasks.some((candidate) => candidate.id === owner.taskId)) {
      throw notFound();
    }
    await tx
      .select({ id: schema.shareLinkTable.id })
      .from(schema.shareLinkTable)
      .where(eq(schema.shareLinkTable.id, link.id))
      .for("update")
      .limit(1);

    const [duplicateKey] = await tx
      .select({ id: schema.assetTable.id })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, normalizedKey))
      .limit(1);
    if (duplicateKey) {
      throw new HTTPException(409, {
        message: "This upload key has already been finalized.",
      });
    }

    const [row] = await tx
      .insert(schema.assetTable)
      .values({
        workspaceId: owner.workspaceId,
        projectId: owner.projectId,
        taskId: owner.taskId,
        documentId: null,
        goalCheckinId: null,
        filename: input.filename,
        mimeType: actualType,
        size: actualLength,
        kind: actualType.startsWith("image/") ? "image" : "attachment",
        surface: owner.surface,
        // Created by the capability, not a user.
        createdBy: null,
        objectKey: normalizedKey,
      })
      .returning({ id: schema.assetTable.id });
    if (!row) {
      throw new HTTPException(500, { message: "Failed to persist asset" });
    }
    await appendShareActionAudit(link, "asset.finalize", tx, row.id);
    return row.id;
  });

  return {
    id: assetId,
    filename: input.filename,
    mimeType: actualType,
    size: actualLength,
  };
}

// Asset reads re-check that the asset's task is STILL in the current subtree
// before serving bytes.
export async function canTaskShareReadAsset(
  link: ResolvedShareLink,
  asset: { taskId: string | null; surface: string },
): Promise<boolean> {
  if (!asset.taskId) return false;
  if (!["description", "comment"].includes(asset.surface)) return false;
  const scope = await resolveTaskShareScope(link);
  return scope.tasks.some((candidate) => candidate.id === asset.taskId);
}

export async function taskShareUpdateWorkMarkers(
  link: ResolvedShareLink,
  taskId: string,
  body: { workMarkerCounts: unknown; expectedContentRevision: number },
) {
  const scope = await reloadScopeForWrite(link);
  const task = await assertTaskInShareScope(scope, taskId);

  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id))
      .for("update")
      .limit(1);
    if (!locked) throw notFound();
    await assertTaskContentRevision(tx, task.id, body.expectedContentRevision);
    const [row] = await tx
      .update(schema.taskTable)
      .set({
        workMarkerCounts: normalizeWorkMarkerCounts(body.workMarkerCounts),
        // Marker edits are ordinary content edits: CAS + advance, and never
        // the execution taskRevision.
        contentRevision: locked.contentRevision + 1,
      })
      .where(eq(schema.taskTable.id, task.id))
      .returning();
    if (!row) throw notFound();
    await appendShareActionAudit(link, "task.work-markers.update", tx);
    return row;
  });

  return {
    workMarkerCounts: normalizeWorkMarkerCounts(updated.workMarkerCounts),
    contentRevision: updated.contentRevision,
  };
}
