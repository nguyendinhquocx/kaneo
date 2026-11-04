import { ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import EmbeddedFrame from "@/components/embedded/embedded-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import useEmbeddedServicesConfig from "@/hooks/queries/embedded-integration/use-embedded-services-config";
import useMindMapBinding from "@/hooks/queries/embedded-integration/use-mind-map-binding";
import {
  useLinkMindMap,
  useUnlinkMindMap,
} from "@/hooks/queries/embedded-integration/use-mind-map-mutations";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { buildWiseMappingEditorUrl } from "./map-url";

type MindMapViewProps = {
  projectId: string;
  workspaceId: string;
};

export default function MindMapView({
  projectId,
  workspaceId,
}: MindMapViewProps) {
  const { t } = useTranslation("embedded");
  const [frameKey, setFrameKey] = useState(0);
  const {
    data: config,
    isLoading: isConfigLoading,
    isError: isConfigError,
    refetch: refetchConfig,
  } = useEmbeddedServicesConfig(workspaceId);
  const {
    data: binding,
    isLoading: isBindingLoading,
    isError: isBindingError,
    refetch: refetchBinding,
  } = useMindMapBinding(projectId);
  const { canManageEmbeddedIntegrations, isCheckingPermissions } =
    useWorkspacePermission();
  const canManage = canManageEmbeddedIntegrations();

  if (isConfigLoading || (isBindingLoading && !isConfigError)) {
    return (
      <div role="status" className="h-full w-full p-1">
        <span className="sr-only">{t("loading")}</span>
        <LoadingSkeleton className="h-full w-full" />
      </div>
    );
  }

  if (isConfigError || !config) {
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
          onClick={() => void refetchConfig()}
        >
          <RefreshCw className="size-4" />
          {t("retry")}
        </Button>
      </div>
    );
  }

  const wisemapping = config.wisemapping;

  if (!wisemapping) {
    return (
      <div
        role="status"
        className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center"
      >
        <p className="text-sm text-muted-foreground">{t("mindMapDisabled")}</p>
      </div>
    );
  }

  if (isBindingError) {
    return (
      <div
        role="status"
        className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center"
      >
        <p className="text-sm text-muted-foreground">{t("bindingError")}</p>
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:min-h-11"
          onClick={() => void refetchBinding()}
        >
          <RefreshCw className="size-4" />
          {t("retry")}
        </Button>
      </div>
    );
  }

  const mapId = binding?.mapId ?? null;
  const editorUrl = mapId
    ? buildWiseMappingEditorUrl(wisemapping.baseUrl, mapId)
    : null;

  if (!mapId || !editorUrl) {
    // While the capability check is still in flight, neither flash the
    // manager form nor tell a manager the map is unlinked — keep loading.
    if (isCheckingPermissions) {
      return (
        <div role="status" className="h-full w-full p-1">
          <span className="sr-only">{t("loading")}</span>
          <LoadingSkeleton className="h-full w-full" />
        </div>
      );
    }
    return canManage ? (
      <MindMapLinkForm projectId={projectId} />
    ) : (
      <div
        role="status"
        className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center"
        data-testid="mindmap-unlinked"
      >
        <p className="text-sm text-muted-foreground">{t("mindMapUnlinked")}</p>
      </div>
    );
  }

  if (wisemapping.viewMode === "open-only") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-sm text-muted-foreground">
          {t("mindMapOpenOnlyNotice")}
        </p>
        <Button
          className="pointer-coarse:min-h-11"
          render={
            <a href={editorUrl} target="_blank" rel="noopener noreferrer" />
          }
        >
          <ExternalLink className="size-4" />
          {t("openExternally")}
        </Button>
        {canManage && <UnlinkButton projectId={projectId} />}
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
            <a href={editorUrl} target="_blank" rel="noopener noreferrer" />
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
        {canManage && <UnlinkButton projectId={projectId} />}
      </div>
      <div className="min-h-0 flex-1">
        {/* Keyed by project: switching projects remounts the frame so the
            previous map is never kept mounted across a project switch. */}
        <EmbeddedFrame
          key={`${projectId}:${frameKey}`}
          src={editorUrl}
          title={t("mindMapFrameTitle")}
          externalUrl={editorUrl}
          testId="mindmap-embedded-frame"
        />
      </div>
    </div>
  );
}

function UnlinkButton({ projectId }: { projectId: string }) {
  const { t } = useTranslation("embedded");
  const unlink = useUnlinkMindMap(projectId);

  return (
    <Button
      variant="ghost"
      size="xs"
      className="pointer-coarse:min-h-11"
      disabled={unlink.isPending}
      onClick={() => unlink.mutate()}
    >
      {t("unlinkMap")}
    </Button>
  );
}

function MindMapLinkForm({ projectId }: { projectId: string }) {
  const { t } = useTranslation("embedded");
  const [mapId, setMapId] = useState("");
  const link = useLinkMindMap(projectId);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = mapId.trim();
    if (!trimmed) return;
    link.mutate(trimmed, {
      onSuccess: () => setMapId(""),
    });
  };

  return (
    <div className="flex h-full w-full items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-3 text-center"
        data-testid="mindmap-link-form"
      >
        <p className="text-sm text-muted-foreground">
          {t("mindMapCreateThenLink")}
        </p>
        <Input
          value={mapId}
          onChange={(event) => setMapId(event.target.value)}
          placeholder={t("mapIdPlaceholder")}
          aria-label={t("mapIdLabel")}
          name="mapId"
        />
        {link.isError && (
          <p role="alert" className="text-xs text-destructive">
            {t("mapIdInvalid")}
          </p>
        )}
        <Button
          type="submit"
          className="pointer-coarse:min-h-11 w-full"
          disabled={!mapId.trim() || link.isPending}
        >
          {t("linkMap")}
        </Button>
      </form>
    </div>
  );
}
