import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import { getShareFullTaskDetail } from "@/fetchers/share/share-full-api";
import { getTaskShareSubtree, type ShareTaskCard } from "@/fetchers/share/share-task-api";
import getTaskRelations from "@/fetchers/task-relation/get-task-relations";
import { ZERO_WORK_MARKER_COUNTS } from "@/lib/work-markers";

function withZeroMarkers<
  T extends {
    userId: string | null;
    assigneeName: string | null;
  },
>(task: T) {
  // Guest payloads never carry marker data — normalize to zero counts so
  // relation rows share the owner Task shape.
  return { ...task, workMarkerCounts: { ...ZERO_WORK_MARKER_COUNTS } };
}

function useGetTaskRelations(taskId: string) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? capability.resourceType === "task"
        ? ["share-task", capability.token, "task", taskId, "relations"]
        : ["share-full", capability.token, "task", taskId, "relations"]
      : ["task-relations", taskId],
    queryFn: async () => {
      if (capability?.resourceType === "task") {
        const detail = await getTaskShareSubtree(capability.token, taskId);
        const toTask = (card: ShareTaskCard) => ({
          id: card.id,
          title: card.title,
          number: card.number,
          description: card.description,
          status: card.status,
          priority: card.priority,
          startDate: card.startDate,
          dueDate: card.dueDate,
          position: 0,
          createdAt: "",
          userId: null,
          assigneeId: null,
          assigneeName: null,
          projectId: capability.projectId,
          workMarkerCounts: card.workMarkerCounts,
          contentRevision: card.contentRevision,
          labels: card.labels.map((label) => ({ ...label, color: label.color ?? "" })),
        });
        const current = toTask(detail.task);
        const children = detail.subtasks.map((card, index) => {
          const relation = detail.subtaskRelations?.find(
            (edge) => edge.targetTaskId === card.id,
          );
          return {
            id: relation?.relationId ?? `share-read-${taskId}-${card.id}`,
            sourceTaskId: taskId,
            targetTaskId: card.id,
            relationType: "subtask",
            position: relation?.position ?? index,
            createdAt: "",
            sourceTask: current,
            targetTask: toTask(card),
          };
        });
        if (!detail.parent) return children;
        return [
          {
            id: `share-parent-${detail.parent.id}-${taskId}`,
            sourceTaskId: detail.parent.id,
            targetTaskId: taskId,
            relationType: "subtask",
            position: 0,
            createdAt: "",
            sourceTask: {
              ...current,
              id: detail.parent.id,
              title: detail.parent.title,
              contentRevision: undefined,
            },
            targetTask: current,
          },
          ...children,
        ];
      }
      if (capability?.resourceType === "project") {
        return getShareFullTaskDetail(capability.token, taskId).then((detail) =>
          detail.relations
            .filter((relation) => relation.sourceTask && relation.targetTask)
            .map((relation) => ({
              id: relation.id,
              sourceTaskId: relation.sourceTaskId,
              targetTaskId: relation.targetTaskId,
              relationType: relation.relationType,
              position: relation.position ?? 0,
              createdAt: "",
              sourceTask: withZeroMarkers(relation.sourceTask!),
              targetTask: withZeroMarkers(relation.targetTask!),
            })),
        );
      }
      return getTaskRelations(taskId);
    },
    enabled: Boolean(taskId),
    refetchInterval: capability
      ? (query) => (query.state.error ? false : 10_000)
      : false,
    retry: capability ? false : undefined,
  });
}

export default useGetTaskRelations;
