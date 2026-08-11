import { useQuery } from "@tanstack/react-query";
import getTaskRunEvidence from "@/fetchers/execution/get-task-run-evidence";

function useGetTaskRunEvidence(taskId: string, runId: string | undefined) {
  return useQuery({
    queryKey: ["execution-run-evidence", taskId, runId],
    queryFn: () => getTaskRunEvidence(taskId, runId ?? ""),
    enabled: Boolean(taskId && runId),
  });
}

export default useGetTaskRunEvidence;
