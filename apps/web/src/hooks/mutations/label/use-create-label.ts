import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateLabelRequest } from "@/fetchers/label/create-label";
import createLabel from "@/fetchers/label/create-label";
import { createShareFullLabel } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";
import { addLabelToTaskInTasksCache } from "./sync-task-labels-cache";

function useCreateLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateLabelRequest) => {
      const capability = getShareCapability();
      if (capability) {
        // Labels are per-task rows scoped by taskId — the share route
        // verifies the task lives in the linked project.
        return createShareFullLabel(capability.token, input.taskId ?? "", {
          name: input.name,
          color: input.color,
        }) as unknown as ReturnType<typeof createLabel>;
      }
      return createLabel(input);
    },
    onSuccess: (createdLabel, variables: CreateLabelRequest) => {
      invalidateShareQueries(queryClient);
      if (getShareCapability()) return;
      queryClient.setQueryData(
        ["labels", variables.workspaceId],
        (existingLabels: Array<typeof createdLabel> | undefined) => {
          if (!existingLabels) return [createdLabel];

          const alreadyExists = existingLabels.some(
            (label) => label.id === createdLabel.id,
          );

          return alreadyExists
            ? existingLabels
            : [...existingLabels, createdLabel];
        },
      );

      if (createdLabel.taskId) {
        queryClient.setQueryData(
          ["labels", createdLabel.taskId],
          (existingLabels: Array<typeof createdLabel> | undefined) => {
            if (!existingLabels) return [createdLabel];

            const alreadyExists = existingLabels.some(
              (label) => label.id === createdLabel.id,
            );

            return alreadyExists
              ? existingLabels
              : [...existingLabels, createdLabel];
          },
        );

        addLabelToTaskInTasksCache(queryClient, createdLabel.taskId, {
          id: createdLabel.id,
          name: createdLabel.name,
          color: createdLabel.color,
        });
      }

      void queryClient.invalidateQueries({
        queryKey: ["labels", variables.workspaceId],
      });

      if (createdLabel.taskId) {
        void queryClient.invalidateQueries({
          queryKey: ["labels", createdLabel.taskId],
        });
      }
    },
  });
}

export default useCreateLabel;
