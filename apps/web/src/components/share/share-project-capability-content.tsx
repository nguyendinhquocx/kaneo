import { useState, type ReactNode } from "react";
import ShareLinkState from "@/components/share/share-link-state";
import ShareProjectSurface from "@/components/share/share-project-surface";
import { getShareRequestErrorKind } from "@/fetchers/share/share-request-error";
import { useGetTasks } from "@/hooks/queries/task/use-get-tasks";
import type { ProjectWithTasks } from "@/types/project";

type ShareProjectCapabilityContentProps = {
  token: string;
  projectId: string;
  initialProject: ProjectWithTasks;
  initialView?: "backlog" | "board" | "gantt" | "docs";
  children?: ReactNode;
  taskDetails?: ReactNode;
};

// The board and task sheet share one authorization state. If a later project
// poll is rejected, unmount every surface so a task cannot remain visible
// from its React Query cache after the link expires or is revoked.
export default function ShareProjectCapabilityContent({
  token,
  projectId,
  initialProject,
  initialView,
  children,
  taskDetails,
}: ShareProjectCapabilityContentProps) {
  const [retrying, setRetrying] = useState(false);
  const {
    data: project,
    isLoading,
    isError,
    error,
    refetch,
  } = useGetTasks(projectId, initialProject);

  const retry = async () => {
    setRetrying(true);
    try {
      await refetch();
    } finally {
      setRetrying(false);
    }
  };

  if (isError) {
    return (
      <ShareLinkState
        kind={getShareRequestErrorKind(error)}
        onRetry={() => void retry()}
      />
    );
  }
  if (isLoading || retrying || !project) {
    return <ShareLinkState kind="loading" />;
  }

  return (
    <>
      <ShareProjectSurface
        token={token}
        projectId={projectId}
        project={project}
        initialView={initialView}
      >
        {children}
      </ShareProjectSurface>
      {taskDetails}
    </>
  );
}
