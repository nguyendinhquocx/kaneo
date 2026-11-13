import { useMutation, useQueryClient } from "@tanstack/react-query";
import deleteTaskRelation from "@/fetchers/task-relation/delete-task-relation";
import { deleteShareFullRelation } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";
import type Task from "@/types/task";
import { getExpectedContentRevision } from "@/lib/task-content-revision";

function useDeleteTaskRelation(taskId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const capability = getShareCapability();
      if (capability) {
        return deleteShareFullRelation(
          capability.token,
          id,
        ) as unknown as ReturnType<typeof deleteTaskRelation>;
      }
      // SPEC-2026-11-10 T3: deleting a subtask edge CAS-guards the parent.
      const relations = queryClient.getQueryData<
        Array<{ id: string; relationType: string }>
      >(["task-relations", taskId]);
      const relation = relations?.find((candidate) => candidate.id === id);
      const expectedParentContentRevision =
        relation?.relationType === "subtask"
          ? await queryClient
              .fetchQuery({
                queryKey: ["task", taskId],
                queryFn: () => Promise.resolve(undefined as Task | undefined),
                staleTime: 0,
              })
              .catch(() => undefined)
              .then(getExpectedContentRevision)
          : undefined;
      return deleteTaskRelation(id, expectedParentContentRevision);
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
