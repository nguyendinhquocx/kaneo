import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import ProjectLayout from "@/components/common/project-layout";
import MindMapView from "@/components/mindmap/mind-map-view";
import PageTitle from "@/components/page-title";
import useProjectStore from "@/store/project";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/mindmap",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation("embedded");
  const { projectId, workspaceId } = Route.useParams();
  const { project } = useProjectStore();

  return (
    <ProjectLayout
      projectId={projectId}
      workspaceId={workspaceId}
      activeView="mindmap"
    >
      <PageTitle
        title={`${project?.name ?? ""} — ${t("mindMapPageTitle")}`}
        hideAppName
      />
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <MindMapView projectId={projectId} workspaceId={workspaceId} />
      </div>
    </ProjectLayout>
  );
}
