import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import getEmbeddedServicesConfig from "@/fetchers/embedded-integration/get-workspace-config";

function useEmbeddedServicesConfig(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["embedded-services-config", workspaceId],
    queryFn: () => getEmbeddedServicesConfig(workspaceId as string),
    enabled: !!workspaceId && !getShareCapability(),
  });
}

export default useEmbeddedServicesConfig;
