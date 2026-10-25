import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";

// SPEC-2026-10-22 full-project-share-link: server-side boundary helpers for
// `full` capability links. Every helper fails closed — if a relation to the
// linked project or to agent-control data cannot be disproved, the caller is
// denied. Guests are a separate principal: no synthetic userId, no workspace
// membership, no execution surface.

const notFound = () => new HTTPException(404, { message: "Not found" });
const ASSIGNABLE_WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
type ShareTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ShareQueryExecutor = typeof db | ShareTransaction;

export type FullLinkProject = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
};

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
  if (!project) throw notFound();
  return project;
}

export async function isProjectAgentControlledStrict(
  projectId: string,
): Promise<boolean> {
  const [manifest] = await db
    .select({ id: schema.executionManifestTable.id })
    .from(schema.executionManifestTable)
    .where(eq(schema.executionManifestTable.projectId, projectId))
    .limit(1);
  return Boolean(manifest);
}

export async function isTaskAgentControlled(taskId: string): Promise<boolean> {
  const [run] = await db
    .select({ id: schema.taskRunTable.id })
    .from(schema.taskRunTable)
    .where(eq(schema.taskRunTable.taskId, taskId))
    .limit(1);
  if (run) return true;
  const [schedule] = await db
    .select({ id: schema.executionScheduleTable.id })
    .from(schema.executionScheduleTable)
    .where(eq(schema.executionScheduleTable.taskId, taskId))
    .limit(1);
  if (schedule) return true;
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

export async function loadProjectTask(taskId: string, projectId: string) {
  const [task] = await db
    .select()
    .from(schema.taskTable)
    .where(
      and(
        eq(schema.taskTable.id, taskId),
        eq(schema.taskTable.projectId, projectId),
      ),
    )
    .limit(1);
  if (!task) throw notFound();
  return task;
}

export async function loadProjectDocument(
  documentId: string,
  projectId: string,
) {
  const [document] = await db
    .select()
    .from(schema.documentTable)
    .where(
      and(
        eq(schema.documentTable.id, documentId),
        eq(schema.documentTable.projectId, projectId),
      ),
    )
    .limit(1);
  if (!document || document.archivedAt !== null) {
    throw notFound();
  }
  return document;
}

// Tasks participating in runs, schedules, or manifest phase cards are omitted
// as whole objects; their title/status and relations are execution data too.
export async function getDeniedTaskIds(
  taskIds: string[],
): Promise<Set<string>> {
  const denied = new Set<string>();
  if (taskIds.length === 0) return denied;
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
  for (const row of runs) denied.add(row.taskId);
  for (const row of schedules) denied.add(row.taskId);
  for (const row of phaseCards) {
    if (row.fullTaskId) denied.add(row.fullTaskId);
    if (row.childTaskId) denied.add(row.childTaskId);
  }
  return denied;
}

// Project manifest ⇒ every description is hidden project-wide. Without a
// manifest, only the task-level execution objects have their description
// redacted (they are omitted by getDeniedTaskIds in the owner payload).
export async function getRedactedTaskIds(
  projectId: string,
  taskIds: string[],
): Promise<Set<string>> {
  const redacted = new Set<string>();
  if (taskIds.length === 0) return redacted;
  if (await isProjectAgentControlledStrict(projectId)) {
    for (const id of taskIds) redacted.add(id);
    return redacted;
  }
  const denied = await getDeniedTaskIds(taskIds);
  for (const id of denied) redacted.add(id);
  return redacted;
}

export async function listAssignableMembers(workspaceId: string) {
  return db
    .select({
      id: schema.userTable.id,
      name: schema.userTable.name,
      avatarUrl: schema.userTable.image,
    })
    .from(schema.workspaceUserTable)
    .innerJoin(
      schema.userTable,
      eq(schema.workspaceUserTable.userId, schema.userTable.id),
    )
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        inArray(schema.workspaceUserTable.role, ASSIGNABLE_WORKSPACE_ROLES),
      ),
    )
    .orderBy(schema.userTable.name);
}

export async function assertGuestAssigneeAllowed(
  assigneeId: string,
  workspaceId: string,
  executor: ShareQueryExecutor = db,
) {
  const members = await executor
    .select({ id: schema.workspaceUserTable.id })
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.userId, assigneeId),
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        inArray(schema.workspaceUserTable.role, ASSIGNABLE_WORKSPACE_ROLES),
      ),
    )
    .limit(1);
  if (!members[0]) {
    throw new HTTPException(400, {
      message: "Assignee must be an active member of the workspace",
    });
  }
}

export async function getFullLinkUploadUsage(options: {
  shareLinkId: string;
  executor?: ShareQueryExecutor;
}): Promise<{ totalSize: number; fileCount: number }> {
  const executor = options.executor ?? db;
  const auditRows = await executor
    .select({ resourceId: schema.shareActionAuditTable.resourceId })
    .from(schema.shareActionAuditTable)
    .where(
      and(
        eq(schema.shareActionAuditTable.shareLinkId, options.shareLinkId),
        eq(schema.shareActionAuditTable.action, "asset.finalize"),
      ),
    );
  const assetIds = auditRows.map((row) => row.resourceId);
  if (assetIds.length === 0) return { totalSize: 0, fileCount: 0 };
  const [usage] = await executor
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

export async function countResourceAssets(
  where: SQL | undefined,
  executor: ShareQueryExecutor = db,
): Promise<number> {
  const [row] = await executor
    .select({ fileCount: sql<number>`count(*)` })
    .from(schema.assetTable)
    .where(where);
  return Number(row?.fileCount ?? 0);
}

export async function buildFullProjectPayload(resourceId: string) {
  const project = await db.query.projectTable.findFirst({
    where: eq(schema.projectTable.id, resourceId),
  });
  if (!project) throw notFound();

  const allTasks = await db
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

  const [deniedIds, redactedDescriptions] = await Promise.all([
    getDeniedTaskIds(allTasks.map((task) => task.id)),
    getRedactedTaskIds(
      resourceId,
      allTasks.map((task) => task.id),
    ),
  ]);
  const tasks = allTasks.filter((task) => !deniedIds.has(task.id));

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
      // The kanban drag layer sends column.id back as task.status, so the
      // id must be the slug exactly like the owner payload (get-tasks.ts):
      // the server validates status against column slugs, not row ids.
      id: column.slug,
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
