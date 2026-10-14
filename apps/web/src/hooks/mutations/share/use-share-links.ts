import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
} from "@/fetchers/share/share-api";

export type ShareResourceType = "project" | "document" | "goal";

export function useGetShareLinks(
  resourceType: ShareResourceType,
  resourceId: string | null,
  includeRevoked = false,
) {
  return useQuery({
    queryKey: ["share-links", resourceType, resourceId, includeRevoked],
    queryFn: () =>
      listShareLinks({
        resourceType,
        resourceId: resourceId as string,
        includeRevoked,
      }),
    enabled: Boolean(resourceId),
  });
}

export function useCreateShareLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createShareLink,
    onSuccess: (created) => {
      queryClient.invalidateQueries({
        queryKey: ["share-links", created.resourceType, created.resourceId],
      });
    },
  });
}

export function useRevokeShareLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeShareLink,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["share-links"] });
    },
  });
}
