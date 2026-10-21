type OrderedRelation = {
  relationType: string;
  sourceTaskId: string;
  targetTaskId: string;
  position: number;
};

type PositionedTask = {
  id: string;
  status: string;
  position: number | null;
};

type TaskColumn = {
  slug?: string;
  tasks?: PositionedTask[];
};

// Shape returned by GET /task/tasks/:projectId: the project with per-column
// task lanes, not a flat task array. Cached under ["tasks", projectId].
export type ProjectTasksCache = {
  id?: string;
  columns?: TaskColumn[];
  archivedTasks?: PositionedTask[];
  plannedTasks?: PositionedTask[];
  [key: string]: unknown;
};

export function moveTaskId(ids: string[], taskId: string, offset: -1 | 1) {
  const from = ids.indexOf(taskId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function reorderSubtaskRelations<T extends OrderedRelation>(
  relations: T[],
  parentTaskId: string,
  orderedTargetTaskIds: string[],
) {
  const order = new Map(orderedTargetTaskIds.map((id, index) => [id, index]));
  const siblings = relations.filter(
    (relation) =>
      relation.relationType === "subtask" &&
      relation.sourceTaskId === parentTaskId &&
      order.has(relation.targetTaskId),
  );
  const sortedIds = new Set(
    [...siblings]
      .sort(
        (left, right) =>
          (order.get(left.targetTaskId) ?? 0) -
          (order.get(right.targetTaskId) ?? 0),
      )
      .map((relation) => relation.targetTaskId),
  );
  const nextPosition = new Map(
    orderedTargetTaskIds.map((id, index) => [id, index]),
  );
  const reorderedSiblings = [...siblings].sort(
    (left, right) =>
      (nextPosition.get(left.targetTaskId) ?? Number.MAX_SAFE_INTEGER) -
      (nextPosition.get(right.targetTaskId) ?? Number.MAX_SAFE_INTEGER),
  );
  let siblingIndex = 0;
  return relations.map((relation) => {
    if (
      relation.relationType !== "subtask" ||
      !sortedIds.has(relation.targetTaskId) ||
      relation.sourceTaskId !== parentTaskId
    ) {
      return relation;
    }
    const reordered = reorderedSiblings[siblingIndex++];
    return {
      ...reordered,
      position: nextPosition.get(reordered.targetTaskId) ?? reordered.position,
    };
  });
}

function reorderFlatTaskCards<T extends PositionedTask>(
  tasks: T[],
  orderedSiblingIds: string[],
): T[] {
  const order = new Map(orderedSiblingIds.map((id, index) => [id, index]));
  const tasksByStatus = new Map<string, T[]>();
  for (const task of tasks) {
    const lane = tasksByStatus.get(task.status) ?? [];
    lane.push(task);
    tasksByStatus.set(task.status, lane);
  }

  const updates = new Map<string, T>();
  for (const laneTasks of tasksByStatus.values()) {
    const sortedLane = [...laneTasks].sort(
      (left, right) =>
        (left.position ?? 0) - (right.position ?? 0) ||
        tasks.indexOf(left) - tasks.indexOf(right),
    );
    const siblingSlots = sortedLane
      .map((task, index) => (order.has(task.id) ? index : -1))
      .filter((index) => index >= 0);
    if (siblingSlots.length === 0) continue;

    const orderedSiblings = sortedLane
      .filter((task) => order.has(task.id))
      .sort(
        (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
      );
    const nextLane = [...sortedLane];
    siblingSlots.forEach((slot, index) => {
      nextLane[slot] = orderedSiblings[index];
    });
    nextLane.forEach((task, position) => {
      updates.set(task.id, { ...task, position });
    });
  }

  return tasks.map((task) => updates.get(task.id) ?? task);
}

export function reorderTaskCardsBySiblingLane<T extends PositionedTask>(
  tasks: T[],
  orderedSiblingIds: string[],
): T[];
export function reorderTaskCardsBySiblingLane(
  tasks: ProjectTasksCache,
  orderedSiblingIds: string[],
): ProjectTasksCache;
export function reorderTaskCardsBySiblingLane(
  tasks: null,
  orderedSiblingIds: string[],
): null;
export function reorderTaskCardsBySiblingLane(
  tasks: undefined,
  orderedSiblingIds: string[],
): undefined;
export function reorderTaskCardsBySiblingLane(
  tasks: PositionedTask[] | ProjectTasksCache | null | undefined,
  orderedSiblingIds: string[],
): PositionedTask[] | ProjectTasksCache | null | undefined {
  if (Array.isArray(tasks)) {
    return reorderFlatTaskCards(tasks, orderedSiblingIds);
  }
  // The ["tasks", projectId] cache holds a project object with column lanes
  // (see GET /task/tasks/:projectId). Unknown shapes pass through untouched —
  // the relations cache is the source of truth for subtask order anyway.
  if (!tasks || typeof tasks !== "object" || !Array.isArray(tasks.columns)) {
    return tasks;
  }

  const reorderLane = (lane: PositionedTask[] | undefined) =>
    Array.isArray(lane) ? reorderFlatTaskCards(lane, orderedSiblingIds) : lane;

  return {
    ...tasks,
    columns: tasks.columns.map((column) => ({
      ...column,
      tasks: reorderLane(column?.tasks),
    })),
    archivedTasks: reorderLane(tasks.archivedTasks),
    plannedTasks: reorderLane(tasks.plannedTasks),
  };
}
