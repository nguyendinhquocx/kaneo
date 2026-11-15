import { useQuery } from "@tanstack/react-query";
import getLabelsByTask from "@/fetchers/label/get-labels-by-task";
import { getShareFullTaskDetail } from "@/fetchers/share/share-full-api";
import { getTaskShareSubtree } from "@/fetchers/share/share-task-api";
import { getShareCapability } from "@/components/share/share-capability";

function useGetLabelsByTask(taskId: string, enabled = true) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? capability.resourceType === "task"
        ? ["share-task", capability.token, "task", taskId, "labels"]
        : ["share-full", capability.token, "task", taskId, "labels"]
      : ["labels", taskId],
    queryFn: () => {
      if (capability?.resourceType === "task") {
        return getTaskShareSubtree(capability.token, taskId).then((detail) =>
          detail.task.labels.map((label) => ({
            ...label,
            color: label.color ?? "",
          })),
        );
      }
      if (capability?.resourceType === "project") {
        return getShareFullTaskDetail(capability.token, taskId).then(
          (detail) =>
            detail.labels.map((label) => ({
              ...label,
              color: label.color ?? "",
            })),
        );
      }
      return getLabelsByTask({ taskId });
    },
    refetchOnMount: true,
    enabled: Boolean(taskId) && enabled,
  });
}

export default useGetLabelsByTask;
