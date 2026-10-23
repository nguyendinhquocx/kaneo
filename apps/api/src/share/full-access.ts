import { and, asc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";

// SPEC-2026-10-22 full-project-share-link: server-side boundary helpers for
// `full` capability links. Every helper fails closed — if a relation to the
// linked project or to agent-control data cannot be disproved, the caller is
// denied. Guests are a separate principal: no synthetic userId, no workspace
// membership, no execution surface.

const guestDenied = () =>
  new HTTPException(403, {
    message:
      "This object is managed by agent-control and cannot be changed through a share link.",
  });

const notFound = () => new HTTPException(404, { message: "Not found" });

export type FullLinkProject = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
};

// The link's resourceId must still resolve to a live project; a dangling
// capability (e.g. revoked workspace) denies everything.
export async function getFullLinkProject(
  resourceId: string,
): Promise<FullLinkProject> {
  const [project] = await db
    .select({
      id: schema.projectTable.id,
      workspaceId: schema.projectTable.workspaceId,
      name: schema.projectTable.name,
      slug: schema.projectTable.slug,
    })
    .from(schema.projectTable)
    .where(eq(schema.projectTable.id, resourceId))
    .limit(1);
  if (!project) {
    throw notFound();
  }
  return project;
}

// Deterministic project-level boundary, shared with the public DTO reader:
// any execution manifest in the project, or any task run / execution
// schedule on a project task, marks descriptions unreadable project-wide
// because free text may embed an execution envelope (validation.ts scans
// anywhere in the text — no safe content heuristic exists).
export async function isProjectAgentControlledStrict(
  projectId: string,
): Promise<boolean> {
  const [manifest] = await db
    .select({ id: schema.executionManifestTable.id })
    .from(schema.executionManifestTable)
    .where(eq(schema.executionManifestTable.projectId, projectId))
    .limit(1);
  if (manifest) {
    return true;
  }
  const [run] = await db
    .select({ id: schema.taskRunTable.id })
    .from(schema.taskRunTable)
    .innerJoin(schema.taskTable, eq(schema.taskRunTable.taskId, schema.taskTable.id))
    .where(eq(schema.taskTable.projectId, projectId))
    .limit(1);
  if (run) {
    return true;
  }
  const [schedule] = await db
    .select({ id: schema.executionScheduleTable.id })
    .from(schema.executionScheduleTable)
    .innerJoin(
      schema.taskTable,
      eq(schema.executionScheduleTable.taskId, schema.taskTable.id),
    )
    .where(eq(schema.taskTable.projectId, projectId))
    .limit(1);
  return Boolean(schedule);
}

// Task-level predicate: a task is guest-denied when it participates in any
// execution workflow — a run, a schedule, a phase-card full task, or a
// phase-card child. Uncertain means denied (spec §B).
export async function isTaskAgentControlled(taskId: string): Promise<boolean> {
  const [run] = await db
    .select({ id: schema.taskRunTable.id })
    .from(schema.taskRunTable)
    .where(eq(schema.taskRunTable.taskId, taskId))
    .limit(1);
  if (run) {
    return true;
  }
  const [schedule] = await db
    .select({ id: schema.executionScheduleTable.id })
    .from(schema.executionScheduleTable)
    .where(eq(schema.executionScheduleTable.taskId, taskId))
    .limit(1);
  if (schedule) {
    return true;
  }
  const [phaseCard] = await db
    .select({ id: schema.executionPhaseCardTable.id })
    .from(schema.executionPhaseCardTable)
    .where(
      or(
        eq(schema.executionPhaseCardTable.fullTaskId, taskId),
        eq(schema.executionPhaseCardTable.childTaskId, taskId),
      ),
    )
    .limit(1);
  return Boolean(phaseCard);
}

// Load a task that must live inside the linked project. Both the task lookup
// and any later mutation are project-scoped through the same predicate.
export async function loadProjectTask(taskId: string, projectId: string) {
  const [task] = await db
    .select()
    .from(schema.taskTable)
    .where(
      and(eq(schema.taskTable.id, taskId), eq(schema.taskTable.projectId, projectId)),
    )
    .limit(1);
  if (!task) {
    throw notFound();
  }
  return task;
}

// Combined gate for task reads/writes under a full link: proves the task
// belongs to the linked project AND is free of agent-control relations.
export async function loadGuestMutableTask(taskId: string, projectId: string) {
  const task = await loadProjectTask(taskId, projectId);
  if (await isTaskAgentControlled(task.id)) {
    throw guestDenied();
  }
  return task;
}

// Whether descriptions of `taskId` may be read/written under a full link.
// Project manifest ⇒ hidden project-wide; otherwise only agent-linked tasks
// lose their description.
export async function assertGuestDescriptionAllowed(
  taskId: string,
  projectId: string,
  mode: "read" | "write",
) {
  if (await isProjectAgentControlledStrict(projectId)) {
    throw guestDenied();
  }
  if (await isTaskAgentControlled(taskId)) {
    throw guestDenied();
  }
  if (mode === "read") {
    return;
  }
  // Writing a description is additionally blocked when the task itself is
  // execution-managed (already covered above) — nothing else to prove.
}

// Bulk variant for list payloads: returns the set of task IDs whose
// descriptions must be redacted for a full-link reader.
export async function getRedactedTaskIds(
  projectId: string,
  taskIds: string[],
): Promise<Set<string>> {
  const redacted = new Set<string>();
  if (taskIds.length === 0) {
    return redacted;
  }
  if (await isProjectAgentControlledStrict(projectId)) {
    for (const id of taskIds) redacted.add(id);
    return redacted;
  }

  const [runs, schedules, phaseCards] = await Promise.all([
    db
      .select({ taskId: schema.taskRunTable.taskId })
      .from(schema.taskRunTable)
      .where(inArray(schema.taskRunTable.taskId, taskIds)),
    db
      .select({ taskId: schema.executionScheduleTable.taskId })
      .from(schema.executionScheduleTable)
      .where(inArray(schema.executionScheduleTable.taskId, taskIds)),
    db
      .select({
        fullTaskId: schema.executionPhaseCardTable.fullTaskId,
        childTaskId: schema.executionPhaseCardTable.childTaskId,
      })
      .from(schema.executionPhaseCardTable)
      .where(
        or(
          inArray(schema.executionPhaseCardTable.fullTaskId, taskIds),
          inArray(schema.executionPhaseCardTable.childTaskId, taskIds),
        ),
      ),
  ]);
  for (const row of runs) redacted.add(row.taskId);
  for (const row of schedules) redacted.add(row.taskId);
  for (const row of phaseCards) {
    if (row.fullTaskId) redacted.add(row.fullTaskId);
    if (row.childTaskId) redacted.add(row.childTaskId);
  }
  return redacted;
}

// Owner-approved member directory: active assignable members of the link's
// workspace, exposed ONLY as { id, name, avatarUrl }. Never email, role,
// invite state, or data about other workspaces/projects. Viewers are not
// assignable.
export async function listAssignableMembers(workspaceId: string) {
  const members = await db
    .select({
      id: schema.userTable.id,
      name: schema.userTable.name,
      avatarUrl: schema.userTable.image,
    })
    .from(schema.workspaceUserTable)
    .innerJoin(schema.userTable, eq(schema.workspaceUserTable.userId, schema.userTable.id))
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        ne(schema.workspaceUserTable.role, "viewer"),
      ),
    )
    .orderBy(schema.userTable.name);
  return members;
}

// Full-link project payload: same shape as the public DTO plus the fields
// approved for holders — assignee identity limited to the member-directory
// id (resolved client-side through the members endpoint), labels, and
// descriptions governed by the agent-control boundary. Edit/view links never
// see assignee ids; this payload is only built for `full` links.
export async function buildFullProjectPayload(resourceId: string) {
  const project = await db.query.projectTable.findFirst({
    where: eq(schema.projectTable.id, resourceId),
  });
  if (!project) {
    throw notFound();
  }

  const tasks = await db
    .select({
      id: schema.taskTable.id,
      projectId: schema.taskTable.projectId,
      number: schema.taskTable.number,
      title: schema.taskTable.title,
      description: schema.taskTable.description,
      status: schema.taskTable.status,
      priority: schema.taskTable.priority,
      startDate: schema.taskTable.startDate,
      dueDate: schema.taskTable.dueDate,
      position: schema.taskTable.position,
      createdAt: schema.taskTable.createdAt,
      assigneeId: schema.taskTable.userId,
    })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.projectId, resourceId))
    .orderBy(asc(schema.taskTable.position));

  const redactedDescriptions = await getRedactedTaskIds(
    resourceId,
    tasks.map((task) => task.id),
  );

  const taskIds = tasks.map((task) => task.id);
  const labels =
    taskIds.length > 0
      ? await db
          .select({
            id: schema.labelTable.id,
            name: schema.labelTable.name,
            color: schema.labelTable.color,
            taskId: schema.labelTable.taskId,
          })
          .from(schema.labelTable)
          .where(inArray(schema.labelTable.taskId, taskIds))
      : [];

  const labelsByTask = new Map<
    string,
    Array<{ id: string; name: string; color: string | null }>
  >();
  for (const label of labels) {
    if (!label.taskId) continue;
    const list = labelsByTask.get(label.taskId) ?? [];
    list.push({ id: label.id, name: label.name, color: label.color });
    labelsByTask.set(label.taskId, list);
  }

  const toFullTask = (task: (typeof tasks)[number]) => ({
    id: task.id,
    projectId: task.projectId,
    number: task.number,
    title: task.title,
    description: redactedDescriptions.has(task.id) ? null : task.description,
    descriptionLocked: redactedDescriptions.has(task.id),
    status: task.status,
    priority: task.priority,
    startDate: task.startDate,
    dueDate: task.dueDate,
    position: task.position,
    createdAt: task.createdAt,
    assigneeId: task.assigneeId,
    labels: labelsByTask.get(task.id) ?? [],
  });

  const projectColumns = await db
    .select()
    .from(schema.columnTable)
    .where(eq(schema.columnTable.projectId, resourceId))
    .orderBy(asc(schema.columnTable.position));

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    icon: project.icon,
    description: project.description,
    scope: "full" as const,
    columns: projectColumns.map((column) => ({
      id: column.id,
      slug: column.slug,
      name: column.name,
      icon: column.icon,
      isFinal: column.isFinal,
      tasks: tasks
        .filter((task) => task.status === column.slug)
        .map(toFullTask),
    })),
    archivedTasks: tasks
      .filter((task) => task.status === "archived")
      .map(toFullTask),
    plannedTasks: tasks
      .filter((task) => task.status === "planned")
      .map(toFullTask),
  };
}

// Assignee validation for guest writes: same minimal membership rule as
// assertTaskAssigneeInWorkspace, but additionally excludes viewers so a
// guest cannot assign a read-only member.
export async function assertGuestAssigneeAllowed(
  assigneeId: string,
  workspaceId: string,
) {
  const members = await db
    .select({ id: schema.workspaceUserTable.id })
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.userId, assigneeId),
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        ne(schema.workspaceUserTable.role, "viewer"),
      ),
    )
    .limit(1);
  if (!members[0]) {
    throw new HTTPException(400, {
      message: "Assignee must be an active member of the workspace",
    });
  }
}

// Per-link and per-resource upload accounting (owner-approved caps:
// ≤10 MiB/file enforced at validation, ≤100 MiB per link total, ≤20 files
// per resource). Per-link quota is counted from audit rows written in the
// same transaction as each asset insert, so failed/rolled-back uploads do
// not consume quota.
export async function getFullLinkUploadUsage(options: {
  shareLinkId: string;
}): Promise<{ totalSize: number; fileCount: number }> {
  const auditRows = await db
    .select({ resourceId: schema.shareActionAuditTable.resourceId })
    .from(schema.shareActionAuditTable)
    .where(
      and(
        eq(schema.shareActionAuditTable.shareLinkId, options.shareLinkId),
        eq(schema.shareActionAuditTable.action, "asset.finalize"),
      ),
    );
  const assetIds = auditRows.map((row) => row.resourceId);
  if (assetIds.length === 0) {
    return { totalSize: 0, fileCount: 0 };
  }
  const [usage] = await db
    .select({
      totalSize: sql<number>`coalesce(sum(${schema.assetTable.size}), 0)`,
      fileCount: sql<number>`count(*)`,
    })
    .from(schema.assetTable)
    .where(inArray(schema.assetTable.id, assetIds));
  return {
    totalSize: Number(usage?.totalSize ?? 0),
    fileCount: Number(usage?.fileCount ?? 0),
  };
}

// Per-resource file count (a task's description+comments, or a document with
// its comments, each form one resource). Deleted rows free their slots.
export async function countResourceAssets(
  where: SQL | undefined,
): Promise<number> {
  const [row] = await db
    .select({ fileCount: sql<number>`count(*)` })
    .from(schema.assetTable)
    .where(where);
  return Number(row?.fileCount ?? 0);
}
