import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import reorderProjectTasksBatch from "@/fetchers/task/reorder-project-tasks";
import { toast } from "@/lib/toast";
import useProjectStore from "@/store/project";
import type { ProjectBoardTask, ProjectWithTasks } from "@/types/project";

type ReorderProjectTasksInput = {
  projectId: string;
  taskId: string;
  optimisticProject: ProjectWithTasks;
  changedTasks: ProjectBoardTask[];
};

type ReorderProjectTasksContext = {
  queryKey: readonly ["tasks", string];
  previous: ProjectWithTasks | undefined;
};

/**
 * A lane reorder is rendered optimistically, then persisted with the R4 batch
 * endpoint — one request per drag instead of one full PATCH per changed card
 * (the per-card fan-out exhausted the Postgres pool and serialized the next
 * drag behind pending writes). Per-task invalidations are deferred until the
 * whole group settles so a slow request cannot flash the old lane into view.
 */
export function useReorderProjectTasks() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { setProject } = useProjectStore();

  return useMutation<
    unknown,
    Error,
    ReorderProjectTasksInput,
    ReorderProjectTasksContext
  >({
    mutationFn: async ({ projectId, changedTasks }) => {
      return reorderProjectTasksBatch(
        projectId,
        changedTasks.map((task) => ({
          id: task.id,
          status: task.status,
          position: task.position ?? 0,
        })),
      );
    },
    onMutate: async ({ projectId, optimisticProject }) => {
      const queryKey = ["tasks", projectId] as const;
      await queryClient.cancelQueries({ queryKey, exact: true });
      const previous = queryClient.getQueryData<ProjectWithTasks>(queryKey);
      queryClient.setQueryData(queryKey, optimisticProject);
      setProject(optimisticProject);
      return { queryKey, previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
        setProject(context.previous);
      }
      toast.error(error.message || t("tasks:move.error"));
    },
    onSettled: async (_data, _error, variables, context) => {
      if (!context) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: context.queryKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["task", variables.taskId] }),
        queryClient.invalidateQueries({ queryKey: ["task-relations"] }),
        queryClient.invalidateQueries({
          queryKey: ["activities", variables.taskId],
        }),
        queryClient.invalidateQueries({ queryKey: ["notifications"] }),
      ]);
    },
  });
}
