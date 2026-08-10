import { useMutation, useQueryClient } from "@tanstack/react-query";
import createExecutionAgent from "@/fetchers/execution/create-execution-agent";

function useCreateExecutionAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createExecutionAgent,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["execution-agents"],
      });
    },
  });
}

export default useCreateExecutionAgent;
