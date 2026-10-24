import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import DocumentWorkspace from "@/components/docs/document-workspace";
import DocumentsView from "@/components/docs/documents-view";
import ShareProjectRouteContent from "@/components/share/share-project-route-content";
import {
  getShareCapability,
  ShareCapabilityProvider,
} from "@/components/share/share-capability";
import ShareLinkState from "@/components/share/share-link-state";
import ShareProjectCapabilityContent from "@/components/share/share-project-capability-content";
import TaskDetailsSheet from "@/components/task/task-details-sheet";
import {
  getShareProjectPayload,
  type ShareProjectPayload,
} from "@/fetchers/share/share-public-api";
import {
  getShareRequestErrorKind,
  ShareRequestError,
} from "@/fetchers/share/share-request-error";
import { useCreateDocument } from "@/hooks/queries/document/use-documents";
import { mapShareFullProjectPayload } from "@/hooks/queries/task/use-get-tasks";

// This static route also matches existing /share/project/:token view/edit
// URLs. Resolve the server-owned scope before mounting any full-only hooks or
// controls; legacy permissions must keep their old reader.

type FullProjectSearchParams = {
  taskId?: string;
  doc?: string;
  view?: "backlog" | "board" | "gantt" | "docs";
};

export const Route = createFileRoute("/share/project/$token/")({
  component: ShareProjectRoute,
  validateSearch: (
    search: Record<string, unknown>,
  ): FullProjectSearchParams => ({
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
    doc: typeof search.doc === "string" ? search.doc : undefined,
    view:
      search.view === "backlog" ||
      search.view === "gantt" ||
      search.view === "docs"
        ? search.view
        : "board",
  }),
});

function ShareProjectRoute() {
  const { token } = Route.useParams();
  const { view } = Route.useSearch();
  const share = useQuery({
    queryKey: ["share-project-route", token],
    queryFn: () => getShareProjectPayload(token),
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
    return <ShareLinkState kind="error" onRetry={() => void share.refetch()} />;
  }

  return (
    <ShareProjectRouteContent
      token={token}
      data={share.data}
      fullSurface={(payload) => (
        <FullProjectSurface
          token={token}
          payload={payload}
          initialView={view}
        />
      )}
    />
  );
}

function FullProjectSurface({
  token,
  payload,
  initialView = "board",
}: {
  token: string;
  payload: Extract<ShareProjectPayload, { scope: "full" }>;
  initialView?: FullProjectSearchParams["view"];
}) {
  const { t } = useTranslation("documents");
  const { taskId, doc: documentId } = Route.useSearch();
  const navigate = useNavigate();
  const createDocument = useCreateDocument();
  const initialProject = mapShareFullProjectPayload(payload);

  const openTask = useCallback(
    (nextTaskId?: string) =>
      navigate({
        to: ".",
        search: (prev: FullProjectSearchParams) => ({
          ...prev,
          taskId: nextTaskId,
        }),
      }),
    [navigate],
  );

  const openDocument = useCallback(
    (nextDocId: string) =>
      navigate({
        to: ".",
        search: (prev: FullProjectSearchParams) => ({
          ...prev,
          doc: nextDocId,
          view: "docs",
        }),
      }),
    [navigate],
  );

  const backToList = useCallback(
    () =>
      navigate({
        to: ".",
        search: (prev: FullProjectSearchParams) => ({
          ...prev,
          doc: undefined,
        }),
      }),
    [navigate],
  );

  const handleCreate = useCallback(async () => {
    const created = await createDocument.mutateAsync({
      projectId: getShareCapability()?.projectId ?? payload.id,
      title: t("untitled"),
      content: "",
    });
    openDocument(created.id);
  }, [createDocument, openDocument, payload.id, t]);

  return (
    <ShareCapabilityProvider token={token} projectId={payload.id}>
      <ShareProjectCapabilityContent
        token={token}
        projectId={payload.id}
        initialProject={initialProject}
        initialView={initialView}
        taskDetails={
          taskId ? (
            <TaskDetailsSheet
              taskId={taskId}
              projectId={payload.id}
              workspaceId=""
              onClose={() => openTask(undefined)}
            />
          ) : null
        }
      >
        {documentId ? (
          <DocumentWorkspace documentId={documentId} onBack={backToList} />
        ) : (
          <DocumentsView
            projectId={getShareCapability()?.projectId ?? payload.id}
            onOpen={openDocument}
            onCreate={handleCreate}
          />
        )}
      </ShareProjectCapabilityContent>
    </ShareCapabilityProvider>
  );
}
