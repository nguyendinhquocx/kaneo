import { createHash } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import db, { schema } from "../database";

async function hashApiKey(key: string): Promise<string> {
  const hash = createHash("sha256").update(key).digest();
  return hash
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export type ApiKeyPermissionMap = Record<string, string[]>;

/**
 * A missing or malformed permission payload is not an unrestricted key.
 * `null` is reserved for callers that are not using an API key at all.
 */
export function parseApiKeyPermissions(
  raw: string | null | undefined,
): ApiKeyPermissionMap | null {
  // Better Auth omits permissions for a key created without an explicit
  // server-side scope. Treat that exactly like a permissionless key.
  if (raw === null || raw === undefined) return {};

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return {};

  const permissions: ApiKeyPermissionMap = {};
  for (const [resource, actions] of entries) {
    if (
      !resource.trim() ||
      !Array.isArray(actions) ||
      actions.length === 0 ||
      actions.some(
        (action) => typeof action !== "string" || action.trim().length === 0,
      )
    ) {
      return {};
    }
    permissions[resource] = [...new Set(actions as string[])];
  }
  return permissions;
}

export async function verifyApiKey(key: string) {
  const hashedKey = await hashApiKey(key);

  const [apiKey] = await db
    .select()
    .from(schema.apikeyTable)
    .where(
      and(
        eq(schema.apikeyTable.key, hashedKey),
        eq(schema.apikeyTable.enabled, true),
        or(
          isNull(schema.apikeyTable.expiresAt),
          gt(schema.apikeyTable.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);

  if (!apiKey) {
    return null;
  }

  // Better Auth owns the key by `referenceId` for user-referenced keys. A
  // legacy `userId` value is accepted only when it agrees; otherwise the key
  // is corrupt and must not authenticate as either identity.
  const referenceUserId = apiKey.referenceId?.trim();
  const legacyUserId = apiKey.userId?.trim() || null;
  if (!referenceUserId || (legacyUserId && legacyUserId !== referenceUserId)) {
    return null;
  }

  return {
    valid: true,
    key: {
      id: apiKey.id,
      userId: referenceUserId,
      name: apiKey.name,
      prefix: apiKey.prefix,
      start: apiKey.start,
      enabled: apiKey.enabled ?? false,
      expiresAt: apiKey.expiresAt,
      permissions: parseApiKeyPermissions(apiKey.permissions),
      refillInterval: apiKey.refillInterval,
      refillAmount: apiKey.refillAmount,
      lastRefillAt: apiKey.lastRefillAt,
      rateLimitEnabled: apiKey.rateLimitEnabled,
      rateLimitTimeWindow: apiKey.rateLimitTimeWindow,
      rateLimitMax: apiKey.rateLimitMax,
      requestCount: apiKey.requestCount,
      remaining: apiKey.remaining,
      lastRequest: apiKey.lastRequest,
      metadata: (() => {
        if (!apiKey.metadata) return null;
        try {
          const parsed = JSON.parse(apiKey.metadata);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      })(),
    },
  };
}
