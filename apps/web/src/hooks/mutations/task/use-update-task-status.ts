import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateTaskStatus from "@/fetchers/task/update-task-status";
import { updateShareFullTask } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";
import type Task from "@/types/task";

export function useUpdateTaskStatus() {
  const queryClient = useQueryClient();

  return useMutation<Task, Error, Task>({
    mutationFn: (task: Task) => {
      const capability = getShareCapability();
      if (capability) {
        return updateShareFullTask(capability.token, task.id, {
          status: task.status,
        }) as unknown as Promise<Task>;
      }
      return updateTaskStatus(task.id, task) as unknown as Promise<Task>;
    },
    onSuccess: (_, variables) => {
      invalidateShareQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: ["task", variables.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["tasks", variables.projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["notifications"],
      });
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      queryClient.invalidateQueries({
        queryKey: ["activities", variables.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["task-relations"],
      });
    },
  });
}
