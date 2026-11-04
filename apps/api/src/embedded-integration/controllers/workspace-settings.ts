import { eq } from "drizzle-orm";
import db from "../../database";
import { workspaceIntegrationSettingsTable } from "../../database/schema";

export type EmbeddedServiceName = "mitra" | "wisemapping";

export async function getWorkspaceIntegrationSettings(workspaceId: string) {
  const [settings] = await db
    .select({
      mitraEnabled: workspaceIntegrationSettingsTable.mitraEnabled,
      wisemappingEnabled: workspaceIntegrationSettingsTable.wisemappingEnabled,
    })
    .from(workspaceIntegrationSettingsTable)
    .where(eq(workspaceIntegrationSettingsTable.workspaceId, workspaceId))
    .limit(1);

  // Missing rows are intentionally enabled by default, preserving behavior
  // for existing workspaces after the migration.
  return {
    mitraEnabled: settings?.mitraEnabled ?? true,
    wisemappingEnabled: settings?.wisemappingEnabled ?? true,
  };
}

export async function setWorkspaceIntegrationEnabled({
  workspaceId,
  service,
  enabled,
}: {
  workspaceId: string;
  service: EmbeddedServiceName;
  enabled: boolean;
}) {
  const now = new Date();

  if (service === "mitra") {
    await db
      .insert(workspaceIntegrationSettingsTable)
      .values({ workspaceId, mitraEnabled: enabled })
      .onConflictDoUpdate({
        target: workspaceIntegrationSettingsTable.workspaceId,
        set: { mitraEnabled: enabled, updatedAt: now },
      });
  } else {
    await db
      .insert(workspaceIntegrationSettingsTable)
      .values({ workspaceId, wisemappingEnabled: enabled })
      .onConflictDoUpdate({
        target: workspaceIntegrationSettingsTable.workspaceId,
        set: { wisemappingEnabled: enabled, updatedAt: now },
      });
  }
}
