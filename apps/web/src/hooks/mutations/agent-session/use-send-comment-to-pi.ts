import { useMutation } from "@tanstack/react-query";
import { sendCommentToPi } from "@/fetchers/agent-session/comment-delivery";

export function useSendCommentToPi() {
  return useMutation({ mutationFn: sendCommentToPi });
}
