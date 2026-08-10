import { useQuery } from "@tanstack/react-query";
import getExecutionAgents from "@/fetchers/execution/get-execution-agents";

function useGetExecutionAgents() {
  return useQuery({
    queryKey: ["execution-agents"],
    queryFn: getExecutionAgents,
  });
}

export default useGetExecutionAgents;
