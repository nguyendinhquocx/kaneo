import { ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import EmbeddedFrame from "@/components/embedded/embedded-frame";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import useEmbeddedServicesConfig from "@/hooks/queries/embedded-integration/use-embedded-services-config";

type CalendarViewProps = {
  workspaceId: string;
};

export default function CalendarView({ workspaceId }: CalendarViewProps) {
  const { t } = useTranslation("embedded");
  const [frameKey, setFrameKey] = useState(0);
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
        <p className="text-sm text-muted-foreground">{t("calendarDisabled")}</p>
      </div>
    );
  }

  if (mitra.viewMode === "open-only") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-sm text-muted-foreground">
          {t("calendarOpenOnlyNotice")}
        </p>
        <Button
          className="pointer-coarse:min-h-11"
          render={
            <a href={mitra.baseUrl} target="_blank" rel="noopener noreferrer" />
          }
        >
          <ExternalLink className="size-4" />
          {t("openExternally")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-end gap-1.5 border-b border-border/60 px-2 py-1.5">
        <span className="mr-auto text-xs text-muted-foreground">
          {t("embeddedNotice")}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="pointer-coarse:min-h-11"
          render={
            <a href={mitra.baseUrl} target="_blank" rel="noopener noreferrer" />
          }
        >
          <ExternalLink className="size-3.5" />
          {t("openExternallyForLogin")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="pointer-coarse:min-h-11"
          onClick={() => setFrameKey((key) => key + 1)}
        >
          <RefreshCw className="size-3.5" />
          {t("reload")}
        </Button>
      </div>
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
