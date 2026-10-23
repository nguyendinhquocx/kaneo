import { useMutation, useQueryClient } from "@tanstack/react-query";
import deleteLabel from "@/fetchers/label/delete-label";
import { deleteShareFullLabel } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";
import { removeLabelFromTaskInTasksCache } from "./sync-task-labels-cache";

function useDeleteLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string }) => {
      const capability = getShareCapability();
      if (capability) {
        return deleteShareFullLabel(
          capability.token,
          input.id,
        ) as unknown as ReturnType<typeof deleteLabel>;
      }
      return deleteLabel(input);
    },
    onSuccess: (deletedLabel) => {
      invalidateShareQueries(queryClient);
      if (getShareCapability()) return;
      queryClient.setQueryData(
        ["labels", deletedLabel.workspaceId],
        (existingLabels: Array<typeof deletedLabel> | undefined) =>
          existingLabels?.filter((label) => label.id !== deletedLabel.id) ?? [],
      );

      if (deletedLabel.taskId) {
        queryClient.setQueryData(
          ["labels", deletedLabel.taskId],
          (existingLabels: Array<typeof deletedLabel> | undefined) =>
            existingLabels?.filter((label) => label.id !== deletedLabel.id) ??
            [],
        );

        removeLabelFromTaskInTasksCache(
          queryClient,
          deletedLabel.taskId,
          deletedLabel.id,
        );
      }

      void queryClient.invalidateQueries({
        queryKey: ["labels", deletedLabel.workspaceId],
      });

      if (deletedLabel.taskId) {
        void queryClient.invalidateQueries({
          queryKey: ["labels", deletedLabel.taskId],
        });
      } else {
        void queryClient.invalidateQueries({
          queryKey: ["labels"],
        });
        void queryClient.invalidateQueries({
          queryKey: ["tasks"],
        });
      }
    },
  });
}

export default useDeleteLabel;
