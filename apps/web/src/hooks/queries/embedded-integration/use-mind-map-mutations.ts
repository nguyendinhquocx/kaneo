import { useMutation, useQueryClient } from "@tanstack/react-query";
import linkMindMap from "@/fetchers/embedded-integration/link-mind-map";
import unlinkMindMap from "@/fetchers/embedded-integration/unlink-mind-map";

export function useLinkMindMap(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mapId: string) => linkMindMap({ projectId, mapId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["mind-map-binding", projectId],
      });
    },
  });
}

export function useUnlinkMindMap(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => unlinkMindMap(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["mind-map-binding", projectId],
      });
    },
  });
}
