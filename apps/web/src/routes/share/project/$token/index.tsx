import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import DocumentWorkspace from "@/components/docs/document-workspace";
import DocumentsView from "@/components/docs/documents-view";
import { ShareCapabilityProvider, getShareCapability } from "@/components/share/share-capability";
import ShareProjectSurface from "@/components/share/share-project-surface";
import TaskDetailsSheet from "@/components/task/task-details-sheet";
import { useCreateDocument } from "@/hooks/queries/document/use-documents";

// SPEC-2026-10-22 full-project-share-link: the capability project surface.
// Owner components through the share transport; no login, no cookies.

type FullProjectSearchParams = {
  taskId?: string;
  doc?: string;
  view?: "backlog" | "board" | "gantt" | "docs";
};

export const Route = createFileRoute("/share/project/$token/")({
  component: FullProjectSurface,
  validateSearch: (search: Record<string, unknown>): FullProjectSearchParams => ({
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

function FullProjectSurface() {
  const { t } = useTranslation("documents");
  const { token } = Route.useParams();
  const { taskId, doc: documentId, view } = Route.useSearch();
  const navigate = useNavigate();
  const createDocument = useCreateDocument();

  const openTask = useCallback(
    (nextTaskId?: string) =>
      navigate({ to: ".", search: (prev: FullProjectSearchParams) => ({ ...prev, taskId: nextTaskId }) }),
    [navigate],
  );

  const openDocument = useCallback(
    (nextDocId: string) =>
      navigate({ to: ".", search: (prev: FullProjectSearchParams) => ({ ...prev, doc: nextDocId, view: "docs" }) }),
    [navigate],
  );

  const backToList = useCallback(
    () => navigate({ to: ".", search: (prev: FullProjectSearchParams) => ({ ...prev, doc: undefined }) }),
    [navigate],
  );

  const handleCreate = useCallback(async () => {
    const created = await createDocument.mutateAsync({
      projectId: getShareCapability()?.projectId ?? "",
      title: t("untitled"),
      content: "",
    });
    openDocument(created.id);
  }, [createDocument, openDocument, t]);

  return (
    <ShareCapabilityProvider token={token} projectId={""}>
      <ShareProjectSurface token={token} projectId={token} initialView={view}>
        {documentId ? (
          <DocumentWorkspace documentId={documentId} onBack={backToList} />
        ) : (
          <DocumentsView
            projectId={getShareCapability()?.projectId ?? token}
            onOpen={openDocument}
            onCreate={handleCreate}
          />
        )}
      </ShareProjectSurface>
      {taskId ? (
        <TaskDetailsSheet
          taskId={taskId}
          projectId={token}
          workspaceId=""
          onClose={() => openTask(undefined)}
        />
      ) : null}
    </ShareCapabilityProvider>
  );
}
