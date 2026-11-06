import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import CalendarView, {
  CalendarHeaderActions,
} from "@/components/calendar/calendar-view";
import WorkspaceLayout from "@/components/common/workspace-layout";
import PageTitle from "@/components/page-title";
import useEmbeddedServicesConfig from "@/hooks/queries/embedded-integration/use-embedded-services-config";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/calendar",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation("embedded");
  const { workspaceId } = Route.useParams();
  const [frameKey, setFrameKey] = useState(0);
  const { data: services } = useEmbeddedServicesConfig(workspaceId);
  const calendar = services?.mitra;
  const headerActions =
    calendar?.enabled === true ? (
      <CalendarHeaderActions
        baseUrl={calendar.baseUrl}
        showReload={calendar.viewMode === "embedded"}
        onReload={() => setFrameKey((key) => key + 1)}
      />
    ) : null;

  return (
    <>
      <PageTitle title={t("calendarPageTitle")} />
      <WorkspaceLayout
        title={t("calendarPageTitle")}
        headerActions={headerActions}
        className="shrink-0"
      >
        <CalendarView workspaceId={workspaceId} frameKey={frameKey} />
      </WorkspaceLayout>
    </>
  );
}
