import { useQuery } from "@tanstack/react-query";
import getTask from "@/fetchers/task/get-task";
import { getShareFullTaskDetail } from "@/fetchers/share/share-full-api";
import { getShareCapability } from "@/components/share/share-capability";
import type Task from "@/types/task";

function useGetTask(taskId: string) {
  return useQuery({
    queryKey: ["task", taskId],
    queryFn: async (): Promise<Task> => {
      const capability = getShareCapability();
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
    staleTime: 0,
  });
}

export default useGetTask;
