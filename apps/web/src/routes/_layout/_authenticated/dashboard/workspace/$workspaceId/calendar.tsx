import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import CalendarView from "@/components/calendar/calendar-view";
import WorkspaceLayout from "@/components/common/workspace-layout";
import PageTitle from "@/components/page-title";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/calendar",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation("embedded");
  const { workspaceId } = Route.useParams();

  return (
    <>
      <PageTitle title={t("calendarPageTitle")} />
      <WorkspaceLayout title={t("calendarPageTitle")}>
        <CalendarView workspaceId={workspaceId} />
      </WorkspaceLayout>
    </>
  );
}
