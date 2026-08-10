import { useQuery } from "@tanstack/react-query";
import getExecutionManifest from "@/fetchers/execution/get-execution-manifest";

function useGetExecutionManifest(projectId: string) {
  return useQuery({
    queryKey: ["execution-manifest", projectId],
    queryFn: () => getExecutionManifest(projectId),
    enabled: !!projectId,
  });
}

export default useGetExecutionManifest;
