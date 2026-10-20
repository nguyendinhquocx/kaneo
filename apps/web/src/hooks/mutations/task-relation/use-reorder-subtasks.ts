import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reorderSubtasks } from "@/fetchers/task-relation/reorder-subtasks";
import {
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
      const previousTasks = queryClient.getQueryData<Task[]>(taskKey);

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
      if (previousTasks) {
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
