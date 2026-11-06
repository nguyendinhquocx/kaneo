import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import EmbeddedFrame from "@/components/embedded/embedded-frame";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import useEmbeddedServicesConfig from "@/hooks/queries/embedded-integration/use-embedded-services-config";

type CalendarViewProps = {
  workspaceId: string;
  frameKey?: number;
};

type CalendarHeaderActionsProps = {
  baseUrl: string;
  showReload: boolean;
  onReload: () => void;
};

export function CalendarHeaderActions({
  baseUrl,
  showReload,
  onReload,
}: CalendarHeaderActionsProps) {
  const { t } = useTranslation("embedded");

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="ghost"
        size="xs"
        className="pointer-coarse:min-h-11"
        render={<a href={baseUrl} target="_blank" rel="noopener noreferrer" />}
      >
        {t("openCalendar")}
      </Button>
      {showReload && (
        <Button
          variant="ghost"
          size="xs"
          className="pointer-coarse:min-h-11"
          onClick={onReload}
        >
          {t("reload")}
        </Button>
      )}
    </div>
  );
}

export default function CalendarView({
  workspaceId,
  frameKey = 0,
}: CalendarViewProps) {
  const { t } = useTranslation("embedded");
  const {
    data: config,
    isLoading,
    isError,
    refetch,
  } = useEmbeddedServicesConfig(workspaceId);

  if (isLoading) {
    return (
      <div role="status" className="h-full w-full p-1">
        <span className="sr-only">{t("loading")}</span>
        <LoadingSkeleton className="h-full w-full" />
      </div>
    );
  }

  if (isError || !config) {
    return (
      <div
        role="status"
        className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center"
      >
        <p className="text-sm text-muted-foreground">{t("configError")}</p>
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:min-h-11"
          onClick={() => void refetch()}
        >
          <RefreshCw className="size-4" />
          {t("retry")}
        </Button>
      </div>
    );
  }

  const mitra = config.mitra;

  if (!mitra) {
    return (
      <div
        role="status"
        className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center"
      >
        <p className="text-sm text-muted-foreground">
          {t("settings.serviceNotConfigured")}
        </p>
      </div>
    );
  }

  if (!mitra.enabled) {
    return (
      <div
        role="status"
        className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center"
      >
        <p className="text-sm text-muted-foreground">
          {t("calendarDisabledByWorkspace")}
        </p>
      </div>
    );
  }

  if (mitra.viewMode === "open-only") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-sm text-muted-foreground">
          {t("calendarOpenOnlyNotice")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1">
        <EmbeddedFrame
          key={frameKey}
          src={mitra.baseUrl}
          title={t("calendarFrameTitle")}
          externalUrl={mitra.baseUrl}
          testId="calendar-embedded-frame"
        />
      </div>
    </div>
  );
}
