import { useMutation, useQueryClient } from "@tanstack/react-query";
import deleteTaskRelation from "@/fetchers/task-relation/delete-task-relation";
import { deleteShareFullRelation } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";

function useDeleteTaskRelation(taskId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => {
      const capability = getShareCapability();
      if (capability) {
        return deleteShareFullRelation(
          capability.token,
          id,
        ) as unknown as ReturnType<typeof deleteTaskRelation>;
      }
      return deleteTaskRelation(id);
    },
    onSuccess: () => {
      invalidateShareQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: ["task-relations", taskId],
      });
    },
  });
}

export default useDeleteTaskRelation;
