import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { Switch } from "@/components/ui/switch";
import useEmbeddedServicesConfig from "@/hooks/queries/embedded-integration/use-embedded-services-config";
import useSetEmbeddedServiceEnabled from "@/hooks/queries/embedded-integration/use-set-embedded-service-enabled";

type EmbeddedIntegrationsSettingsProps = {
  workspaceId: string;
};

export default function EmbeddedIntegrationsSettings({
  workspaceId,
}: EmbeddedIntegrationsSettingsProps) {
  const { t } = useTranslation("embedded");
  const [statusKey, setStatusKey] = useState<string | null>(null);
  const configQuery = useEmbeddedServicesConfig(workspaceId);
  const setEnabled = useSetEmbeddedServiceEnabled(workspaceId);

  const changeEnabled = async (
    service: "mitra" | "wisemapping",
    enabled: boolean,
  ) => {
    setStatusKey("settings.saving");
    try {
      await setEnabled.mutateAsync({ service, enabled });
      setStatusKey("settings.saveSuccess");
    } catch {
      setStatusKey("settings.saveError");
    }
  };

  if (configQuery.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div role="status">
          <span className="sr-only">{t("loading")}</span>
        </div>
        <LoadingSkeleton className="h-14 w-full" />
        <LoadingSkeleton className="h-14 w-full" />
      </div>
    );
  }

  if (configQuery.isError || !configQuery.data) {
    return (
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="text-sm text-muted-foreground">
          {t("configError")}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:min-h-11"
          onClick={() => void configQuery.refetch()}
        >
          <RefreshCw className="size-4" />
          {t("retry")}
        </Button>
      </div>
    );
  }

  const { mitra, wisemapping } = configQuery.data;

  return (
    <div className="space-y-3">
      {!mitra && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium">{t("settings.mitraLabel")}:</span>{" "}
          {t("settings.serviceNotConfigured")}
        </p>
      )}
      {!wisemapping && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium">{t("settings.wisemappingLabel")}:</span>{" "}
          {t("settings.serviceNotConfigured")}
        </p>
      )}
      {mitra && (
        <div className="flex min-h-11 items-center justify-between gap-4 rounded-md px-2 py-2 hover:bg-accent/40">
          <span id="embedded-mitra-label" className="text-sm font-medium">
            {t("settings.mitraLabel")}
          </span>
          <Switch
            aria-labelledby="embedded-mitra-label"
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            checked={mitra.enabled}
            disabled={setEnabled.isPending}
            onCheckedChange={(enabled) => {
              setStatusKey(null);
              void changeEnabled("mitra", enabled);
            }}
          />
        </div>
      )}
      {wisemapping && (
        <div className="flex min-h-11 items-center justify-between gap-4 rounded-md px-2 py-2 hover:bg-accent/40">
          <span id="embedded-wisemapping-label" className="text-sm font-medium">
            {t("settings.wisemappingLabel")}
          </span>
          <Switch
            aria-labelledby="embedded-wisemapping-label"
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            checked={wisemapping.enabled}
            disabled={setEnabled.isPending}
            onCheckedChange={(enabled) => {
              setStatusKey(null);
              void changeEnabled("wisemapping", enabled);
            }}
          />
        </div>
      )}
      <p
        role="status"
        aria-live="polite"
        className="min-h-5 text-xs text-muted-foreground"
      >
        {statusKey ? t(statusKey) : ""}
      </p>
    </div>
  );
}
