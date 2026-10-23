import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateTaskTitle from "@/fetchers/task/update-task-title";
import { updateShareFullTask } from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";
import type getTaskRelations from "@/fetchers/task-relation/get-task-relations";
import type Task from "@/types/task";

export function useUpdateTaskTitle() {
  const queryClient = useQueryClient();

  return useMutation<Task, Error, Task>({
    mutationFn: (task: Task) => {
      const capability = getShareCapability();
      if (capability) {
        return updateShareFullTask(capability.token, task.id, {
          title: task.title,
        }) as unknown as Promise<Task>;
      }
      return updateTaskTitle(task.id, task) as unknown as Promise<Task>;
    },
    onSuccess: (updatedTask, variables) => {
      invalidateShareQueries(queryClient);
      const title = updatedTask.title || variables.title;
      queryClient.setQueryData<Task>(["task", variables.id], (current) =>
        current ? { ...current, title } : current,
      );
      queryClient.setQueriesData<Awaited<ReturnType<typeof getTaskRelations>>>(
        { queryKey: ["task-relations"] },
        (relations) =>
          relations?.map((relation) => ({
            ...relation,
            sourceTask:
              relation.sourceTask?.id === variables.id
                ? { ...relation.sourceTask, title }
                : relation.sourceTask,
            targetTask:
              relation.targetTask?.id === variables.id
                ? { ...relation.targetTask, title }
                : relation.targetTask,
          })),
      );
      queryClient.invalidateQueries({
        queryKey: ["task", variables.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["tasks", variables.projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["task-relations"],
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
    },
  });
}
