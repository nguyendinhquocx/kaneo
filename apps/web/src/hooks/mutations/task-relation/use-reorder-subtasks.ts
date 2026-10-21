import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reorderSubtasks } from "@/fetchers/task-relation/reorder-subtasks";
import {
  type ProjectTasksCache,
  reorderSubtaskRelations,
  reorderTaskCardsBySiblingLane,
} from "@/lib/subtask-order";
import type Task from "@/types/task";

type RelationCache = {
  relationType: string;
  sourceTaskId: string;
  targetTaskId: string;
  position: number;
  [key: string]: unknown;
};

type ReorderInput = {
  taskId: string;
  projectId: string;
  orderedTargetTaskIds: string[];
};

export function useReorderSubtasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, orderedTargetTaskIds }: ReorderInput) =>
      reorderSubtasks({ taskId, orderedTargetTaskIds }),
    onMutate: async ({ taskId, projectId, orderedTargetTaskIds }) => {
      const relationKey = ["task-relations", taskId];
      const taskKey = ["tasks", projectId];
      await Promise.all([
        queryClient.cancelQueries({ queryKey: relationKey }),
        queryClient.cancelQueries({ queryKey: taskKey }),
      ]);
      const previousRelations =
        queryClient.getQueryData<RelationCache[]>(relationKey);
      // The ["tasks", projectId] cache can be a flat task array or a project
      // object with column lanes depending on the view that populated it.
      const previousTasks = queryClient.getQueryData<
        Task[] | ProjectTasksCache
      >(taskKey);

      if (previousRelations) {
        queryClient.setQueryData(
          relationKey,
          reorderSubtaskRelations(
            previousRelations,
            taskId,
            orderedTargetTaskIds,
          ),
        );
      }
      if (Array.isArray(previousTasks)) {
        queryClient.setQueryData(
          taskKey,
          reorderTaskCardsBySiblingLane(previousTasks, orderedTargetTaskIds),
        );
      } else if (previousTasks) {
        queryClient.setQueryData(
          taskKey,
          reorderTaskCardsBySiblingLane(previousTasks, orderedTargetTaskIds),
        );
      }
      return { relationKey, taskKey, previousRelations, previousTasks };
    },
    onError: (_error, _input, context) => {
      if (context?.previousRelations) {
        queryClient.setQueryData(
          context.relationKey,
          context.previousRelations,
        );
      }
      if (context?.previousTasks) {
        queryClient.setQueryData(context.taskKey, context.previousTasks);
      }
    },
    onSettled: (_data, _error, input) => {
      queryClient.invalidateQueries({
        queryKey: ["task-relations", input.taskId],
      });
      queryClient.invalidateQueries({ queryKey: ["tasks", input.projectId] });
    },
  });
}
