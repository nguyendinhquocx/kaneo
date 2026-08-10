import { useMutation, useQueryClient } from "@tanstack/react-query";
import upsertExecutionManifest from "@/fetchers/execution/upsert-execution-manifest";

function useUpsertExecutionManifest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: upsertExecutionManifest,
    onSuccess: (_, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: ["execution-manifest", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["execution-agents"],
      });
    },
  });
}

export default useUpsertExecutionManifest;
