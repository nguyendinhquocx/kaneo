import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import updateWorkMarkers from "@/fetchers/task/update-work-markers";
import type Task from "@/types/task";
import type { TaskMarkerCounts } from "@/types/task";
import type { ProjectBoardTask, ProjectWithTasks } from "@/types/project";

const taskRelationsQueryKey = ["task-relations"] as const;

type RelationTask = Pick<Task, "id" | "workMarkerCounts"> &
  Record<string, unknown>;
type TaskRelationCacheRow = {
  sourceTask?: RelationTask | null;
  targetTask?: RelationTask | null;
} & Record<string, unknown>;

type MarkerMutationContext = {
  previousTask: Task | undefined;
  previousProject: ProjectWithTasks | undefined;
  previousRelations: Array<
    [readonly unknown[], TaskRelationCacheRow[] | undefined]
  >;
};

function updateBoardTaskMarkers(
  task: ProjectBoardTask,
  taskId: string,
  workMarkerCounts: TaskMarkerCounts,
): ProjectBoardTask {
  const nextTask =
    task.id === taskId ? { ...task, workMarkerCounts } : task;
  const preview = nextTask.nextSubtaskPreview;
  if (!preview || preview.id !== taskId) return nextTask;
  return {
    ...nextTask,
    nextSubtaskPreview: { ...preview, workMarkerCounts },
  };
}

function updateRelationTaskMarkers(
  task: RelationTask | null | undefined,
  taskId: string,
  workMarkerCounts: TaskMarkerCounts,
) {
  return task?.id === taskId ? { ...task, workMarkerCounts } : task;
}

// Marker changes should appear beside the title as soon as the owner chooses
// a preset. Keep all cached projections in step while the server confirms the
// write, then revalidate quietly; on failure, the mutation context restores
// the last server-backed data.
export function useUpdateWorkMarkers(taskId: string, projectId: string) {
  const queryClient = useQueryClient();
  const mutationKey = ["task", "work-markers", taskId] as const;
  const isUpdatingThisTask = useIsMutating({ mutationKey }) > 0;
  const mutation = useMutation<
    TaskMarkerCounts,
    Error,
    TaskMarkerCounts,
    MarkerMutationContext
  >({
    mutationKey,
    mutationFn: (workMarkerCounts) =>
      updateWorkMarkers(taskId, workMarkerCounts),
    onMutate: async (workMarkerCounts) => {
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: ["task", taskId],
          exact: true,
        }),
        queryClient.cancelQueries({
          queryKey: ["tasks", projectId],
          exact: true,
        }),
        queryClient.cancelQueries({ queryKey: taskRelationsQueryKey }),
      ]);

      const previousTask = queryClient.getQueryData<Task>(["task", taskId]);
      const previousProject = queryClient.getQueryData<ProjectWithTasks>([
        "tasks",
        projectId,
      ]);
      const previousRelations = queryClient.getQueriesData<TaskRelationCacheRow[]>({
        queryKey: taskRelationsQueryKey,
      });

      if (previousTask) {
        queryClient.setQueryData<Task>(["task", taskId], {
          ...previousTask,
          workMarkerCounts,
        });
      }
      if (previousProject) {
        const updateTasks = (tasks: ProjectBoardTask[]) =>
          tasks.map((task) =>
            updateBoardTaskMarkers(task, taskId, workMarkerCounts),
          );
        queryClient.setQueryData<ProjectWithTasks>(["tasks", projectId], {
          ...previousProject,
          columns: previousProject.columns.map((column) => ({
            ...column,
            tasks: updateTasks(column.tasks),
          })),
          plannedTasks: updateTasks(previousProject.plannedTasks),
          archivedTasks: updateTasks(previousProject.archivedTasks),
        });
      }
      for (const [queryKey, relations] of previousRelations) {
        if (!relations) continue;
        queryClient.setQueryData<TaskRelationCacheRow[]>(
          queryKey,
          relations.map((relation) => ({
            ...relation,
            sourceTask: updateRelationTaskMarkers(
              relation.sourceTask,
              taskId,
              workMarkerCounts,
            ),
            targetTask: updateRelationTaskMarkers(
              relation.targetTask,
              taskId,
              workMarkerCounts,
            ),
          })),
        );
      }

      return { previousTask, previousProject, previousRelations };
    },
    onError: (_error, _workMarkerCounts, context) => {
      if (!context) return;
      if (context.previousTask) {
        queryClient.setQueryData(["task", taskId], context.previousTask);
      }
      if (context.previousProject) {
        queryClient.setQueryData(["tasks", projectId], context.previousProject);
      }
      for (const [queryKey, relations] of context.previousRelations) {
        if (relations) queryClient.setQueryData(queryKey, relations);
      }
    },
    onSettled: () => {
      // Do not keep the picker open while the refetch runs; the optimistic
      // projection is already correct, and the next mutation cancels this read.
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
        queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }),
        queryClient.invalidateQueries({ queryKey: taskRelationsQueryKey }),
      ]);
    },
  });

  return {
    ...mutation,
    isPending: mutation.isPending || isUpdatingThisTask,
  };
}

export default useUpdateWorkMarkers;
