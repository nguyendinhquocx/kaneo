import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { checkShareRateLimit } from "./rate-limit";
import { hashShareToken, isPlausibleShareToken } from "./token";

// SPEC-2026-10-08-kaneo-workspace-collaboration T2: every capability handler
// must validate token, resource type, permission, expiry and revocation. All
// invalid states fail closed with the same generic 404 so a caller cannot
// distinguish "bad token" from "resource does not exist".

export type SharePermission = "view" | "edit" | "full";

export const SHARE_RESOURCE_TYPES = [
  "project",
  "document",
  "goal",
  "task_description",
  "activity_comment",
] as const;
export type ShareResourceType = (typeof SHARE_RESOURCE_TYPES)[number];

export function isShareResourceType(value: string): value is ShareResourceType {
  return (SHARE_RESOURCE_TYPES as readonly string[]).includes(value);
}

export function isSharePermission(value: string): value is SharePermission {
  return value === "view" || value === "edit" || value === "full";
}

export type ResolvedShareLink = typeof schema.shareLinkTable.$inferSelect;

export function clientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

export function assertShareRateLimit(
  c: Context,
  scope: "read" | "write",
  tokenHash: string,
) {
  const result = checkShareRateLimit(scope, tokenHash, clientIp(c));
  if (!result.allowed) {
    throw new HTTPException(429, {
      res: new Response(
        JSON.stringify({
          message:
            "Too many requests. Slow down and retry later; contact the link owner if this persists.",
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(result.retryAfterSeconds),
          },
        },
      ),
    });
  }
}

// SPEC-2026-10-22 full-project-share-link: permission lattice is
// full ⊃ edit ⊃ view. A weaker link never satisfies a stronger requirement
// and a `full` link is only accepted for actions that declare their real
// minimum, so requesting "edit" keeps basic-edit links working while "full"
// gates stay exclusive to full links.
export function linkGrantsPermission(
  linkPermission: string,
  required: SharePermission,
): boolean {
  if (required === "full") {
    return linkPermission === "full";
  }
  if (required === "edit") {
    return linkPermission === "edit" || linkPermission === "full";
  }
  return true;
}

export async function resolveShareLink(
  token: string,
  resourceType: ShareResourceType,
  requiredPermission: SharePermission,
): Promise<ResolvedShareLink> {
  const genericNotFound = () =>
    new HTTPException(404, { message: "Not found" });

  if (!isPlausibleShareToken(token)) {
    throw genericNotFound();
  }

  const tokenHash = hashShareToken(token);

  const [link] = await db
    .select()
    .from(schema.shareLinkTable)
    .where(eq(schema.shareLinkTable.tokenHash, tokenHash))
    .limit(1);

  if (!link) {
    throw genericNotFound();
  }
  if (link.revokedAt !== null) {
    throw genericNotFound();
  }
  if (link.expiresAt !== null && link.expiresAt.getTime() <= Date.now()) {
    throw genericNotFound();
  }
  if (link.resourceType !== resourceType) {
    throw genericNotFound();
  }
  if (!linkGrantsPermission(link.permission, requiredPermission)) {
    throw genericNotFound();
  }

  return link;
}

// Metadata-only audit row for every public mutation. No raw token, no request
// body, no IP/UA — attribution is by share-link ID by design.
// SPEC-2026-10-22: `tx` binds the audit insert into the mutation's own
// transaction; when provided, an audit failure rolls the mutation back.
// `resourceIdOverride` records the concrete object (e.g. asset id) the action
// targeted while resourceType/resourceId columns keep the link's scope.
export async function appendShareActionAudit(
  link: ResolvedShareLink,
  action: string,
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
  resourceIdOverride?: string,
) {
  const executor = tx ?? db;
  await executor.insert(schema.shareActionAuditTable).values({
    shareLinkId: link.id,
    resourceType: link.resourceType,
    resourceId: resourceIdOverride ?? link.resourceId,
    action,
  });
}

// Public readers must not leak bearer tokens through referrers and must stay
// out of indexes.
export function applyShareSecurityHeaders(c: Context) {
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Cache-Control", "no-store");
}
