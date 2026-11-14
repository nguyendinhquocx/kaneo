import { useQuery } from "@tanstack/react-query";
import { getCommentDeliveryByComment } from "@/fetchers/agent-session/comment-delivery";

// Restores the last receipt for a comment after a page reload so the owner
// still sees queued/unknown state instead of a blank Send affordance.
export function useGetCommentDeliveryByComment(
  bindingId: string | undefined,
  commentId: string | undefined,
) {
  return useQuery({
    queryKey: ["agent-session-delivery-by-comment", bindingId, commentId],
    queryFn: () => getCommentDeliveryByComment(bindingId!, commentId!),
    enabled: Boolean(bindingId && commentId),
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });
}
