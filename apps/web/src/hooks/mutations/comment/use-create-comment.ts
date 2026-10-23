import { useMutation, useQueryClient } from "@tanstack/react-query";
import createComment from "@/fetchers/comment/create-comment";
import { createShareFullComment } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";

function useCreateComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; comment: string }) => {
      const capability = getShareCapability();
      if (capability) {
        // Guest attribution stays link-scoped; no fake userId.
        return createShareFullComment(
          capability.token,
          input.taskId,
          input.comment,
        ) as unknown as ReturnType<typeof createComment>;
      }
      return createComment(input);
    },
    onSuccess: () => {
      invalidateShareQueries(queryClient);
    },
  });
}

export default useCreateComment;
