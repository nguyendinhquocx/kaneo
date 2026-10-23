import { useMutation, useQueryClient } from "@tanstack/react-query";
import createTaskRelation from "@/fetchers/task-relation/create-task-relation";
import { createShareFullRelation } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";

function useCreateTaskRelation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
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
      return createTaskRelation(input);
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
