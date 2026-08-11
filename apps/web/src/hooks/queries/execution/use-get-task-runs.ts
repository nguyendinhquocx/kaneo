import { useQuery } from "@tanstack/react-query";
import getTaskRuns from "@/fetchers/execution/get-task-runs";

function useGetTaskRuns(taskId: string) {
  return useQuery({
    queryKey: ["execution-runs", taskId],
    queryFn: () => getTaskRuns(taskId),
    enabled: Boolean(taskId),
  });
}

export default useGetTaskRuns;
