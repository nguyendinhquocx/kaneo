import { type BuiltInRoleName, builtInRoles } from "@kaneo/permissions";
import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
export type PermissionMap = Record<string, string[]>;

type ApiKeyContext = {
  permissions?: PermissionMap | null;
};

function hasApiKeyScope(
  apiKey: ApiKeyContext | undefined,
  permissions: PermissionMap,
): boolean {
  // An authenticated API key always has an explicit permission map. Missing
  // or malformed data is represented as `{}` by verifyApiKey and therefore
  // denies every protected capability instead of becoming unrestricted.
  return (
    apiKey === undefined ||
    (apiKey.permissions !== null &&
      apiKey.permissions !== undefined &&
      satisfies(apiKey.permissions, permissions))
  );
}

function builtInRoleStatements(
  role: string,
): Record<string, readonly string[]> | null {
  if (role in builtInRoles) {
    return builtInRoles[role as BuiltInRoleName].statements as Record<
      string,
      readonly string[]
    >;
  }
  return null;
}

function parsePermissionStatements(
  raw: string,
): Record<string, readonly string[]> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  // Only keep entries shaped like { [resource: string]: string[] }.
  // Anything malformed is dropped so `satisfies()` never calls
  // `.includes()` on a non-array.
  const result: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!Array.isArray(actions)) continue;
    const filtered = actions.filter(
      (action): action is string => typeof action === "string",
    );
    if (filtered.length > 0) {
      result[resource] = filtered;
    }
  }
  return result;
}

async function customRoleStatements(
  workspaceId: string,
  role: string,
): Promise<Record<string, readonly string[]> | null> {
  const [row] = await db
    .select({ permission: schema.workspaceRoleTable.permission })
    .from(schema.workspaceRoleTable)
    .where(
      and(
        eq(schema.workspaceRoleTable.workspaceId, workspaceId),
        eq(schema.workspaceRoleTable.role, role),
      ),
    )
    .limit(1);

  if (!row?.permission) return null;

  return parsePermissionStatements(row.permission);
}

function satisfies(
  statements: Record<string, readonly string[]>,
  required: PermissionMap,
): boolean {
  for (const [resource, actions] of Object.entries(required)) {
    const granted = statements[resource];
    if (!granted) return false;
    for (const action of actions) {
      if (!granted.includes(action)) return false;
    }
  }
  return true;
}

export async function hasUserWorkspacePermission(
  userId: string,
  workspaceId: string,
  permissions: PermissionMap,
): Promise<boolean> {
  const [user] = await db
    .select({ role: schema.userTable.role })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);

  if (user?.role === "admin") {
    return true;
  }

  const [member] = await db
    .select({ role: schema.workspaceUserTable.role })
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    )
    .limit(1);

  if (!member?.role) return false;

  // Prefer the DB row when present so admin-edited defaults
  // (viewer/member/admin) take effect immediately. Falls back to the
  // compiled-in static definitions only when no row exists — protects
  // viewer/member/admin users from a 403 if their workspace somehow
  // missed the seed (e.g., seed failed during workspace creation and
  // the boot-time backfill hasn't run yet).
  const statements =
    (await customRoleStatements(workspaceId, member.role)) ??
    builtInRoleStatements(member.role);

  return Boolean(statements && satisfies(statements, permissions));
}

export async function assertUserWorkspacePermission(
  userId: string,
  workspaceId: string,
  permissions: PermissionMap,
): Promise<void> {
  if (!(await hasUserWorkspacePermission(userId, workspaceId, permissions))) {
    throw new HTTPException(403, { message: "Insufficient permissions" });
  }
}

export async function hasWorkspacePermission(
  c: Context,
  permissions: PermissionMap,
) {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) return false;

  const apiKey = c.get("apiKey") as ApiKeyContext | undefined;
  if (!hasApiKeyScope(apiKey, permissions)) {
    return false;
  }

  const userId = c.get("userId");
  if (!userId) return false;

  return hasUserWorkspacePermission(userId, workspaceId, permissions);
}

export function requireWorkspacePermission(permissions: PermissionMap) {
  return async (c: Context, next: Next) => {
    if (!c.get("workspaceId")) {
      throw new HTTPException(500, {
        message: "workspaceId not set in context",
      });
    }

    const apiKey = c.get("apiKey") as ApiKeyContext | undefined;
    if (!hasApiKeyScope(apiKey, permissions)) {
      throw new HTTPException(403, { message: "Insufficient API key scope" });
    }

    if (!(await hasWorkspacePermission(c, permissions))) {
      if (!c.get("userId")) {
        throw new HTTPException(401, { message: "Unauthorized" });
      }
      throw new HTTPException(403, { message: "Insufficient permissions" });
    }

    return next();
  };
}
