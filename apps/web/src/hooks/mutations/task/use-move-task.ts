import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import moveTask from "@/fetchers/task/move-task";
import { toast } from "@/lib/toast";
import type Task from "@/types/task";
import { getExpectedContentRevision } from "@/lib/task-content-revision";

export function useMoveTask() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      variables: {
        taskId: string;
        destinationProjectId: string;
        destinationStatus?: string;
      },
    ) => {
      // SPEC-2026-11-10 T3: moves CAS the moved card.
      const cached = await queryClient.fetchQuery({
        queryKey: ["task", variables.taskId],
        queryFn: () => Promise.resolve(undefined as Task | undefined),
        staleTime: 0,
      }).catch(() => undefined);
      return moveTask({
        ...variables,
        expectedContentRevision: getExpectedContentRevision(cached),
      });
    },
    onSuccess: (result, variables) => {
      toast.success(t("tasks:move.success"));
      queryClient.invalidateQueries({
        queryKey: ["task", variables.taskId],
      });
      queryClient.invalidateQueries({
        queryKey: ["tasks", result.sourceProjectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["tasks", result.destinationProjectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      queryClient.invalidateQueries({
        queryKey: ["activities", variables.taskId],
      });
      queryClient.invalidateQueries({
        queryKey: ["notifications"],
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("tasks:move.error"),
      );
    },
  });
}
