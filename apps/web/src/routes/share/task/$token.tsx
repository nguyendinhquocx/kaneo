import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import TaskShareReader from "@/components/share/task-share-reader";
import {
  ShareCapabilityProvider,
  setShareCapabilityProjectId,
} from "@/components/share/share-capability";
import ShareLinkState from "@/components/share/share-link-state";
import {
  getTaskShareRoot,
  type TaskShareRootPayload,
} from "@/fetchers/share/share-task-api";
import {
  getShareRequestErrorKind,
  ShareRequestError,
} from "@/fetchers/share/share-request-error";

// SPEC-2026-11-10-kaneo-card-agent-collaboration T3: guest task root route.
// The link grants exactly one card and its live subtask tree — no board,
// no sidebar, no navigation that leaves the tree. Authorization is the
// bearer token; the page sends no credentials and no referrer.

export const Route = createFileRoute("/share/task/$token")({
  component: ShareTaskRoute,
});

function ShareTaskRoute() {
  const { token } = Route.useParams();
  const share = useQuery({
    queryKey: ["share-task", token, "root"],
    queryFn: () => getTaskShareRoot(token),
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

  const payload: TaskShareRootPayload = share.data;
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
          card={payload.root}
          subtasks={payload.subtasks}
          comments={payload.commentsPage.items}
          parent={null}
          statusOptions={payload.statusOptions ?? []}
          onRefresh={() => void share.refetch()}
        />
      </div>
    </ShareCapabilityProvider>
  );
}
