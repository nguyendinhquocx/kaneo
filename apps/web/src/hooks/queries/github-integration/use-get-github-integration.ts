import { useQuery } from "@tanstack/react-query";
import getGithubIntegration from "@/fetchers/github-integration/get-github-integration";
import { getShareCapability } from "@/components/share/share-capability";

function useGetGithubIntegration(projectId: string) {
  return useQuery({
    queryKey: ["github-integration", projectId],
    queryFn: () => getGithubIntegration(projectId),
    enabled: !!projectId && !getShareCapability(),
  });
}

export default useGetGithubIntegration;
