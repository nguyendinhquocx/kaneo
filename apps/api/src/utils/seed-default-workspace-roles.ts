import {
  DEFAULT_ROLE_NAMES,
  type DefaultRoleName,
  defaultRolePayloads,
} from "@kaneo/permissions";
import { and, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "../database";

/**
 * Backfill the editable default roles (viewer/member/admin) for every
 * workspace that's missing them. Runs on API startup after Drizzle
 * migrations.
 *
 * These three roles used to be static (compiled into better-auth's
 * `roles` config). They were converted to DB rows so admins can override
 * them per workspace — but that means existing workspaces, which were
 * created before the switch, have no rows yet. Without this backfill,
 * better-auth's dynamic-access-control resolution would treat them as
 * having an empty permission set on existing workspaces.
 *
 * Idempotent: only inserts rows that aren't already present.
 */
function permissionMapsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const normalize = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value)
        .filter(([, actions]) => Array.isArray(actions))
        .map(
          ([resource, actions]) =>
            [
              resource,
              [...(actions as unknown[])]
                .filter(
                  (action): action is string => typeof action === "string",
                )
                .sort(),
            ] as [string, string[]],
        )
        .sort(([leftResource], [rightResource]) =>
          (leftResource ?? "").localeCompare(rightResource ?? ""),
        ),
    );

  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function isLegacyDefaultRolePayload(
  role: string,
  rawPermission: string,
): boolean {
  if (role !== "admin") return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPermission);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }

  const permission = parsed as Record<string, unknown>;
  if (Object.hasOwn(permission, "execution")) return false;

  const { execution: _execution, ...currentWithoutExecution } =
    defaultRolePayloads.admin;
  return permissionMapsEqual(permission, currentWithoutExecution);
}

export async function seedDefaultWorkspaceRoles() {
  try {
    const tableExists = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = 'workspace_role'
      ) AS exists;
    `);

    const exists =
      tableExists.rows[0]?.exists === true ||
      tableExists.rows[0]?.exists === "t";
    if (!exists) {
      console.log(
        "🛈 workspace_role table does not exist — skipping default-role seed.",
      );
      return;
    }

    const workspaces = await db
      .select({ id: schema.workspaceTable.id })
      .from(schema.workspaceTable);

    if (workspaces.length === 0) {
      return;
    }

    const workspaceIds = workspaces.map((w) => w.id);

    const existingRows = await db
      .select({
        id: schema.workspaceRoleTable.id,
        workspaceId: schema.workspaceRoleTable.workspaceId,
        role: schema.workspaceRoleTable.role,
        permission: schema.workspaceRoleTable.permission,
      })
      .from(schema.workspaceRoleTable)
      .where(
        and(
          inArray(schema.workspaceRoleTable.workspaceId, workspaceIds),
          inArray(
            schema.workspaceRoleTable.role,
            DEFAULT_ROLE_NAMES as unknown as string[],
          ),
        ),
      );

    const present = new Set(
      existingRows.map((r) => `${r.workspaceId}:${r.role}`),
    );

    const now = new Date();
    let updatedLegacyRows = 0;
    for (const row of existingRows) {
      if (
        isLegacyDefaultRolePayload(row.role, row.permission) &&
        row.role in defaultRolePayloads
      ) {
        await db
          .update(schema.workspaceRoleTable)
          .set({
            permission: JSON.stringify(
              defaultRolePayloads[row.role as DefaultRoleName],
            ),
            updatedAt: now,
          })
          .where(eq(schema.workspaceRoleTable.id, row.id));
        updatedLegacyRows += 1;
      }
    }

    if (updatedLegacyRows > 0) {
      console.log(
        `✅ Backfilled execution:review for ${updatedLegacyRows} unchanged admin workspace role row(s).`,
      );
    }
    const rows: Array<typeof schema.workspaceRoleTable.$inferInsert> = [];
    for (const workspaceId of workspaceIds) {
      for (const name of DEFAULT_ROLE_NAMES) {
        if (present.has(`${workspaceId}:${name}`)) continue;
        rows.push({
          workspaceId,
          role: name,
          permission: JSON.stringify(defaultRolePayloads[name]),
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    if (rows.length === 0) {
      return;
    }

    // Postgres' bind protocol caps parameters at 65535 per query, so insert
    // in chunks. 6 columns × 1000 rows = 6000 params per batch, leaving ample
    // headroom even for instances with tens of thousands of workspaces.
    const BATCH_SIZE = 1000;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await db
        .insert(schema.workspaceRoleTable)
        .values(rows.slice(i, i + BATCH_SIZE));
    }
    console.log(
      `✅ Seeded ${rows.length} default workspace role row(s) across ${workspaceIds.length} workspace(s).`,
    );
  } catch (error) {
    console.error("❌ Failed to seed default workspace roles:", error);
    throw error;
  }
}
