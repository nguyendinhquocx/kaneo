import { useQuery } from "@tanstack/react-query";
import getGiteaIntegration from "@/fetchers/gitea-integration/get-gitea-integration";
import { getShareCapability } from "@/components/share/share-capability";

function useGetGiteaIntegration(projectId: string) {
  return useQuery({
    queryKey: ["gitea-integration", projectId],
    queryFn: () => getGiteaIntegration(projectId),
    enabled: !!projectId && !getShareCapability(),
  });
}

export default useGetGiteaIntegration;
