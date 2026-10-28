import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useUpdateTask } from "@/hooks/mutations/task/use-update-task";
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
 * A lane reorder is rendered optimistically, then persisted with the existing
 * guarded task-update route. Per-task invalidations are deferred until the full
 * group settles so a slow request cannot flash the old lane back into view.
 */
export function useReorderProjectTasks() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { setProject } = useProjectStore();
  const { mutateAsync: updateTask } = useUpdateTask({ deferInvalidation: true });

  return useMutation<
    void,
    Error,
    ReorderProjectTasksInput,
    ReorderProjectTasksContext
  >({
    mutationFn: async ({ changedTasks }) => {
      const results = await Promise.allSettled(
        changedTasks.map((task) => updateTask(task)),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
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
        queryClient.invalidateQueries({
          queryKey: ["activities", variables.taskId],
        }),
        queryClient.invalidateQueries({ queryKey: ["notifications"] }),
      ]);
    },
  });
}
