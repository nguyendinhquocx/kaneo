import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import updateTask from "@/fetchers/task/update-task";
import {
  moveShareFullTask,
  updateShareFullTask,
} from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";
import type { ProjectWithTasks } from "@/types/project";
import { toast } from "@/lib/toast";
import type Task from "@/types/task";

type ShareTaskMove = { taskId: string; status: string; position: number };
type ShareTaskMoveContext = {
  queryKey: readonly unknown[];
  previous: ProjectWithTasks | undefined;
};

export function useMoveShareTask() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<
    { success: boolean },
    Error,
    ShareTaskMove,
    ShareTaskMoveContext | undefined
  >({
    mutationFn: (input) => {
      const capability = getShareCapability();
      if (!capability) {
        throw new Error("A full-share capability is required to move a task.");
      }
      return moveShareFullTask(capability.token, input.taskId, {
        status: input.status,
        position: input.position,
      });
    },
    onMutate: async (input) => {
      const capability = getShareCapability();
      if (!capability) return undefined;

      const queryKey = ["share-full", capability.token] as const;
      await queryClient.cancelQueries({ queryKey, exact: true });
      const previous = queryClient.getQueryData<ProjectWithTasks>(queryKey);
      if (!previous) return { queryKey, previous };

      const sourceColumn = previous.columns.find((column) =>
        column.tasks.some((task) => task.id === input.taskId),
      );
      const destinationColumn = previous.columns.find(
        (column) => column.slug === input.status,
      );
      const movingTask = sourceColumn?.tasks.find(
        (task) => task.id === input.taskId,
      );
      if (!sourceColumn || !destinationColumn || !movingTask) {
        return { queryKey, previous };
      }

      const sourceTasks = sourceColumn.tasks.filter(
        (task) => task.id !== input.taskId,
      );
      const destinationTasks =
        sourceColumn.id === destinationColumn.id
          ? sourceTasks
          : destinationColumn.tasks.filter(
              (task) => task.id !== input.taskId,
            );
      const destinationIndex = Math.max(
        0,
        Math.min(input.position, destinationTasks.length),
      );
      const reorderedDestination = [...destinationTasks];
      reorderedDestination.splice(destinationIndex, 0, {
        ...movingTask,
        status: input.status,
      });

      const columns = previous.columns.map((column) => {
        if (column.id === sourceColumn.id && column.id === destinationColumn.id) {
          return {
            ...column,
            tasks: reorderedDestination.map((task, position) => ({
              ...task,
              status: input.status,
              position,
            })),
          };
        }
        if (column.id === sourceColumn.id) {
          return {
            ...column,
            tasks: sourceTasks.map((task, position) => ({ ...task, position })),
          };
        }
        if (column.id === destinationColumn.id) {
          return {
            ...column,
            tasks: reorderedDestination.map((task, position) => ({
              ...task,
              status: input.status,
              position,
            })),
          };
        }
        return column;
      });
      queryClient.setQueryData<ProjectWithTasks>(queryKey, {
        ...previous,
        columns,
      });
      return { queryKey, previous };
    },
    onError: (_error, _input, context) => {
      if (context) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      toast.error(t("share:full.moveFailed"));
    },
    onSettled: (_data, _error, _input, context) => {
      if (context) {
        return queryClient.invalidateQueries({
          queryKey: context.queryKey,
          exact: true,
        });
      }
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation<Task, Error, Task>({
    mutationFn: (task: Task) => {
      const capability = getShareCapability();
      if (capability) {
        return updateShareFullTask(capability.token, task.id, {
          title: task.title,
          description: task.description || null,
          status: task.status,
          priority: task.priority ?? undefined,
          startDate: task.startDate?.toString() ?? null,
          dueDate: task.dueDate?.toString() ?? null,
          assigneeId: task.userId ?? null,
        }) as unknown as Promise<Task>;
      }
      return updateTask(task.id, task) as unknown as Promise<Task>;
    },
    onSuccess: (_, variables) => {
      invalidateShareQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: ["task", variables.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["tasks", variables.projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["notifications"],
      });
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      queryClient.invalidateQueries({
        queryKey: ["activities", variables.id],
      });
    },
  });
}
