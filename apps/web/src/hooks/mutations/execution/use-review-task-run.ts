import { useMutation, useQueryClient } from "@tanstack/react-query";
import reviewTaskRun from "@/fetchers/execution/review-task-run";

function useReviewTaskRun() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: reviewTaskRun,
    onSuccess: (_, { taskId, runId }) => {
      void queryClient.invalidateQueries({
        queryKey: ["execution-runs", taskId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["execution-run-evidence", taskId, runId],
      });
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });
}

export default useReviewTaskRun;
