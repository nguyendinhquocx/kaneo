import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateTaskTitle from "@/fetchers/task/update-task-title";
import type getTaskRelations from "@/fetchers/task-relation/get-task-relations";
import type Task from "@/types/task";

export function useUpdateTaskTitle() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (task: Task) => updateTaskTitle(task.id, task),
    onSuccess: (updatedTask, variables) => {
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
