import { and, asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";

// SPEC-2026-10-08-kaneo-workspace-collaboration T2: the public payload is a
// minimized DTO. It never includes workspaceId, user/assignee identity,
// avatars, external integration metadata, or agent-control fields. Task
// descriptions are redacted when the project is agent-controlled because an
// execution envelope may live inside them.

export type PublicProjectTask = {
  id: string;
  projectId: string;
  number: number | null;
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  startDate: Date | null;
  dueDate: Date | null;
  position: number | null;
  createdAt: Date;
  labels: Array<{ id: string; name: string; color: string | null }>;
};

export type PublicProjectColumn = {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  isFinal: boolean;
  tasks: PublicProjectTask[];
};

export type PublicProjectPayload = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  description: string | null;
  isPublic: boolean;
  columns: PublicProjectColumn[];
  archivedTasks: PublicProjectTask[];
  plannedTasks: PublicProjectTask[];
};

// A project counts as agent-controlled when it has an execution manifest, or
// any task in it is linked to a task run or an execution schedule. Public
// writes are refused for such projects and descriptions are redacted.
export async function isProjectAgentControlled(
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
    .innerJoin(
      schema.taskTable,
      eq(schema.taskRunTable.taskId, schema.taskTable.id),
    )
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

export async function buildPublicProjectPayload(
  projectId: string,
  options: { requirePublic: boolean },
): Promise<PublicProjectPayload> {
  const project = await db.query.projectTable.findFirst({
    where: eq(schema.projectTable.id, projectId),
  });

  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  if (options.requirePublic && !project.isPublic) {
    throw new HTTPException(403, {
      message: "Project is not public",
    });
  }

  const agentControlled = await isProjectAgentControlled(projectId);

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
    })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.projectId, projectId))
    .orderBy(asc(schema.taskTable.position));

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

  const toPublicTask = (task: (typeof tasks)[number]): PublicProjectTask => ({
    id: task.id,
    projectId: task.projectId,
    number: task.number,
    title: task.title,
    // Agent-control redaction: the execution envelope may be embedded in the
    // task description, so it never reaches a public payload.
    description: agentControlled ? null : task.description,
    status: task.status,
    priority: task.priority,
    startDate: task.startDate,
    dueDate: task.dueDate,
    position: task.position,
    createdAt: task.createdAt,
    labels: labelsByTask.get(task.id) ?? [],
  });

  const projectColumns = await db
    .select()
    .from(schema.columnTable)
    .where(and(eq(schema.columnTable.projectId, projectId)))
    .orderBy(asc(schema.columnTable.position));

  const columns: PublicProjectColumn[] = projectColumns.map((column) => ({
    id: column.slug,
    slug: column.slug,
    name: column.name,
    icon: column.icon,
    isFinal: column.isFinal,
    tasks: tasks
      .filter((task) => task.status === column.slug)
      .map(toPublicTask),
  }));

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    icon: project.icon,
    description: project.description,
    isPublic: project.isPublic ?? false,
    // P2-F4 fix: no agent-control signal in the public payload (acceptance:
    // no agent-control fields). The redaction above already protects content.
    columns,
    archivedTasks: tasks
      .filter((task) => task.status === "archived")
      .map(toPublicTask),
    plannedTasks: tasks
      .filter((task) => task.status === "planned")
      .map(toPublicTask),
  };
}
