import { useTranslation } from "react-i18next";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import EmbeddedIntegrationsSettings from "./embedded-integrations-settings";

type WorkspaceEmbeddedIntegrationsSectionProps = {
  workspaceId: string;
};

export default function WorkspaceEmbeddedIntegrationsSection({
  workspaceId,
}: WorkspaceEmbeddedIntegrationsSectionProps) {
  const { t } = useTranslation();
  const { canManageEmbeddedIntegrations, isCheckingPermissions } =
    useWorkspacePermission();

  if (isCheckingPermissions || !canManageEmbeddedIntegrations()) {
    return null;
  }

  return (
    <section
      className="space-y-6"
      aria-labelledby="workspace-integrations-title"
    >
      <div className="space-y-1">
        <h2 id="workspace-integrations-title" className="text-md font-medium">
          {t("embedded:settings.sectionTitle")}
        </h2>
      </div>
      <div className="space-y-4 rounded-md border border-border bg-sidebar p-4">
        <EmbeddedIntegrationsSettings workspaceId={workspaceId} />
      </div>
    </section>
  );
}
