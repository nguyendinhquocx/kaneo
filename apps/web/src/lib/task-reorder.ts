import type { ProjectBoardTask, ProjectWithTasks } from "@/types/project";

export type TaskReorderPlacement = "before" | "after" | "end";

export type TaskReorderIntent = {
  taskId: string;
  destinationStatus: string;
  targetTaskId: string | null;
  placement: TaskReorderPlacement;
};

export type ReorderedProject = {
  project: ProjectWithTasks;
  changedTasks: ProjectBoardTask[];
};

/**
 * Convert a dnd-kit target into a stable before/after/end intent. Same-column
 * moves preserve the existing behavior: dragging down inserts after the target,
 * dragging up inserts before it.
 */
export function resolveTaskReorderIntent(
  project: ProjectWithTasks,
  activeTaskId: string,
  overId: string,
): TaskReorderIntent | null {
  if (activeTaskId === overId) return null;

  const sourceColumn = project.columns.find((column) =>
    column.tasks.some((task) => task.id === activeTaskId),
  );
  const destinationColumn = project.columns.find(
    (column) =>
      column.id === overId ||
      column.slug === overId ||
      column.tasks.some((task) => task.id === overId),
  );
  if (!sourceColumn || !destinationColumn) return null;

  if (overId === destinationColumn.id || overId === destinationColumn.slug) {
    return {
      taskId: activeTaskId,
      destinationStatus: destinationColumn.slug,
      targetTaskId: null,
      placement: "end",
    };
  }

  const targetTask = destinationColumn.tasks.find((task) => task.id === overId);
  if (!targetTask) return null;

  if (sourceColumn.id !== destinationColumn.id) {
    return {
      taskId: activeTaskId,
      destinationStatus: destinationColumn.slug,
      targetTaskId: targetTask.id,
      placement: "after",
    };
  }

  const sourceIndex = sourceColumn.tasks.findIndex(
    (task) => task.id === activeTaskId,
  );
  const targetIndexAfterRemoval = sourceColumn.tasks
    .filter((task) => task.id !== activeTaskId)
    .findIndex((task) => task.id === targetTask.id);

  return {
    taskId: activeTaskId,
    destinationStatus: destinationColumn.slug,
    targetTaskId: targetTask.id,
    placement:
      sourceIndex <= targetIndexAfterRemoval ? "after" : "before",
  };
}

/** Reorder the full cached project, including cards hidden by filters. */
export function reorderProjectTasks(
  project: ProjectWithTasks,
  intent: TaskReorderIntent,
): ReorderedProject {
  const sourceColumn = project.columns.find((column) =>
    column.tasks.some((task) => task.id === intent.taskId),
  );
  const destinationColumn = project.columns.find(
    (column) => column.slug === intent.destinationStatus,
  );
  const movingTask = sourceColumn?.tasks.find(
    (task) => task.id === intent.taskId,
  );
  if (!sourceColumn || !destinationColumn || !movingTask) {
    return { project, changedTasks: [] };
  }

  const sourceTasks = sourceColumn.tasks.filter(
    (task) => task.id !== intent.taskId,
  );
  const destinationTasks =
    sourceColumn.id === destinationColumn.id
      ? sourceTasks
      : destinationColumn.tasks.filter((task) => task.id !== intent.taskId);

  let destinationIndex = destinationTasks.length;
  if (intent.placement !== "end") {
    const targetIndex = destinationTasks.findIndex(
      (task) => task.id === intent.targetTaskId,
    );
    if (targetIndex < 0) return { project, changedTasks: [] };
    destinationIndex =
      intent.placement === "after" ? targetIndex + 1 : targetIndex;
  }

  const nextDestinationTasks = [...destinationTasks];
  nextDestinationTasks.splice(destinationIndex, 0, {
    ...movingTask,
    status: destinationColumn.slug,
  });
  const normalizedDestination = nextDestinationTasks.map((task, position) => ({
    ...task,
    status: destinationColumn.slug,
    position,
  }));
  const normalizedSource = sourceTasks.map((task, position) => ({
    ...task,
    position,
  }));

  const columns = project.columns.map((column) => {
    if (column.id === sourceColumn.id && column.id === destinationColumn.id) {
      return { ...column, tasks: normalizedDestination };
    }
    if (column.id === sourceColumn.id) {
      return { ...column, tasks: normalizedSource };
    }
    if (column.id === destinationColumn.id) {
      return { ...column, tasks: normalizedDestination };
    }
    return column;
  });

  const previousTasksById = new Map(
    project.columns.flatMap((column) => column.tasks).map((task) => [task.id, task]),
  );
  const changedTasksById = new Map<string, ProjectBoardTask>();
  for (const task of [...normalizedSource, ...normalizedDestination]) {
    const previous = previousTasksById.get(task.id);
    if (previous && (previous.status !== task.status || previous.position !== task.position)) {
      changedTasksById.set(task.id, task);
    }
  }

  return {
    project: { ...project, columns },
    changedTasks: [...changedTasksById.values()],
  };
}
