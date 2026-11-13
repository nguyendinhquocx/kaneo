import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import TaskShareReader from "@/components/share/task-share-reader";
import {
  ShareCapabilityProvider,
  setShareCapabilityProjectId,
} from "@/components/share/share-capability";
import ShareLinkState from "@/components/share/share-link-state";
import {
  getTaskShareSubtree,
  type TaskShareSubtreePayload,
} from "@/fetchers/share/share-task-api";
import {
  getShareRequestErrorKind,
  ShareRequestError,
} from "@/fetchers/share/share-request-error";

// SPEC-2026-11-10 T3: guest task subtree route — /share/task/:token/task/:taskId
// opens the root OR any child inside the same capability. Only subtree
// content renders; the parent breadcrumb links back inside the tree and
// out-of-tree ids fail closed with the generic 404 shape.

export const Route = createFileRoute("/share/task/$token/task/$taskId")({
  component: ShareTaskSubtreeRoute,
});

function ShareTaskSubtreeRoute() {
  const { token, taskId } = Route.useParams();
  const share = useQuery({
    queryKey: ["share-task", token, "task", taskId],
    queryFn: () => getTaskShareSubtree(token, taskId),
    retry: (failureCount, error) =>
      !(error instanceof ShareRequestError && error.kind !== "error") &&
      failureCount < 2,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  if (share.isLoading || share.isFetching) {
    return <ShareLinkState kind="loading" />;
  }
  if (share.isError) {
    return (
      <ShareLinkState
        kind={getShareRequestErrorKind(share.error)}
        onRetry={() => void share.refetch()}
      />
    );
  }
  if (!share.data) {
    return <ShareLinkState kind="invalid" />;
  }

  const payload: TaskShareSubtreePayload = share.data;
  setShareCapabilityProjectId(payload.scopeProjectId);

  return (
    <ShareCapabilityProvider
      token={token}
      projectId={payload.scopeProjectId}
      resourceType="task"
      permission={payload.permission}
      rootTaskId={payload.rootTaskId}
    >
      <div className="h-svh overflow-y-auto">
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="no-referrer" />
        <TaskShareReader
          token={token}
          projectId={payload.scopeProjectId}
          rootTaskId={payload.rootTaskId}
          permission={payload.permission}
          card={payload.task}
          subtasks={payload.subtasks}
          subtaskRelations={payload.subtaskRelations ?? []}
          comments={payload.commentsPage.items}
          parent={payload.parent}
          statusOptions={payload.statusOptions ?? []}
          onRefresh={() => void share.refetch()}
        />
      </div>
    </ShareCapabilityProvider>
  );
}
