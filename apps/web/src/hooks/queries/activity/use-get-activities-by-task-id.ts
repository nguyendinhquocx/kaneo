import { useQuery } from "@tanstack/react-query";
import getActivitesByTaskId from "@/fetchers/activity/get-activites-by-task-id";
import { getShareFullTaskDetail } from "@/fetchers/share/share-full-api";
import { getShareCapability } from "@/components/share/share-capability";

function useGetActivitiesByTaskId(taskId: string) {
  return useQuery({
    queryKey: ["activities", taskId],
    queryFn: async () => {
      const capability = getShareCapability();
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
