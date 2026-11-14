import { useQuery } from "@tanstack/react-query";
import { getCommentDeliveryStatus } from "@/fetchers/agent-session/comment-delivery";

export function useGetCommentDeliveryStatus(
  bindingId: string | undefined,
  deliveryId: string | undefined,
) {
  return useQuery({
    queryKey: ["agent-session-delivery", bindingId, deliveryId],
    queryFn: () => getCommentDeliveryStatus(bindingId!, deliveryId!),
    enabled: Boolean(bindingId && deliveryId),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.state === "queued" || query.state.data?.state === "claimed"
        ? 5_000
        : false,
    refetchOnWindowFocus: true,
  });
}
