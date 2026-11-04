import { and, eq } from "drizzle-orm";
import db from "../../database";
import { integrationTable } from "../../database/schema";

const WISEMAPPING_TYPE = "wisemapping";

async function findMindMapBinding(projectId: string) {
  const [row] = await db
    .select({ config: integrationTable.config })
    .from(integrationTable)
    .where(
      and(
        eq(integrationTable.projectId, projectId),
        eq(integrationTable.type, WISEMAPPING_TYPE),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  let config: unknown;
  try {
    config = JSON.parse(row.config);
  } catch {
    // A malformed row must not leak content; treat it as unlinked.
    return null;
  }

  const mapId =
    typeof config === "object" &&
    config !== null &&
    typeof (config as { mapId?: unknown }).mapId === "string"
      ? (config as { mapId: string }).mapId
      : null;

  return mapId ? { mapId } : null;
}

export async function getMindMapBinding(projectId: string) {
  return findMindMapBinding(projectId);
}

export async function upsertMindMapBinding({
  projectId,
  mapId,
}: {
  projectId: string;
  mapId: string;
}) {
  const now = new Date();
  const config = JSON.stringify({ mapId });

  await db
    .insert(integrationTable)
    .values({
      projectId,
      type: WISEMAPPING_TYPE,
      config,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [integrationTable.projectId, integrationTable.type],
      set: {
        config,
        isActive: true,
        updatedAt: now,
      },
    });

  return { mapId };
}

export async function deleteMindMapBinding(projectId: string) {
  await db
    .delete(integrationTable)
    .where(
      and(
        eq(integrationTable.projectId, projectId),
        eq(integrationTable.type, WISEMAPPING_TYPE),
      ),
    );

  return { mapId: null };
}
