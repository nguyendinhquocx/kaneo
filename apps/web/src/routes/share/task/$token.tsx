import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import TaskShareBoard from "@/components/share/task-share-board";
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

// R1-T2: render the authorized root card in the real Kaneo board surface;
// only this task appears, while the task capability still fences all data.

export const Route = createFileRoute("/share/task/$token")({
  component: ShareTaskRoute,
});

function ShareTaskRoute() {
  const { token } = Route.useParams();
  const matchRoute = useMatchRoute();
  const isTaskDetail = matchRoute({
    to: "/share/task/$token/task/$taskId",
    fuzzy: false,
  });

  const share = useQuery({
    queryKey: ["share-task", token, "root"],
    queryFn: () => getTaskShareRoot(token),
    enabled: !isTaskDetail,
    retry: (failureCount, error) =>
      !(error instanceof ShareRequestError && error.kind !== "error") &&
      failureCount < 2,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  // File-based routing nests /task/$taskId under this token route. Render the
  // child route alone instead of leaving the landing board mounted above it.
  if (isTaskDetail) return <Outlet />;

  // R3: background refetches (e.g. after a drag) must not flash the whole
  // route into a loading screen; only show it before any data exists.
  if (share.isPending) {
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
      <TaskShareBoard token={token} payload={payload} />
    </ShareCapabilityProvider>
  );
}
