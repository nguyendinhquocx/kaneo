import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateComment from "@/fetchers/comment/update-comment";
import { updateShareFullComment } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";

function useUpdateComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { activityId: string; comment: string }) => {
      const capability = getShareCapability();
      if (capability) {
        return updateShareFullComment(
          capability.token,
          input.activityId,
          input.comment,
        ) as unknown as ReturnType<typeof updateComment>;
      }
      return updateComment(input);
    },
    onSuccess: () => {
      invalidateShareQueries(queryClient);
    },
  });
}

export default useUpdateComment;
