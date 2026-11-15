import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import updateTask from "@/fetchers/task/update-task";
import {
  moveShareFullTask,
  updateShareFullTask,
} from "@/fetchers/share/share-full-api";
import {
  updateTaskShareTask,
  type TaskShareRootPayload,
} from "@/fetchers/share/share-task-api";
import { moveSharedProjectTask } from "@/fetchers/share/share-public-api";
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
    mutationFn: async (input) => {
      const capability = getShareCapability();
      if (!capability) {
        throw new Error("A share capability is required to move a task.");
      }
      if (capability.resourceType === "task") {
        if (capability.permission !== "edit" || input.taskId !== capability.rootTaskId) {
          throw new Error("Only the shared root card can move on this board.");
        }
        const root = queryClient.getQueryData<TaskShareRootPayload>([
          "share-task",
          capability.token,
          "root",
        ]);
        if (!root || root.root.id !== input.taskId) {
          throw new Error("The shared card is not available for this move.");
        }
        await updateTaskShareTask({
          token: capability.token,
          taskId: input.taskId,
          patch: { status: input.status },
          expectedContentRevision: root.root.contentRevision,
        });
        return { success: true };
      }
      if (capability.permission !== "full") {
        if (capability.permission !== "edit") {
          throw new Error("The shared project is read-only.");
        }
        const movingTask = queryClient
          .getQueryData<ProjectWithTasks>(["share-full", capability.token])
          ?.columns.flatMap((column) => column.tasks)
          .find((candidate) => candidate.id === input.taskId);
        if (!movingTask) throw new Error("The shared card is unavailable.");
        return moveSharedProjectTask({
          token: capability.token,
          taskId: input.taskId,
          status: input.status,
          position: input.position,
          expectedContentRevision: movingTask.contentRevision ?? 1,
        });
      }
      const movingTask = queryClient
        .getQueryData<ProjectWithTasks>(["share-full", capability.token])
        ?.columns.flatMap((column) => column.tasks)
        .find((candidate) => candidate.id === input.taskId);
      return moveShareFullTask(
        capability.token,
        input.taskId,
        {
          status: input.status,
          position: input.position,
        },
        // SPEC-2026-11-10 T3: full-share moves CAS the moved card.
        movingTask?.contentRevision ?? 1,
      );
    },
    onMutate: async (input) => {
      const capability = getShareCapability();
      if (!capability || capability.resourceType === "task") return undefined;

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
      const capability = getShareCapability();
      invalidateShareQueries(queryClient);
      if (capability?.resourceType === "project" && capability.permission !== "full") {
        void Promise.all([
          queryClient.invalidateQueries({
            queryKey: ["share", "project", capability.token],
          }),
          queryClient.invalidateQueries({
            queryKey: ["share-project-route", capability.token],
            exact: true,
          }),
        ]);
      }
      if (context) {
        return queryClient.invalidateQueries({
          queryKey: context.queryKey,
          exact: true,
        });
      }
    },
  });
}

export function useUpdateTask({ deferInvalidation = false }: { deferInvalidation?: boolean } = {}) {
  const queryClient = useQueryClient();

  return useMutation<Task, Error, Task>({
    mutationFn: (task: Task) => {
      const capability = getShareCapability();
      if (capability) {
        return updateShareFullTask(
          capability.token,
          task.id,
          {
            title: task.title,
            description: task.description || null,
            status: task.status,
            priority: task.priority ?? undefined,
            startDate: task.startDate?.toString() ?? null,
            dueDate: task.dueDate?.toString() ?? null,
            assigneeId: task.userId ?? null,
          },
          // SPEC-2026-11-10 T3: full-share writes carry the content CAS.
          task.contentRevision ?? 1,
        ) as unknown as Promise<Task>;
      }
      return updateTask(task.id, task) as unknown as Promise<Task>;
    },
    onSuccess: (_, variables) => {
      if (deferInvalidation) return;
      invalidateShareQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: ["task", variables.id],
      });
      queryClient.invalidateQueries({ queryKey: ["task-relations"] });
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
