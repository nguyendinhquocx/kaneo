import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import getActivitesByTaskId from "@/fetchers/activity/get-activites-by-task-id";
import { getShareFullTaskDetail } from "@/fetchers/share/share-full-api";

function useGetActivitiesByTaskId(taskId: string) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? ["share-full", capability.token, "task", taskId, "activities"]
      : ["activities", taskId],
    enabled: Boolean(taskId),
    refetchInterval: capability ? 10_000 : false,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      if (capability) {
        // Guest visibility: comments only, attributed via the share link.
        // Execution-linked tasks hide their timeline server-side.
        const detail = await getShareFullTaskDetail(capability.token, taskId);
        return detail.comments.map((comment) => ({
          id: comment.id,
          taskId,
          type: "comment",
          content: comment.content,
          createdAt: comment.createdAt,
          userId: null,
          externalUserName: comment.authorName,
          externalSource: comment.isGuest ? "share-link" : null,
          user: {
            name: comment.authorName,
            image: comment.authorImage,
          },
        }));
      }
      return getActivitesByTaskId({ taskId });
    },
  });
}

export default useGetActivitiesByTaskId;
