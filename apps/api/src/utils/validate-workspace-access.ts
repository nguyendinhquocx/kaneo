import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";

export async function validateWorkspaceAccess(
  userId: string,
  workspaceId: string,
  apiKeyId?: string,
): Promise<void> {
  if (apiKeyId) {
    // `verifyApiKey()` already checked the hash, enabled flag, expiry and
    // reference/user binding. Re-check the immutable owner here so a key
    // cannot be swapped between authentication and a workspace lookup.
    const [apiKey] = await db
      .select({
        referenceId: schema.apikeyTable.referenceId,
        userId: schema.apikeyTable.userId,
        enabled: schema.apikeyTable.enabled,
        expiresAt: schema.apikeyTable.expiresAt,
      })
      .from(schema.apikeyTable)
      .where(
        and(
          eq(schema.apikeyTable.id, apiKeyId),
          eq(schema.apikeyTable.referenceId, userId),
          eq(schema.apikeyTable.enabled, true),
        ),
      )
      .limit(1);

    if (
      !apiKey ||
      (apiKey.userId !== null && apiKey.userId !== userId) ||
      (apiKey.expiresAt !== null && apiKey.expiresAt <= new Date())
    ) {
      throw new HTTPException(403, {
        message: "Invalid API key for this workspace",
      });
    }
  }

  const [user] = await db
    .select({ role: schema.userTable.role })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);

  if (user?.role === "admin") {
    return;
  }

  const membership = await db
    .select()
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.userId, userId),
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (membership.length === 0) {
    throw new HTTPException(403, {
      message: "You don't have access to this workspace",
    });
  }
}
