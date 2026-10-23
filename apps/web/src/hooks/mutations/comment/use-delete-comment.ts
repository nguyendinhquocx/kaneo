import { useMutation, useQueryClient } from "@tanstack/react-query";
import deleteComment from "@/fetchers/comment/delete-comment";
import { deleteShareFullComment } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";

function useDeleteComment(taskId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { activityId: string }) => {
      const capability = getShareCapability();
      if (capability) {
        return deleteShareFullComment(
          capability.token,
          input.activityId,
        ) as unknown as ReturnType<typeof deleteComment>;
      }
      return deleteComment(input);
    },
    onSuccess: () => {
      invalidateShareQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: ["activities", taskId] });
    },
  });
}

export default useDeleteComment;
