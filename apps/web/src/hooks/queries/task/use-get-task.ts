import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import { getShareFullTaskDetail } from "@/fetchers/share/share-full-api";
import { getTaskShareSubtree } from "@/fetchers/share/share-task-api";
import getTask from "@/fetchers/task/get-task";
import type Task from "@/types/task";
import { ZERO_WORK_MARKER_COUNTS } from "@/lib/work-markers";

function useGetTask(taskId: string) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? capability.resourceType === "task"
        ? ["share-task", capability.token, "task", taskId]
        : ["share-full", capability.token, "task", taskId]
      : ["task", taskId],
    queryFn: async (): Promise<Task> => {
      if (capability?.resourceType === "task") {
        const { task: card } = await getTaskShareSubtree(capability.token, taskId);
        return {
          id: card.id,
          title: card.title,
          number: card.number,
          description: card.description,
          status: card.status,
          priority: card.priority,
          startDate: card.startDate,
          dueDate: card.dueDate,
          position: 0,
          createdAt: new Date().toISOString(),
          userId: null,
          assigneeId: null,
          assigneeName: null,
          workMarkerCounts: card.workMarkerCounts,
          contentRevision: card.contentRevision,
          projectId: capability.projectId,
          labels: card.labels.map((label) => ({
            id: label.id,
            name: label.name,
            color: label.color ?? "",
          })),
        };
      }
      if (capability?.resourceType === "project") {
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
          // Guest payloads carry no marker data — map to zero counts.
          workMarkerCounts: { ...ZERO_WORK_MARKER_COUNTS },
          // SPEC-2026-11-10 T3: guest writers need the content CAS token.
          contentRevision: detail.contentRevision,
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
