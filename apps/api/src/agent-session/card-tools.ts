// SPEC-2026-11-10-kaneo-card-agent-collaboration T4: card-focused wrappers
// behind the bound session. Only explicit scoped endpoints are exposed; root
// actions accept no target id, child/asset/comment ids only flow through
// their named helper, and the API rechecks subtree membership per call.
// Every write CASes on contentRevision and returns the fresh revision.
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { publishEvent } from "../events";
import { resolveTaskSubtreeScope } from "../share/task-share-access";
import {
  assertContentAssetKeyMatchesContext,
  createContentAssetUploadUrl,
  deleteS3Object,
  getPrivateObjectMeta,
  getPrivateObjectPrefix,
  validateFullLinkUploadInput,
} from "../storage/s3";
import { assertTaskContentRevision } from "../task/content-revision";
import { claimTaskNumber } from "../task/controllers/claim-task-numbers";
import { lockProjectTaskLanes } from "../task/lock-project-task-lanes";
import {
  assertValidPriority,
  assertValidTaskStatus,
  parseTaskDateInput,
  VIRTUAL_STATUSES,
} from "../task/validate-task-fields";
import { normalizeWorkMarkerCounts } from "../task/work-marker-counts";
import { type AgentSessionBinding, loadScopedBinding } from "./binding-service";

const notFound = () => new HTTPException(404, { message: "Not found" });

// Mirrors the share-link image signature check (PNG/JPEG/GIF/WEBP magic
// bytes) without importing share-module internals.
function hasValidImageSignature(contentType: string, prefix: Uint8Array) {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...prefix.subarray(offset, offset + length));
  if (contentType === "image/png") {
    return (
      prefix.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every(
        (value, index) => prefix[index] === value,
      )
    );
  }
  if (contentType === "image/jpeg") {
    return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8;
  }
  if (contentType === "image/gif") {
    return prefix.length >= 6 && ascii(0, 3) === "GIF";
  }
  if (contentType === "image/webp") {
    return (
      prefix.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP"
    );
  }
  return false;
}

export type BindingScope = Awaited<
  ReturnType<typeof loadScopedBinding>
>["scope"];

type BindingContext = {
  userId: string;
  bindingId: string;
  sessionId: string;
  generation: number;
};

type ShareTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function assertInScope(scope: BindingScope, taskId: string) {
  const task = scope.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw notFound();
  return task;
}

function assertSubtaskInScope(scope: BindingScope, taskId: string) {
  const task = assertInScope(scope, taskId);
  if (task.id === scope.rootTaskId) {
    throw new HTTPException(400, {
      message: "use the root card tools for the bound card itself",
    });
  }
  return task;
}

const staleBinding = () => new HTTPException(409, { message: "stale_binding" });

// Lock the current subtree task rows in stable order, re-resolve scope under
// those locks, then lock/recheck the binding. This shares lock order with the
// formal-run claim (root task -> binding): a race either finishes before the
// run claim or returns stale_binding after the claim/rebind commits.
async function lockBindingScope(
  tx: ShareTransaction,
  ctx: BindingContext,
  expectedBinding: AgentSessionBinding,
  targetTaskId: string,
): Promise<BindingScope> {
  // Serialize every binding-scope write through one transaction-scoped
  // advisory lock. SELECT ... FOR UPDATE with ORDER BY cannot guarantee lock
  // acquisition order (Postgres locks rows in scan order, not output order),
  // so parallel agent waves touching the same subtree deadlocked on these
  // tuple locks (11 deadlocks / 48h, all on this query). The advisory lock
  // makes same-scope operations strictly sequential; different scopes keep
  // independent keys and never contend. Released at commit/rollback.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`binding-scope:${expectedBinding.taskId}`}))`,
  );
  let initial: BindingScope;
  try {
    initial = await resolveTaskSubtreeScope(
      expectedBinding.taskId,
      expectedBinding.projectId,
      tx,
    );
  } catch (error) {
    if (
      error instanceof HTTPException &&
      [403, 404, 409].includes(error.status)
    ) {
      throw staleBinding();
    }
    throw error;
  }
  await tx
    .select({ id: schema.taskTable.id })
    .from(schema.taskTable)
    .where(
      inArray(
        schema.taskTable.id,
        initial.tasks.map((task) => task.id),
      ),
    )
    .orderBy(asc(schema.taskTable.id))
    .for("update");
  let scope: BindingScope;
  try {
    scope = await resolveTaskSubtreeScope(
      expectedBinding.taskId,
      expectedBinding.projectId,
      tx,
    );
  } catch (error) {
    if (
      error instanceof HTTPException &&
      [403, 404, 409].includes(error.status)
    ) {
      throw staleBinding();
    }
    throw error;
  }
  if (!scope.tasks.some((task) => task.id === targetTaskId))
    throw staleBinding();
  const [current] = await tx
    .select()
    .from(schema.agentSessionBindingTable)
    .where(eq(schema.agentSessionBindingTable.id, expectedBinding.id))
    .for("update")
    .limit(1);
  if (
    !current ||
    current.status !== "active" ||
    current.sessionId !== ctx.sessionId ||
    current.bindingGeneration !== ctx.generation ||
    current.taskId !== expectedBinding.taskId ||
    current.projectId !== expectedBinding.projectId
  ) {
    throw staleBinding();
  }
  return scope;
}

async function assertDescriptionAllowed(
  scope: BindingScope,
  hasDescription: boolean,
) {
  const [manifest] = await db
    .select({ id: schema.executionManifestTable.id })
    .from(schema.executionManifestTable)
    .where(eq(schema.executionManifestTable.projectId, scope.projectId))
    .limit(1);
  if (manifest && hasDescription) {
    throw new HTTPException(403, {
      message:
        "Descriptions are read-only in manifest projects; this binding cannot write them.",
    });
  }
}

// --- reads -----------------------------------------------------------------

export async function bindingCardGet(ctx: BindingContext) {
  const { scope } = await loadScopedBinding(ctx);
  const columns = await loadColumns(scope.projectId);
  const labelMap = new Map(columns.map((column) => [column.slug, column.name]));
  const root = scope.tasks.find((task) => task.id === scope.rootTaskId);
  if (!root) throw notFound();
  const [project] = await db
    .select({
      id: schema.projectTable.id,
      name: schema.projectTable.name,
      slug: schema.projectTable.slug,
      workspaceId: schema.projectTable.workspaceId,
    })
    .from(schema.projectTable)
    .where(eq(schema.projectTable.id, scope.projectId))
    .limit(1);
  if (!project) throw notFound();
  const labels = await db
    .select({
      id: schema.labelTable.id,
      name: schema.labelTable.name,
      color: schema.labelTable.color,
      taskId: schema.labelTable.taskId,
    })
    .from(schema.labelTable)
    .where(
      inArray(
        schema.labelTable.taskId,
        scope.tasks.map((task) => task.id),
      ),
    );
  const directEdges = await db
    .select({ targetTaskId: schema.taskRelationTable.targetTaskId })
    .from(schema.taskRelationTable)
    .where(
      and(
        eq(schema.taskRelationTable.sourceTaskId, root.id),
        eq(schema.taskRelationTable.relationType, "subtask"),
      ),
    )
    .orderBy(asc(schema.taskRelationTable.position));
  const directSubtasks = directEdges
    .map((edge) => scope.tasks.find((task) => task.id === edge.targetTaskId))
    .filter((task): task is NonNullable<typeof task> => Boolean(task));
  const subtaskCount = directSubtasks.length;
  return {
    project,
    card: {
      id: root.id,
      number: root.number,
      title: root.title,
      description: root.description,
      status: root.status,
      statusLabel: labelMap.get(root.status) ?? null,
      priority: root.priority,
      startDate: root.startDate,
      dueDate: root.dueDate,
      contentRevision: root.contentRevision,
      workMarkerCounts: normalizeWorkMarkerCounts(root.workMarkerCounts),
      labels: labels
        .filter((label) => label.taskId === root.id)
        .map(({ id, name, color }) => ({ id, name, color })),
    },
    statusOptions: columns.map((column) => ({
      slug: column.slug,
      name: column.name,
      isFinal: column.isFinal,
    })),
    subtasks: directSubtasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      statusLabel: labelMap.get(task.status) ?? null,
      contentRevision: task.contentRevision,
      workMarkerCounts: normalizeWorkMarkerCounts(task.workMarkerCounts),
    })),
    subtaskCount,
  };
}

export async function bindingCardGetSubtask(
  ctx: BindingContext,
  subtaskId: string,
) {
  const { binding, scope } = await loadScopedBinding(ctx);
  const task = assertSubtaskInScope(scope, subtaskId);
  return db.transaction(async (tx) => {
    const freshScope = await lockBindingScope(tx, ctx, binding, task.id);
    const freshTask = assertSubtaskInScope(freshScope, task.id);
    const columns = await loadColumns(freshScope.projectId, tx);
    const labelMap = new Map(columns.map((column) => [column.slug, column.name]));
    const directEdges = await tx
      .select({ targetTaskId: schema.taskRelationTable.targetTaskId })
      .from(schema.taskRelationTable)
      .where(
        and(
          eq(schema.taskRelationTable.sourceTaskId, freshTask.id),
          eq(schema.taskRelationTable.relationType, "subtask"),
        ),
      )
      .orderBy(asc(schema.taskRelationTable.position));
    const directSubtasks = directEdges
      .map((edge) => freshScope.tasks.find((candidate) => candidate.id === edge.targetTaskId))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

    return {
      subtask: {
        id: freshTask.id,
        title: freshTask.title,
        description: freshTask.description,
        status: freshTask.status,
        statusLabel: labelMap.get(freshTask.status) ?? null,
        priority: freshTask.priority,
        startDate: freshTask.startDate,
        dueDate: freshTask.dueDate,
        contentRevision: freshTask.contentRevision,
        workMarkerCounts: normalizeWorkMarkerCounts(freshTask.workMarkerCounts),
      },
      subtasks: directSubtasks.map((child) => ({
        id: child.id,
        title: child.title,
        status: child.status,
        statusLabel: labelMap.get(child.status) ?? null,
        contentRevision: child.contentRevision,
        workMarkerCounts: normalizeWorkMarkerCounts(child.workMarkerCounts),
      })),
      subtaskCount: directSubtasks.length,
    };
  });
}

async function loadColumns(
  projectId: string,
  executor: ShareTransaction | typeof db = db,
) {
  return executor
    .select({
      slug: schema.columnTable.slug,
      name: schema.columnTable.name,
      isFinal: schema.columnTable.isFinal,
    })
    .from(schema.columnTable)
    .where(eq(schema.columnTable.projectId, projectId))
    .orderBy(asc(schema.columnTable.position));
}

// --- writes ----------------------------------------------------------------

function stripCapabilityAssetTokens(content: string) {
  return content.replace(
    /(?:https?:\/\/[^/\s]+)?\/api\/share\/(?:task|project)\/[A-Za-z0-9_-]+\/asset\/([A-Za-z0-9_-]+)/g,
    "/asset/$1",
  );
}

export async function bindingCardUpdate(
  ctx: BindingContext,
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
  const { binding, scope } = await loadScopedBinding(ctx);
  const task = assertInScope(scope, scope.rootTaskId);
  await assertDescriptionAllowed(scope, body.patch.description !== undefined);

  const updates: Partial<typeof schema.taskTable.$inferInsert> = {};
  if (body.patch.title !== undefined) updates.title = body.patch.title;
  if (body.patch.description !== undefined) {
    updates.description = stripCapabilityAssetTokens(body.patch.description);
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
        message: "Bindings cannot set planned or archived status",
      });
    }
    updates.status = body.patch.status;
  }
  if (body.patch.startDate !== undefined) {
    updates.startDate = body.patch.startDate
      ? parseTaskDateInput("startDate", body.patch.startDate)
      : null;
  }
  if (body.patch.dueDate !== undefined) {
    updates.dueDate = body.patch.dueDate
      ? parseTaskDateInput("dueDate", body.patch.dueDate)
      : null;
  }
  if (Object.keys(updates).length === 0) {
    throw new HTTPException(400, { message: "No valid card fields to update" });
  }

  const result = await db.transaction(async (tx) => {
    if (updates.status !== undefined) {
      await lockProjectTaskLanes(tx, [scope.projectId]);
    }
    await lockBindingScope(tx, ctx, binding, task.id);
    const [locked] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id))
      .for("update")
      .limit(1);
    if (!locked) throw notFound();
    await assertTaskContentRevision(tx, task.id, body.expectedContentRevision);
    if (updates.status !== undefined) {
      const [column] = await tx
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
      updates.columnId = column?.id ?? null;
    }
    const [row] = await tx
      .update(schema.taskTable)
      .set({ ...updates, contentRevision: locked.contentRevision + 1 })
      .where(eq(schema.taskTable.id, task.id))
      .returning();
    if (!row) throw notFound();
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      contentRevision: row.contentRevision,
    };
  });
  await publishEvent("task.updated", {
    taskId: task.id,
    projectId: scope.projectId,
    userId: ctx.userId,
  });
  return result;
}

async function loadParentRelation(
  tx: ShareTransaction,
  scope: BindingScope,
  childTaskId: string,
) {
  const scopedTaskIds = scope.tasks.map((task) => task.id);
  const [relation] = await tx
    .select()
    .from(schema.taskRelationTable)
    .where(
      and(
        inArray(schema.taskRelationTable.sourceTaskId, scopedTaskIds),
        eq(schema.taskRelationTable.targetTaskId, childTaskId),
        eq(schema.taskRelationTable.relationType, "subtask"),
      ),
    )
    .limit(1);
  if (!relation) throw notFound();
  const parent = scope.tasks.find(
    (candidate) => candidate.id === relation.sourceTaskId,
  );
  if (!parent) throw notFound();
  return { relation, parent };
}

export async function bindingCardCreateSubtask(
  ctx: BindingContext,
  body: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    expectedParentContentRevision: number;
  },
) {
  const { binding, scope } = await loadScopedBinding(ctx);
  const parent = assertInScope(scope, scope.rootTaskId);
  await assertDescriptionAllowed(scope, body.description !== undefined);
  const status = body.status || "to-do";
  const priority = body.priority || "no-priority";
  await assertValidTaskStatus(status, scope.projectId);
  if (VIRTUAL_STATUSES.includes(status as (typeof VIRTUAL_STATUSES)[number])) {
    throw new HTTPException(400, {
      message: "Bindings cannot set planned or archived status",
    });
  }
  assertValidPriority(priority);

  const result = await db.transaction(async (tx) => {
    await lockProjectTaskLanes(tx, [scope.projectId]);
    await lockBindingScope(tx, ctx, binding, parent.id);
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
    const [child] = await tx
      .insert(schema.taskTable)
      .values({
        projectId: scope.projectId,
        title: body.title,
        description: body.description
          ? stripCapabilityAssetTokens(body.description)
          : null,
        status,
        columnId: column?.id ?? null,
        priority,
        position: 0,
        number: taskNumber,
      })
      .returning();
    if (!child)
      throw new HTTPException(500, { message: "Failed to create subtask" });
    const [relation] = await tx
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId: parent.id,
        targetTaskId: child.id,
        relationType: "subtask",
        position: 0,
      })
      .returning();
    if (!relation)
      throw new HTTPException(500, { message: "Failed to link subtask" });
    const [updatedParent] = await tx
      .update(schema.taskTable)
      .set({ contentRevision: lockedParent.contentRevision + 1 })
      .where(eq(schema.taskTable.id, parent.id))
      .returning();
    if (!updatedParent) throw notFound();
    return {
      subtask: {
        id: child.id,
        title: child.title,
        status: child.status,
        contentRevision: child.contentRevision,
      },
      relationId: relation.id,
      parentContentRevision: updatedParent.contentRevision,
    };
  });
  await publishEvent("task.created", {
    taskId: result.subtask.id,
    projectId: scope.projectId,
    userId: ctx.userId,
  });
  await publishEvent("task-relation.created", {
    id: result.relationId,
    taskId: parent.id,
    sourceTaskId: parent.id,
    targetTaskId: result.subtask.id,
    projectId: scope.projectId,
    userId: ctx.userId,
  });
  return result;
}

export async function bindingCardUpdateSubtask(
  ctx: BindingContext,
  subtaskId: string,
  body: {
    patch: {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      startDate?: string | null;
      dueDate?: string | null;
      workMarkerCounts?: unknown;
    };
    expectedContentRevision: number;
  },
) {
  const { binding, scope } = await loadScopedBinding(ctx);
  const task = assertInScope(scope, subtaskId);
  if (task.id === scope.rootTaskId) {
    throw new HTTPException(400, {
      message: "use the root card update for the bound card itself",
    });
  }
  await assertDescriptionAllowed(scope, body.patch.description !== undefined);

  const updates: Partial<typeof schema.taskTable.$inferInsert> = {};
  if (body.patch.title !== undefined) updates.title = body.patch.title;
  if (body.patch.description !== undefined) {
    updates.description = stripCapabilityAssetTokens(body.patch.description);
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
        message: "Bindings cannot set planned or archived status",
      });
    }
    updates.status = body.patch.status;
  }
  if (body.patch.startDate !== undefined) {
    updates.startDate = body.patch.startDate
      ? parseTaskDateInput("startDate", body.patch.startDate)
      : null;
  }
  if (body.patch.dueDate !== undefined) {
    updates.dueDate = body.patch.dueDate
      ? parseTaskDateInput("dueDate", body.patch.dueDate)
      : null;
  }
  if (body.patch.workMarkerCounts !== undefined) {
    // Same normalized field-only map the root work-markers route accepts;
    // CAS below still guards against stale overwrites.
    updates.workMarkerCounts = normalizeWorkMarkerCounts(
      body.patch.workMarkerCounts,
    );
  }
  if (Object.keys(updates).length === 0) {
    throw new HTTPException(400, {
      message: "No valid subtask fields to update",
    });
  }

  const result = await db.transaction(async (tx) => {
    if (updates.status !== undefined) {
      await lockProjectTaskLanes(tx, [scope.projectId]);
    }
    await lockBindingScope(tx, ctx, binding, task.id);
    const [locked] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id))
      .for("update")
      .limit(1);
    if (!locked) throw notFound();
    await assertTaskContentRevision(tx, task.id, body.expectedContentRevision);
    if (updates.status !== undefined) {
      const [column] = await tx
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
      updates.columnId = column?.id ?? null;
    }
    const [row] = await tx
      .update(schema.taskTable)
      .set({ ...updates, contentRevision: locked.contentRevision + 1 })
      .where(eq(schema.taskTable.id, task.id))
      .returning();
    if (!row) throw notFound();
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      contentRevision: row.contentRevision,
    };
  });
  await publishEvent("task.updated", {
    taskId: task.id,
    projectId: scope.projectId,
    userId: ctx.userId,
  });
  return result;
}

async function collectDescendantIds(
  tx: ShareTransaction,
  scope: BindingScope,
  rootTaskId: string,
) {
  const allowed = new Set(scope.tasks.map((task) => task.id));
  const result = new Set<string>([rootTaskId]);
  let frontier = [rootTaskId];
  while (frontier.length > 0) {
    const edges = await tx
      .select({ targetTaskId: schema.taskRelationTable.targetTaskId })
      .from(schema.taskRelationTable)
      .where(
        and(
          inArray(schema.taskRelationTable.sourceTaskId, frontier),
          eq(schema.taskRelationTable.relationType, "subtask"),
        ),
      );
    const next: string[] = [];
    for (const edge of edges) {
      if (!allowed.has(edge.targetTaskId)) throw notFound();
      if (result.has(edge.targetTaskId)) throw notFound();
      result.add(edge.targetTaskId);
      next.push(edge.targetTaskId);
    }
    frontier = next;
  }
  return [...result];
}

export async function bindingCardDeleteSubtask(
  ctx: BindingContext,
  subtaskId: string,
  body: { expectedParentContentRevision: number },
) {
  const { binding, scope } = await loadScopedBinding(ctx);
  const task = assertInScope(scope, subtaskId);
  if (task.id === scope.rootTaskId) {
    throw new HTTPException(400, {
      message: "the bound root card cannot be deleted through the binding",
    });
  }
  // Descendant-only: resolve the immediate parent inside the current bound
  // tree, then CAS that parent before deleting the selected descendant and
  // its own descendants atomically (no orphaned subtask rows).
  const result = await db.transaction(async (tx) => {
    const freshScope = await lockBindingScope(tx, ctx, binding, task.id);
    const { parent } = await loadParentRelation(tx, freshScope, task.id);
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
    const descendantIds = await collectDescendantIds(tx, freshScope, task.id);
    const deletedRelations = await tx
      .select({
        id: schema.taskRelationTable.id,
        sourceTaskId: schema.taskRelationTable.sourceTaskId,
        targetTaskId: schema.taskRelationTable.targetTaskId,
        relationType: schema.taskRelationTable.relationType,
      })
      .from(schema.taskRelationTable)
      .where(
        or(
          inArray(schema.taskRelationTable.sourceTaskId, descendantIds),
          inArray(schema.taskRelationTable.targetTaskId, descendantIds),
        ),
      );
    await tx
      .delete(schema.taskTable)
      .where(inArray(schema.taskTable.id, descendantIds));
    const [updatedParent] = await tx
      .update(schema.taskTable)
      .set({ contentRevision: lockedParent.contentRevision + 1 })
      .where(eq(schema.taskTable.id, parent.id))
      .returning();
    if (!updatedParent) throw notFound();
    return {
      deletedSubtaskId: task.id,
      deletedDescendantCount: descendantIds.length,
      deletedTaskIds: descendantIds,
      deletedRelations,
      parentTaskId: parent.id,
      parentContentRevision: updatedParent.contentRevision,
    };
  });
  for (const taskId of result.deletedTaskIds) {
    await publishEvent("task.deleted", {
      taskId,
      projectId: scope.projectId,
      userId: ctx.userId,
    });
  }
  for (const relation of result.deletedRelations) {
    await publishEvent("task-relation.deleted", {
      id: relation.id,
      taskId: relation.sourceTaskId,
      sourceTaskId: relation.sourceTaskId,
      targetTaskId: relation.targetTaskId,
      relationType: relation.relationType,
      projectId: scope.projectId,
      userId: ctx.userId,
    });
  }
  return {
    deletedSubtaskId: result.deletedSubtaskId,
    deletedDescendantCount: result.deletedDescendantCount,
    parentTaskId: result.parentTaskId,
    parentContentRevision: result.parentContentRevision,
  };
}

const COMMENTS_DEFAULT_LIMIT = 10;
const COMMENTS_MAX_LIMIT = 50;
const MIN_PG_BIGINT = -(1n << 63n);
const MAX_PG_BIGINT = (1n << 63n) - 1n;

function parseCommentCursor(cursor?: string) {
  if (!cursor || cursor.length > 256) return null;
  const separator = cursor.indexOf("|");
  const rawTimestamp = separator >= 0 ? cursor.slice(0, separator) : cursor;
  const id = separator >= 0 ? cursor.slice(separator + 1) : "";
  if (/^-?\d{1,20}$/.test(rawTimestamp)) {
    const timestampMicros = BigInt(rawTimestamp);
    if (
      timestampMicros < MIN_PG_BIGINT ||
      timestampMicros > MAX_PG_BIGINT
    ) {
      return null;
    }
    return { timestampMicros: timestampMicros.toString(), id };
  }

  // Accept the previous ISO-millisecond cursor format during rolling upgrades.
  const timestampMs = Date.parse(rawTimestamp);
  if (Number.isNaN(timestampMs)) return null;
  return { timestampMicros: (BigInt(timestampMs) * 1000n).toString(), id };
}

async function listCommentsForTask(
  taskId: string,
  rawLimit?: number,
  cursor?: string,
  executor: ShareTransaction | typeof db = db,
) {
  const limit = Math.min(
    Math.max(Math.floor(rawLimit ?? COMMENTS_DEFAULT_LIMIT), 1),
    COMMENTS_MAX_LIMIT,
  );
  const conditions = [
    eq(schema.activityTable.taskId, taskId),
    eq(schema.activityTable.type, "comment"),
  ];
  const parsedCursor = parseCommentCursor(cursor);
  if (parsedCursor) {
    const createdAtMicros = sql`floor(extract(epoch from ${schema.activityTable.createdAt}) * 1000000)::bigint`;
    const cursorMicros = sql`${parsedCursor.timestampMicros}::bigint`;
    const cursorCondition = parsedCursor.id
      ? or(
          lt(createdAtMicros, cursorMicros),
          and(
            eq(createdAtMicros, cursorMicros),
            lt(schema.activityTable.id, parsedCursor.id),
          ),
        )
      : lt(createdAtMicros, cursorMicros);
    if (cursorCondition) conditions.push(cursorCondition);
  }
  const rows = await executor
    .select({
      id: schema.activityTable.id,
      content: schema.activityTable.content,
      createdAt: schema.activityTable.createdAt,
      cursorCreatedAtMicros: sql<string>`floor(extract(epoch from ${schema.activityTable.createdAt}) * 1000000)::bigint`,
      authorName: schema.userTable.name,
      externalUserName: schema.activityTable.externalUserName,
    })
    .from(schema.activityTable)
    .leftJoin(
      schema.userTable,
      eq(schema.activityTable.userId, schema.userTable.id),
    )
    .where(and(...conditions))
    .orderBy(
      desc(schema.activityTable.createdAt),
      desc(schema.activityTable.id),
    )
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      content: row.content ?? "",
      createdAt: row.createdAt,
      authorName: row.authorName ?? row.externalUserName ?? "Unknown",
    })),
    nextCursor:
      hasMore && last
        ? `${last.cursorCreatedAtMicros}|${last.id}`
        : null,
  };
}

export async function bindingCardListComments(
  ctx: BindingContext,
  rawLimit?: number,
  cursor?: string,
) {
  const { scope } = await loadScopedBinding(ctx);
  assertInScope(scope, scope.rootTaskId);
  return listCommentsForTask(scope.rootTaskId, rawLimit, cursor);
}

export async function bindingCardListSubtaskComments(
  ctx: BindingContext,
  subtaskId: string,
  rawLimit?: number,
  cursor?: string,
) {
  const { binding, scope } = await loadScopedBinding(ctx);
  const task = assertSubtaskInScope(scope, subtaskId);
  return db.transaction(async (tx) => {
    const freshScope = await lockBindingScope(tx, ctx, binding, task.id);
    const freshTask = assertSubtaskInScope(freshScope, task.id);
    return listCommentsForTask(freshTask.id, rawLimit, cursor, tx);
  });
}

export async function bindingCardCreateSubtaskComment(
  ctx: BindingContext,
  subtaskId: string,
  content: string,
) {
  const { binding, scope } = await loadScopedBinding(ctx);
  const task = assertSubtaskInScope(scope, subtaskId);
  const comment = await db.transaction(async (tx) => {
    const freshScope = await lockBindingScope(tx, ctx, binding, task.id);
    const scopedTask = assertSubtaskInScope(freshScope, task.id);
    const [row] = await tx
      .insert(schema.activityTable)
      .values({
        taskId: scopedTask.id,
        type: "comment",
        userId: null,
        content,
        externalUserName: `Bound session ${binding.sessionId.slice(0, 8)}`,
        externalSource: "agent-binding",
      })
      .returning();
    if (!row) {
      throw new HTTPException(500, { message: "Failed to create comment" });
    }
    return {
      id: row.id,
      content: row.content ?? "",
      createdAt: row.createdAt,
    };
  });
  await publishEvent("comment.created", {
    taskId: task.id,
    projectId: scope.projectId,
    userId: ctx.userId,
    id: comment.id,
  });
  return comment;
}

export async function bindingCardCreateComment(
  ctx: BindingContext,
  content: string,
) {
  const { binding, scope } = await loadScopedBinding(ctx);
  assertInScope(scope, scope.rootTaskId);
  const comment = await db.transaction(async (tx) => {
    await lockBindingScope(tx, ctx, binding, scope.rootTaskId);
    const [comment] = await tx
      .insert(schema.activityTable)
      .values({
        taskId: scope.rootTaskId,
        type: "comment",
        userId: null,
        content,
        externalUserName: `Bound session ${binding.sessionId.slice(0, 8)}`,
        externalSource: "agent-binding",
      })
      .returning();
    if (!comment) {
      throw new HTTPException(500, { message: "Failed to create comment" });
    }
    return {
      id: comment.id,
      content: comment.content ?? "",
      createdAt: comment.createdAt,
    };
  });
  await publishEvent("comment.created", {
    taskId: scope.rootTaskId,
    projectId: scope.projectId,
    userId: ctx.userId,
    id: comment.id,
  });
  return comment;
}

export async function bindingCardUpdateWorkMarkers(
  ctx: BindingContext,
  body: { workMarkerCounts: unknown; expectedContentRevision: number },
) {
  const { binding, scope } = await loadScopedBinding(ctx);
  const task = assertInScope(scope, scope.rootTaskId);
  const result = await db.transaction(async (tx) => {
    await lockBindingScope(tx, ctx, binding, task.id);
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
        contentRevision: locked.contentRevision + 1,
      })
      .where(eq(schema.taskTable.id, task.id))
      .returning();
    if (!row) throw notFound();
    return {
      workMarkerCounts: normalizeWorkMarkerCounts(row.workMarkerCounts),
      contentRevision: row.contentRevision,
    };
  });
  await publishEvent("task.updated", {
    taskId: task.id,
    projectId: scope.projectId,
    userId: ctx.userId,
  });
  return result;
}

// Formal-run claim fence: an ad-hoc binding loses the card to the run.
// Called inside the claim transaction while the run rows are locked.
// A binding rooted at any ANCESTOR of the claimed task also controls this
// card (the same-project subtree), so ancestor bindings are fenced too —
// otherwise a claim on a child would leave a zombie binding that blocks
// later rebinds via the overlap guard while binding-status still says
// bound/online.
const MAX_BINDING_ANCESTOR_DEPTH = 32;

async function taskAncestorChain(
  tx: ShareTransaction,
  taskId: string,
  projectId: string,
): Promise<string[]> {
  const chain: string[] = [];
  let current = taskId;
  for (let depth = 0; depth < MAX_BINDING_ANCESTOR_DEPTH; depth += 1) {
    const [parentEdge] = await tx
      .select({ sourceTaskId: schema.taskRelationTable.sourceTaskId })
      .from(schema.taskRelationTable)
      .where(
        and(
          eq(schema.taskRelationTable.targetTaskId, current),
          eq(schema.taskRelationTable.relationType, "subtask"),
        ),
      )
      .orderBy(asc(schema.taskRelationTable.position))
      .limit(1);
    if (!parentEdge) break;
    if (chain.includes(parentEdge.sourceTaskId)) break;
    const [parent] = await tx
      .select({ projectId: schema.taskTable.projectId })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, parentEdge.sourceTaskId))
      .limit(1);
    if (!parent || parent.projectId !== projectId) break;
    chain.push(parentEdge.sourceTaskId);
    current = parentEdge.sourceTaskId;
  }
  return chain;
}

export async function fenceBindingForRunClaim(
  tx: ShareTransaction,
  taskId: string,
) {
  const [claimedTask] = await tx
    .select({ projectId: schema.taskTable.projectId })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, taskId))
    .limit(1);
  if (!claimedTask) return;

  const bindingTaskIds = [
    taskId,
    ...(await taskAncestorChain(tx, taskId, claimedTask.projectId)),
  ];
  const bindings = await tx
    .select()
    .from(schema.agentSessionBindingTable)
    .where(
      and(
        inArray(schema.agentSessionBindingTable.taskId, bindingTaskIds),
        eq(schema.agentSessionBindingTable.status, "active"),
        eq(schema.agentSessionBindingTable.projectId, claimedTask.projectId),
      ),
    )
    .for("update");
  if (bindings.length === 0) return;

  // Check every candidate binding for an in-flight delivery BEFORE staling
  // anything, so a 409 never leaves a half-fenced set.
  for (const binding of bindings) {
    // A claimed delivery inside its 60s lease blocks the claim: the Pi side
    // may be mid-send and must ack or time out first.
    const [inFlight] = await tx
      .select({ id: schema.agentSessionDeliveryTable.id })
      .from(schema.agentSessionDeliveryTable)
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.bindingId, binding.id),
          eq(schema.agentSessionDeliveryTable.state, "claimed"),
          gt(
            schema.agentSessionDeliveryTable.claimedLeaseExpiresAt,
            new Date(),
          ),
        ),
      )
      .limit(1);
    if (inFlight) {
      throw new HTTPException(409, {
        message: "ad-hoc-delivery-in-flight",
      });
    }
  }

  // Queue/claimed deliveries beyond the lease die with the binding.
  await tx
    .update(schema.agentSessionDeliveryTable)
    .set({ state: "stale", updatedAt: new Date() })
    .where(
      and(
        inArray(
          schema.agentSessionDeliveryTable.bindingId,
          bindings.map((binding) => binding.id),
        ),
        eq(schema.agentSessionDeliveryTable.state, "queued"),
      ),
    );
  await tx
    .update(schema.agentSessionDeliveryTable)
    .set({ state: "unknown", updatedAt: new Date() })
    .where(
      and(
        inArray(
          schema.agentSessionDeliveryTable.bindingId,
          bindings.map((binding) => binding.id),
        ),
        eq(schema.agentSessionDeliveryTable.state, "claimed"),
        or(
          isNull(schema.agentSessionDeliveryTable.claimedLeaseExpiresAt),
          lte(
            schema.agentSessionDeliveryTable.claimedLeaseExpiresAt,
            new Date(),
          ),
        ),
      ),
    );
  for (const binding of bindings) {
    await tx
      .update(schema.agentSessionBindingTable)
      .set({
        status: "revoked",
        revokedAt: new Date(),
        revokedReason: "formal_run_claim",
        bindingGeneration: binding.bindingGeneration + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentSessionBindingTable.id, binding.id));
  }
}

// --- assets ----------------------------------------------------------------

const BINDING_MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
const BINDING_MAX_FILES_PER_RESOURCE = 20;

async function resolveUploadOwner(
  ownerType: "task_description" | "task_comment",
  ownerId: string,
) {
  if (ownerType === "task_comment") {
    // UAT bug iss_20261116113109: a comment-scoped upload carries the comment
    // (activity) id, not the task id. Resolve the owning task from the comment
    // first; fall back to the raw task id for the established task-level form.
    const [comment] = await db
      .select({
        commentId: schema.activityTable.id,
        taskId: schema.activityTable.taskId,
        projectId: schema.taskTable.projectId,
        workspaceId: schema.projectTable.workspaceId,
      })
      .from(schema.activityTable)
      .innerJoin(
        schema.taskTable,
        eq(schema.activityTable.taskId, schema.taskTable.id),
      )
      .innerJoin(
        schema.projectTable,
        eq(schema.taskTable.projectId, schema.projectTable.id),
      )
      .where(
        and(
          eq(schema.activityTable.id, ownerId),
          eq(schema.activityTable.type, "comment"),
        ),
      )
      .limit(1);
    if (comment) {
      return {
        workspaceId: comment.workspaceId,
        projectId: comment.projectId,
        taskId: comment.taskId,
        ownerType,
        ownerId: comment.commentId,
        surface: "comment",
      };
    }
  }
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
  if (!task) {
    throw new HTTPException(404, {
      message:
        ownerType === "task_comment"
          ? "No comment or task matches the provided ownerId."
          : "Task not found for the provided ownerId.",
    });
  }
  return {
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    taskId: task.id,
    ownerType,
    ownerId,
    surface: ownerType === "task_comment" ? "comment" : "description",
  };
}

export async function bindingCardCreateUploadTicket(
  ctx: BindingContext,
  input: {
    ownerType: "task_description" | "task_comment";
    ownerId: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  const { scope } = await loadScopedBinding(ctx);
  const owner = await resolveUploadOwner(input.ownerType, input.ownerId);
  assertInScope(scope, owner.taskId);
  const [manifest] = await db
    .select({ id: schema.executionManifestTable.id })
    .from(schema.executionManifestTable)
    .where(eq(schema.executionManifestTable.projectId, scope.projectId))
    .limit(1);
  if (manifest && input.ownerType === "task_description") {
    throw new HTTPException(403, {
      message: "Descriptions are read-only in manifest projects.",
    });
  }
  try {
    validateFullLinkUploadInput(input.contentType, input.size);
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : "Invalid upload",
    });
  }
  if (input.size > BINDING_MAX_BYTES_PER_FILE) {
    throw new HTTPException(400, {
      message: "Upload exceeds the 10MB per-file binding limit.",
    });
  }
  const [row] = await db
    .select({ fileCount: count() })
    .from(schema.assetTable)
    .where(
      and(
        eq(schema.assetTable.taskId, owner.taskId),
        inArray(schema.assetTable.surface, ["description", "comment"]),
      ),
    );
  if (Number(row?.fileCount ?? 0) >= BINDING_MAX_FILES_PER_RESOURCE) {
    throw new HTTPException(400, {
      message: "This resource already has the maximum number of files.",
    });
  }
  return createContentAssetUploadUrl({
    workspaceId: owner.workspaceId,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    filename: input.filename,
    contentType: input.contentType,
  });
}

export async function bindingCardFinalizeUpload(
  ctx: BindingContext,
  input: {
    ownerType: "task_description" | "task_comment";
    ownerId: string;
    key: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  const { binding, scope } = await loadScopedBinding(ctx);
  const owner = await resolveUploadOwner(input.ownerType, input.ownerId);
  assertInScope(scope, owner.taskId);
  const [manifest] = await db
    .select({ id: schema.executionManifestTable.id })
    .from(schema.executionManifestTable)
    .where(eq(schema.executionManifestTable.projectId, scope.projectId))
    .limit(1);
  if (manifest && input.ownerType === "task_description") {
    throw new HTTPException(403, {
      message: "Descriptions are read-only in manifest projects.",
    });
  }

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
  if (input.size > BINDING_MAX_BYTES_PER_FILE) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "Upload exceeds the 10MB per-file binding limit.",
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
  if (actualType.startsWith("image/")) {
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

  let asset: { id: string };
  try {
    asset = await db.transaction(async (tx) => {
      const freshScope = await lockBindingScope(
        tx,
        ctx,
        binding,
        owner.taskId,
      );
      if (
        !freshScope.tasks.some((candidate) => candidate.id === owner.taskId)
      ) {
        throw notFound();
      }
      if (
        freshScope.manifestProject &&
        input.ownerType === "task_description"
      ) {
        throw new HTTPException(403, {
          message: "Descriptions are read-only in manifest projects.",
        });
      }
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
      const [usage] = await tx
        .select({ fileCount: count() })
        .from(schema.assetTable)
        .where(
          and(
            eq(schema.assetTable.taskId, owner.taskId),
            inArray(schema.assetTable.surface, ["description", "comment"]),
          ),
        );
      if (Number(usage?.fileCount ?? 0) >= BINDING_MAX_FILES_PER_RESOURCE) {
        throw new HTTPException(400, {
          message: "This resource already has the maximum number of files.",
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
          createdBy: null,
          objectKey: normalizedKey,
        })
        .returning({ id: schema.assetTable.id });
      if (!row) {
        throw new HTTPException(500, { message: "Failed to persist asset" });
      }
      return row;
    });
  } catch (error) {
    // Do not delete a key that another finalizer already committed. Other
    // conflicts (notably stale_binding after a revoke/rebind) own only a
    // staged object and must clean it up.
    const committedDuplicate =
      error instanceof HTTPException &&
      error.status === 409 &&
      error.message.includes("already been finalized");
    if (!committedDuplicate) {
      await deleteS3Object(normalizedKey).catch(() => {});
    }
    throw error;
  }
  await publishEvent("asset.created", {
    taskId: owner.taskId,
    projectId: owner.projectId,
    userId: ctx.userId,
    assetId: asset.id,
  });
  return {
    id: asset.id,
    filename: input.filename,
    mimeType: actualType,
    size: actualLength,
  };
}

// Asset reads re-check the asset's task is STILL in the current subtree.
export async function canBindingReadAsset(
  scope: BindingScope,
  asset: { taskId: string | null; surface: string },
) {
  if (!asset.taskId) return false;
  if (!["description", "comment"].includes(asset.surface)) return false;
  return scope.tasks.some((candidate) => candidate.id === asset.taskId);
}
