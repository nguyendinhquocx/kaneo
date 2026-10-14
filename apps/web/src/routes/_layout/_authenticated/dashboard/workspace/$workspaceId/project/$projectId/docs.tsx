import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import ProjectLayout from "@/components/common/project-layout";
import DocumentWorkspace from "@/components/docs/document-workspace";
import DocumentsView from "@/components/docs/documents-view";
import PageTitle from "@/components/page-title";
import { useCreateDocument } from "@/hooks/queries/document/use-documents";
import useProjectStore from "@/store/project";

type DocsSearchParams = {
  doc?: string;
};

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/docs",
)({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): DocsSearchParams => ({
    doc: typeof search.doc === "string" ? search.doc : undefined,
  }),
});

function RouteComponent() {
  const { t } = useTranslation("documents");
  const { projectId, workspaceId } = Route.useParams();
  const { doc: documentId } = Route.useSearch();
  const navigate = useNavigate();
  const createDocument = useCreateDocument();
  const { project } = useProjectStore();

  const openDocument = useCallback(
    (id: string) => {
      navigate({
        to: ".",
        search: { doc: id },
      });
    },
    [navigate],
  );

  const backToList = useCallback(() => {
    navigate({
      to: ".",
      search: {},
    });
  }, [navigate]);

  const handleCreate = useCallback(async () => {
    const created = await createDocument.mutateAsync({
      projectId,
      title: t("untitled"),
      content: "",
    });
    openDocument(created.id);
  }, [createDocument, openDocument, projectId, t]);

  return (
    <ProjectLayout
      projectId={projectId}
      workspaceId={workspaceId}
      activeView="docs"
      showViewSwitcher={false}
    >
      <PageTitle title={`${project?.name ?? ""} — ${t("title")}`} hideAppName />
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {documentId ? (
          <DocumentWorkspace documentId={documentId} onBack={backToList} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DocumentsView
              projectId={projectId}
              onOpen={openDocument}
              onCreate={() => void handleCreate()}
            />
          </div>
        )}
      </div>
    </ProjectLayout>
  );
}
