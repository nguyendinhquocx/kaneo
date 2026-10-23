import { useMutation, useQueryClient } from "@tanstack/react-query";
import deleteTask from "@/fetchers/task/delete-task";
import { deleteShareFullTask } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => {
      const capability = getShareCapability();
      if (capability) {
        return deleteShareFullTask(
          capability.token,
          taskId,
        ) as unknown as ReturnType<typeof deleteTask>;
      }
      return deleteTask(taskId);
    },
    onSuccess: () => {
      invalidateShareQueries(queryClient);
    },
  });
}
