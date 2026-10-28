import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  externalLinkTable,
  labelTable,
  projectTable,
  taskRelationTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { normalizeWorkMarkerCounts } from "../work-marker-counts";

type GetTasksOptions = {
  assigneeId?: string;
  dueAfter?: string;
  dueBefore?: string;
  limit?: number;
  page?: number;
  priority?: string;
  sortBy?:
    | "createdAt"
    | "priority"
    | "dueDate"
    | "position"
    | "title"
    | "number";
  sortOrder?: "asc" | "desc";
  status?: string;
};

const priorityCaseExpr = sql<number>`CASE
  WHEN ${taskTable.priority} = 'urgent' THEN 4
  WHEN ${taskTable.priority} = 'high' THEN 3
  WHEN ${taskTable.priority} = 'medium' THEN 2
  WHEN ${taskTable.priority} = 'low' THEN 1
  ELSE 0
END`;

function buildOrderBy(
  sortBy: GetTasksOptions["sortBy"],
  sortOrder: GetTasksOptions["sortOrder"],
): SQL {
  const direction = sortOrder === "desc" ? desc : asc;

  switch (sortBy) {
    case "createdAt":
      return direction(taskTable.createdAt);
    case "priority":
      return direction(priorityCaseExpr);
    case "dueDate":
      return direction(taskTable.dueDate);
    case "title":
      return direction(taskTable.title);
    case "number":
      return direction(taskTable.number);
    default:
      return direction(taskTable.position);
  }
}

async function getTasks(projectId: string, options: GetTasksOptions = {}) {
  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, projectId),
  });

  if (!project) {
    throw new HTTPException(404, {
      message: "Project not found",
    });
  }

  const conditions = [eq(taskTable.projectId, projectId)];

  if (options.status) {
    conditions.push(eq(taskTable.status, options.status));
  }

  if (options.priority) {
    conditions.push(eq(taskTable.priority, options.priority));
  }

  if (options.assigneeId) {
    conditions.push(eq(taskTable.userId, options.assigneeId));
  }

  if (options.dueBefore) {
    conditions.push(lte(taskTable.dueDate, new Date(options.dueBefore)));
  }

  if (options.dueAfter) {
    conditions.push(gte(taskTable.dueDate, new Date(options.dueAfter)));
  }

  const whereClause = and(...conditions);
  const usePagination = options.page != null || options.limit != null;
  const page = options.page && options.page > 0 ? options.page : 1;
  const pageSize =
    options.limit && options.limit > 0 ? Math.min(options.limit, 100) : 50;
  const offset = (page - 1) * pageSize;

  const orderByClause = buildOrderBy(
    options.sortBy ?? "position",
    options.sortOrder ?? "asc",
  );

  const [taskCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(taskTable)
    .where(whereClause);

  const total = Number(taskCount?.count ?? 0);

  const taskSelection = {
    id: taskTable.id,
    title: taskTable.title,
    number: taskTable.number,
    description: taskTable.description,
    status: taskTable.status,
    priority: taskTable.priority,
    startDate: taskTable.startDate,
    dueDate: taskTable.dueDate,
    position: taskTable.position,
    createdAt: taskTable.createdAt,
    userId: taskTable.userId,
    workMarkerCounts: taskTable.workMarkerCounts,
    assigneeName: userTable.name,
    assigneeId: userTable.id,
    assigneeImage: userTable.image,
    projectId: taskTable.projectId,
  };

  const query = db
    .select(taskSelection)
    .from(taskTable)
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .leftJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(whereClause)
    .orderBy(orderByClause);

  const paginatedTasks = usePagination
    ? await query.limit(pageSize).offset(offset)
    : await query;

  const taskIds = paginatedTasks.map((task) => task.id);

  const labelsData =
    taskIds.length > 0
      ? await db
          .select({
            id: labelTable.id,
            name: labelTable.name,
            color: labelTable.color,
            taskId: labelTable.taskId,
          })
          .from(labelTable)
          .where(inArray(labelTable.taskId, taskIds))
      : [];

  const externalLinksData =
    taskIds.length > 0
      ? await db
          .select()
          .from(externalLinkTable)
          .where(inArray(externalLinkTable.taskId, taskIds))
      : [];

  const taskLabelsMap = new Map<
    string,
    Array<{ id: string; name: string; color: string }>
  >();
  for (const label of labelsData) {
    if (label.taskId) {
      if (!taskLabelsMap.has(label.taskId)) {
        taskLabelsMap.set(label.taskId, []);
      }
      taskLabelsMap.get(label.taskId)?.push({
        id: label.id,
        name: label.name,
        color: label.color,
      });
    }
  }

  const taskExternalLinksMap = new Map<
    string,
    Array<{
      id: string;
      taskId: string;
      integrationId: string;
      resourceType: string;
      externalId: string;
      url: string;
      title: string | null;
      metadata: Record<string, unknown> | null;
    }>
  >();
  for (const externalLink of externalLinksData) {
    if (!taskExternalLinksMap.has(externalLink.taskId)) {
      taskExternalLinksMap.set(externalLink.taskId, []);
    }
    taskExternalLinksMap.get(externalLink.taskId)?.push({
      ...externalLink,
      metadata: externalLink.metadata
        ? JSON.parse(externalLink.metadata)
        : null,
    });
  }

  const projectColumns = await db
    .select()
    .from(columnTable)
    .where(eq(columnTable.projectId, projectId))
    .orderBy(asc(columnTable.position));

  const columnBySlug = new Map(
    projectColumns.map((column) => [column.slug, column]),
  );
  const isBoardVisibleStatus = (status: string) => columnBySlug.has(status);
  const isFinalStatus = (status: string) =>
    columnBySlug.get(status)?.isFinal === true;

  // SPEC-2026-10-27-kaneo-subtask-board-focus-markers: batch subtask
  // projection. One relation query + one related-task query regardless of how
  // many parents/children the project has (no per-card fetch).
  const subtaskRelationsOfProject =
    taskIds.length > 0
      ? await db
          .select({
            id: taskRelationTable.id,
            sourceTaskId: taskRelationTable.sourceTaskId,
            targetTaskId: taskRelationTable.targetTaskId,
            position: taskRelationTable.position,
            createdAt: taskRelationTable.createdAt,
          })
          .from(taskRelationTable)
          .where(
            and(
              eq(taskRelationTable.relationType, "subtask"),
              or(
                inArray(taskRelationTable.sourceTaskId, taskIds),
                inArray(taskRelationTable.targetTaskId, taskIds),
              ),
            ),
          )
          .orderBy(
            asc(taskRelationTable.position),
            asc(taskRelationTable.createdAt),
          )
      : [];

  const relatedTaskIds = new Set<string>();
  for (const relation of subtaskRelationsOfProject) {
    relatedTaskIds.add(relation.sourceTaskId);
    relatedTaskIds.add(relation.targetTaskId);
  }

  const relatedTaskRows =
    relatedTaskIds.size > 0
      ? await db
          .select({
            id: taskTable.id,
            title: taskTable.title,
            projectId: taskTable.projectId,
            status: taskTable.status,
            workMarkerCounts: taskTable.workMarkerCounts,
          })
          .from(taskTable)
          .where(inArray(taskTable.id, [...relatedTaskIds]))
      : [];

  const relatedTaskById = new Map(
    relatedTaskRows.map((task) => [task.id, task]),
  );

  // A task is a subtask card only when it is a child of a parent in the same
  // project whose status maps to a real board column (planned/archived
  // parents must NOT hide their children from the board).
  const childRelationByTaskId = new Map<string, boolean>();
  const subtaskChildrenByParentId = new Map<
    string,
    Array<{
      targetTaskId: string;
    }>
  >();

  for (const relation of subtaskRelationsOfProject) {
    const child = relatedTaskById.get(relation.targetTaskId);
    const parent = relatedTaskById.get(relation.sourceTaskId);
    if (!child || !parent) {
      continue;
    }
    if (
      child.projectId !== projectId ||
      parent.projectId !== projectId ||
      !isBoardVisibleStatus(parent.status)
    ) {
      continue;
    }

    childRelationByTaskId.set(child.id, true);
    const children = subtaskChildrenByParentId.get(parent.id) ?? [];
    children.push({ targetTaskId: child.id });
    subtaskChildrenByParentId.set(parent.id, children);
  }

  // First same-project, board-visible, non-final child in relation order is
  // the "next work" preview. planned/archived and final-column children are
  // never selected. Relations were ordered by position, createdAt already.
  const buildNextSubtaskPreview = (parentId: string) => {
    const children = subtaskChildrenByParentId.get(parentId);
    if (!children || children.length === 0) {
      return null;
    }

    for (const child of children) {
      const full = relatedTaskById.get(child.targetTaskId);
      if (!full) {
        continue;
      }
      if (
        full.projectId === projectId &&
        isBoardVisibleStatus(full.status) &&
        !isFinalStatus(full.status)
      ) {
        return {
          id: full.id,
          title: full.title,
          workMarkerCounts: normalizeWorkMarkerCounts(full.workMarkerCounts),
        };
      }
    }
    return null;
  };

  const decorateTask = (task: (typeof paginatedTasks)[number]) => ({
    ...task,
    workMarkerCounts: normalizeWorkMarkerCounts(task.workMarkerCounts),
    isSubtask: childRelationByTaskId.has(task.id),
    nextSubtaskPreview: buildNextSubtaskPreview(task.id),
  });

  const columns = projectColumns.map((column) => ({
    id: column.slug,
    slug: column.slug,
    name: column.name,
    icon: column.icon,
    isFinal: column.isFinal,
    tasks: paginatedTasks
      .filter((task) => task.status === column.slug)
      .map(decorateTask)
      .map((task) => ({
        ...task,
        labels: taskLabelsMap.get(task.id) || [],
        externalLinks: taskExternalLinksMap.get(task.id) || [],
      })),
  }));

  const archivedTasks = paginatedTasks
    .filter((task) => task.status === "archived")
    .map(decorateTask)
    .map((task) => ({
      ...task,
      labels: taskLabelsMap.get(task.id) || [],
      externalLinks: taskExternalLinksMap.get(task.id) || [],
    }));

  const plannedTasks = paginatedTasks
    .filter((task) => task.status === "planned")
    .map(decorateTask)
    .map((task) => ({
      ...task,
      labels: taskLabelsMap.get(task.id) || [],
      externalLinks: taskExternalLinksMap.get(task.id) || [],
    }));

  return {
    data: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      icon: project.icon,
      description: project.description,
      isPublic: project.isPublic,
      workspaceId: project.workspaceId,
      showSubtaskCardsByDefault: project.showSubtaskCardsByDefault,
      showAssigneesByDefault: project.showAssigneesByDefault,
      showPriorityByDefault: project.showPriorityByDefault,
      columns,
      archivedTasks,
      plannedTasks,
    },
    pagination: usePagination
      ? {
          total,
          page,
          pageSize,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
        }
      : {
          total,
          page: 1,
          pageSize: total,
          totalPages: 1,
        },
  };
}

export default getTasks;
