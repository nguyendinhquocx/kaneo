import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import WorkspaceLayout from "@/components/common/workspace-layout";
import GoalsMatrix from "@/components/goals/goals-matrix";
import PageTitle from "@/components/page-title";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/goals",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation("goals");
  const { workspaceId } = Route.useParams();

  return (
    <>
      <PageTitle title={t("pageTitle")} />
      <WorkspaceLayout title={t("pageTitle")}>
        <GoalsMatrix workspaceId={workspaceId} />
      </WorkspaceLayout>
    </>
  );
}
