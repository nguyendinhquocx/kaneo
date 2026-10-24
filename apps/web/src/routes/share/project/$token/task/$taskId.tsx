import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ShareCapabilityProvider,
  setShareCapabilityProjectId,
} from "@/components/share/share-capability";
import ShareLinkState from "@/components/share/share-link-state";
import TaskDetailsContent from "@/components/task/task-details-content";
import TaskPropertiesSidebar from "@/components/task/task-properties-sidebar";
import {
  getShareProjectPayload,
  isFullProjectShare,
} from "@/fetchers/share/share-public-api";
import {
  getShareRequestErrorKind,
  ShareRequestError,
} from "@/fetchers/share/share-request-error";
import useGetTask from "@/hooks/queries/task/use-get-task";

// SPEC-2026-10-22: share-scoped full-page task route. Maximize and
// parent-task navigation land here — never on an authenticated dashboard
// URL, never on another project.

export const Route = createFileRoute("/share/project/$token/task/$taskId")({
  component: ShareTaskFullPage,
});

function ShareTaskFullPage() {
  const { token, taskId } = Route.useParams();
  const access = useQuery({
    queryKey: ["share-project-route", token],
    queryFn: () => getShareProjectPayload(token),
    retry: (failureCount, error) =>
      !(error instanceof ShareRequestError && error.kind !== "error") &&
      failureCount < 2,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  if (access.isLoading || access.isFetching) {
    return <ShareLinkState kind="loading" />;
  }
  if (access.isError) {
    return (
      <ShareLinkState
        kind={getShareRequestErrorKind(access.error)}
        onRetry={() => void access.refetch()}
      />
    );
  }
  if (!access.data || !isFullProjectShare(access.data)) {
    return <ShareLinkState kind="invalid" />;
  }

  return (
    <ShareCapabilityProvider token={token} projectId={access.data.id}>
      <ShareTaskContent
        token={token}
        taskId={taskId}
        projectId={access.data.id}
      />
    </ShareCapabilityProvider>
  );
}

function ShareTaskContent({
  token,
  taskId,
  projectId,
}: {
  token: string;
  taskId: string;
  projectId: string;
}) {
  const { t } = useTranslation("share");
  const navigate = useNavigate();
  const [hasInitialTaskFetch, setHasInitialTaskFetch] = useState(false);
  const {
    data: task,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useGetTask(taskId);

  useEffect(() => {
    if (!isFetching && !isLoading) {
      setHasInitialTaskFetch(true);
    }
  }, [isFetching, isLoading]);
  useEffect(() => {
    if (task?.projectId === projectId) {
      setShareCapabilityProjectId(task.projectId);
    }
  }, [projectId, task?.projectId]);

  if (isError) {
    return (
      <ShareLinkState
        kind={getShareRequestErrorKind(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (isLoading || !hasInitialTaskFetch) {
    return <ShareLinkState kind="loading" />;
  }
  if (!task || task.projectId !== projectId) {
    return <ShareLinkState kind="invalid" />;
  }

  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <header className="flex h-11 shrink-0 items-center gap-2 border-border/80 border-b px-3">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() =>
            navigate({ to: "/share/project/$token", params: { token } })
          }
        >
          <ArrowLeft className="size-3.5" />
          {t("full.view.board")}
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 lg:flex-row">
        <TaskPropertiesSidebar
          taskId={taskId}
          projectId={task.projectId}
          workspaceId=""
          className="w-full shrink-0 lg:w-72"
        />
        <TaskDetailsContent
          taskId={taskId}
          projectId={task.projectId}
          workspaceId=""
          className="min-w-0 flex-1"
        />
      </div>
    </div>
  );
}
