import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import getMindMapBinding from "@/fetchers/embedded-integration/get-mind-map";

function useMindMapBinding(projectId: string | undefined) {
  return useQuery({
    queryKey: ["mind-map-binding", projectId],
    queryFn: () => getMindMapBinding(projectId as string),
    enabled: !!projectId && !getShareCapability(),
  });
}

export default useMindMapBinding;
