import { useQuery } from "@tanstack/react-query";
import getExternalLinks from "@/fetchers/external-link/get-external-links";
import { getShareCapability } from "@/components/share/share-capability";

function useExternalLinks(taskId: string) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: ["external-links", taskId],
    queryFn: () => getExternalLinks(taskId),
    enabled: !!taskId && !capability,
  });
}

export default useExternalLinks;
