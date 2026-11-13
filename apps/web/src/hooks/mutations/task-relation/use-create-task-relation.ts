import { useMutation, useQueryClient } from "@tanstack/react-query";
import createTaskRelation from "@/fetchers/task-relation/create-task-relation";
import { createShareFullRelation } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";
import type Task from "@/types/task";
import { getExpectedContentRevision } from "@/lib/task-content-revision";

function useCreateTaskRelation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      sourceTaskId: string;
      targetTaskId: string;
      relationType: "subtask" | "blocks" | "related";
    }) => {
      const capability = getShareCapability();
      if (capability) {
        // Both endpoints are proven inside the linked project server-side.
        return createShareFullRelation(capability.token, input.sourceTaskId, {
          targetTaskId: input.targetTaskId,
          relationType: input.relationType,
        }) as unknown as ReturnType<typeof createTaskRelation>;
      }
      // SPEC-2026-11-10 T3: a subtask edge changes the parent card's
      // subtask structure, so the create is CAS-guarded on the parent.
      const expectedParentContentRevision =
        input.relationType === "subtask"
          ? await queryClient
              .fetchQuery({
                queryKey: ["task", input.sourceTaskId],
                queryFn: () => Promise.resolve(undefined as Task | undefined),
                staleTime: 0,
              })
              .catch(() => undefined)
              .then(getExpectedContentRevision)
          : undefined;
      return createTaskRelation({ ...input, expectedParentContentRevision });
    },
    onSuccess: (_, variables) => {
      invalidateShareQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: ["task-relations", variables.sourceTaskId],
      });
      queryClient.invalidateQueries({
        queryKey: ["task-relations", variables.targetTaskId],
      });
    },
  });
}

export default useCreateTaskRelation;
