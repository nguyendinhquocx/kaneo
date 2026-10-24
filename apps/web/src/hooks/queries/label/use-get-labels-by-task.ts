import { useQuery } from "@tanstack/react-query";
import getLabelsByTask from "@/fetchers/label/get-labels-by-task";
import { getShareFullTaskDetail } from "@/fetchers/share/share-full-api";
import { getShareCapability } from "@/components/share/share-capability";

function useGetLabelsByTask(taskId: string) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? ["share-full", capability.token, "task", taskId, "labels"]
      : ["labels", taskId],
    queryFn: () => {
      if (capability) {
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
    enabled: Boolean(taskId),
  });
}

export default useGetLabelsByTask;
