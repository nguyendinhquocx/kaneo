import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import { getShareFullTaskDetail } from "@/fetchers/share/share-full-api";
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
      ? ["share-full", capability.token, "task", taskId, "relations"]
      : ["task-relations", taskId],
    queryFn: () => {
      if (capability) {
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
