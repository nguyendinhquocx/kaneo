import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import db, { schema } from "../database";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import {
  isSharePermission,
  isShareResourceType,
  type ShareResourceType,
} from "./resolve-share-link";
import { generateShareToken, hashShareToken } from "./token";

// SPEC-2026-10-08-kaneo-workspace-collaboration T2: authenticated share-link
// management. Creating or revoking a capability link requires the workspace
// `project:share` permission (API keys need the matching scope). The raw
// token is returned exactly once, at creation; it is never stored or logged.

const EDIT_LINK_TTL_DAYS = 30;

const shareLinkSchema = v.object({
  id: v.string(),
  resourceType: v.string(),
  resourceId: v.string(),
  permission: v.string(),
  expiresAt: v.nullable(v.string()),
  revokedAt: v.nullable(v.string()),
  createdAt: v.string(),
});

async function lookupResourceWorkspaceId(
  resourceType: ShareResourceType,
  resourceId: string,
): Promise<string | null> {
  if (resourceType === "project") {
    const [row] = await db
      .select({ workspaceId: schema.projectTable.workspaceId })
      .from(schema.projectTable)
      .where(eq(schema.projectTable.id, resourceId))
      .limit(1);
    return row?.workspaceId ?? null;
  }
  if (resourceType === "document") {
    const [row] = await db
      .select({ workspaceId: schema.projectTable.workspaceId })
      .from(schema.documentTable)
      .innerJoin(
        schema.projectTable,
        eq(schema.documentTable.projectId, schema.projectTable.id),
      )
      .where(eq(schema.documentTable.id, resourceId))
      .limit(1);
    return row?.workspaceId ?? null;
  }
  const [row] = await db
    .select({ workspaceId: schema.goalTable.workspaceId })
    .from(schema.goalTable)
    .where(eq(schema.goalTable.id, resourceId))
    .limit(1);
  return row?.workspaceId ?? null;
}

const shareManage = new Hono<{
  Variables: {
    userId: string;
    workspaceId: string;
  };
}>()
  .post(
    "/",
    describeRoute({
      operationId: "createShareLink",
      tags: ["Share"],
      description:
        "Create a capability share link for one resource. The raw token is returned once.",
      responses: {
        200: {
          description: "Created share link with one-time token",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator(
      "json",
      v.object({
        resourceType: v.picklist(["project", "document", "goal"]),
        resourceId: v.string(),
        permission: v.picklist(["view", "edit"]),
      }),
    ),
    async (c) => {
      const { resourceType, resourceId, permission } = c.req.valid("json");
      const userId = c.get("userId");

      const workspaceId = await lookupResourceWorkspaceId(
        resourceType,
        resourceId,
      );
      if (!workspaceId) {
        throw new HTTPException(404, { message: "Resource not found" });
      }
      c.set("workspaceId", workspaceId);

      const permissionMiddleware = requireWorkspacePermission({
        project: ["share"],
      });
      await permissionMiddleware(c, async () => {});

      const rawToken = generateShareToken();
      const expiresAt =
        permission === "edit"
          ? new Date(Date.now() + EDIT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000)
          : null;

      const created = await db
        .insert(schema.shareLinkTable)
        .values({
          resourceType,
          resourceId,
          permission,
          tokenHash: hashShareToken(rawToken),
          workspaceId,
          createdByUserId: userId || null,
          expiresAt,
        })
        .returning({ id: schema.shareLinkTable.id });
      if (!created[0]) {
        throw new HTTPException(500, {
          message: "Failed to create share link",
        });
      }

      const clientUrl = (
        process.env.KANEO_CLIENT_URL || "http://localhost:5173"
      ).replace(/\/$/, "");

      return c.json({
        id: created[0].id,
        resourceType,
        resourceId,
        permission,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        createdAt: new Date().toISOString(),
        // One-time secret: never persisted in raw form, never returned again.
        token: rawToken,
        url: `${clientUrl}/share/${resourceType}/${rawToken}`,
      });
    },
  )
  .get(
    "/",
    describeRoute({
      operationId: "listShareLinks",
      tags: ["Share"],
      description: "List share links for a resource (no tokens).",
      responses: {
        200: {
          description: "Share links for the resource",
          content: {
            "application/json": { schema: resolver(v.array(shareLinkSchema)) },
          },
        },
      },
    }),
    validator(
      "query",
      v.object({
        resourceType: v.picklist(["project", "document", "goal"]),
        resourceId: v.string(),
        includeRevoked: v.optional(v.string()),
      }),
    ),
    async (c) => {
      const { resourceType, resourceId, includeRevoked } = c.req.valid("query");

      if (!isShareResourceType(resourceType)) {
        throw new HTTPException(400, { message: "Invalid resource type" });
      }

      const workspaceId = await lookupResourceWorkspaceId(
        resourceType,
        resourceId,
      );
      if (!workspaceId) {
        throw new HTTPException(404, { message: "Resource not found" });
      }
      c.set("workspaceId", workspaceId);

      const permissionMiddleware = requireWorkspacePermission({
        project: ["share"],
      });
      await permissionMiddleware(c, async () => {});

      const conditions = [
        eq(schema.shareLinkTable.resourceType, resourceType),
        eq(schema.shareLinkTable.resourceId, resourceId),
      ];
      if (includeRevoked !== "true") {
        conditions.push(isNull(schema.shareLinkTable.revokedAt));
      }

      const links = await db
        .select({
          id: schema.shareLinkTable.id,
          resourceType: schema.shareLinkTable.resourceType,
          resourceId: schema.shareLinkTable.resourceId,
          permission: schema.shareLinkTable.permission,
          expiresAt: schema.shareLinkTable.expiresAt,
          revokedAt: schema.shareLinkTable.revokedAt,
          createdAt: schema.shareLinkTable.createdAt,
        })
        .from(schema.shareLinkTable)
        .where(and(...conditions))
        .orderBy(desc(schema.shareLinkTable.createdAt));

      return c.json(
        links.map((link) => ({
          ...link,
          expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
          revokedAt: link.revokedAt ? link.revokedAt.toISOString() : null,
          createdAt: link.createdAt.toISOString(),
        })),
      );
    },
  )
  .delete(
    "/:id",
    describeRoute({
      operationId: "revokeShareLink",
      tags: ["Share"],
      description: "Revoke a share link by ID.",
      responses: {
        200: {
          description: "Link revoked",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    async (c) => {
      const { id } = c.req.valid("param");

      const [link] = await db
        .select()
        .from(schema.shareLinkTable)
        .where(eq(schema.shareLinkTable.id, id))
        .limit(1);

      if (!link) {
        throw new HTTPException(404, { message: "Share link not found" });
      }
      c.set("workspaceId", link.workspaceId);

      const permissionMiddleware = requireWorkspacePermission({
        project: ["share"],
      });
      await permissionMiddleware(c, async () => {});

      await db
        .update(schema.shareLinkTable)
        .set({ revokedAt: new Date() })
        .where(eq(schema.shareLinkTable.id, id));

      return c.json({ success: true });
    },
  );

export default shareManage;

// Re-exported for tests that need to assert valid shapes without importing
// valibot internals.
export { isSharePermission };
