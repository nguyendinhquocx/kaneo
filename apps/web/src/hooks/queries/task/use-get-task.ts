import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import { getShareFullTaskDetail } from "@/fetchers/share/share-full-api";
import getTask from "@/fetchers/task/get-task";
import type Task from "@/types/task";

function useGetTask(taskId: string) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? ["share-full", capability.token, "task", taskId]
      : ["task", taskId],
    queryFn: async (): Promise<Task> => {
      if (capability) {
        const detail = await getShareFullTaskDetail(capability.token, taskId);
        // Capability detail maps onto the owner Task shape so the same
        // detail components render without a second implementation.
        return {
          id: detail.id,
          title: detail.title,
          number: detail.number,
          description: detail.description,
          status: detail.status,
          priority: detail.priority,
          startDate: detail.startDate ? detail.startDate.toString() : null,
          dueDate: detail.dueDate ? detail.dueDate.toString() : null,
          position: detail.position,
          createdAt: detail.createdAt.toString(),
          userId: detail.assigneeId,
          assigneeId: detail.assigneeId,
          assigneeName: null,
          projectId: detail.projectId,
          labels: detail.labels.map((label) => ({
            id: label.id,
            name: label.name,
            color: label.color ?? "",
          })),
        };
      }
      return getTask(taskId);
    },
    enabled: Boolean(taskId),
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: capability
      ? (query) => (query.state.error ? false : 10_000)
      : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: capability ? false : undefined,
  });
}

export default useGetTask;
