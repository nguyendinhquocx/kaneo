import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import db, { schema } from "../database";
import { isProjectAgentControlled } from "../project/controllers/public-project-dto";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import {
  isSharePermission,
  isShareResourceType,
  type ShareResourceType,
} from "./resolve-share-link";
import {
  decryptShareToken,
  encryptShareToken,
  generateShareToken,
  hashShareToken,
  shareLinkTokenAad,
} from "./token";

// Authenticated share-link management. Creating, listing and revoking a
// capability link requires `project:share` (API keys need the matching scope).
// Raw tokens are never stored in plaintext or logged; R4 stores AEAD ciphertext
// and returns a decrypted URL only to an authorized share manager.

const EDIT_LINK_TTL_DAYS = 30;

const shareLinkSchema = v.object({
  id: v.string(),
  resourceType: v.string(),
  resourceId: v.string(),
  permission: v.string(),
  expiresAt: v.nullable(v.string()),
  revokedAt: v.nullable(v.string()),
  createdAt: v.string(),
  url: v.nullable(v.string()),
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
  if (resourceType === "goal") {
    const [row] = await db
      .select({ workspaceId: schema.goalTable.workspaceId })
      .from(schema.goalTable)
      .where(eq(schema.goalTable.id, resourceId))
      .limit(1);
    return row?.workspaceId ?? null;
  }
  if (resourceType === "task_description") {
    const [row] = await db
      .select({ workspaceId: schema.projectTable.workspaceId })
      .from(schema.taskTable)
      .innerJoin(
        schema.projectTable,
        eq(schema.taskTable.projectId, schema.projectTable.id),
      )
      .where(eq(schema.taskTable.id, resourceId))
      .limit(1);
    return row?.workspaceId ?? null;
  }
  const [row] = await db
    .select({ workspaceId: schema.projectTable.workspaceId })
    .from(schema.activityTable)
    .innerJoin(
      schema.taskTable,
      eq(schema.activityTable.taskId, schema.taskTable.id),
    )
    .innerJoin(
      schema.projectTable,
      eq(schema.taskTable.projectId, schema.projectTable.id),
    )
    .where(
      and(
        eq(schema.activityTable.id, resourceId),
        eq(schema.activityTable.type, "comment"),
      ),
    )
    .limit(1);
  return row?.workspaceId ?? null;
}

const shareManage = new Hono<{
  Variables: {
    userId: string;
    workspaceId: string;
  };
}>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
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
        resourceType: v.picklist([
          "project",
          "document",
          "goal",
          "task_description",
          "activity_comment",
        ]),
        resourceId: v.string(),
        permission: v.picklist(["view", "edit", "full"]),
      }),
    ),
    async (c) => {
      const { resourceType, resourceId, permission } = c.req.valid("json");
      const userId = c.get("userId");

      if (
        (resourceType === "task_description" ||
          resourceType === "activity_comment") &&
        permission !== "view"
      ) {
        throw new HTTPException(400, {
          message: "This share resource only supports view links",
        });
      }

      // SPEC-2026-10-22 full-project-share-link: `full` is a project-only
      // capability — a single link must never carry whole-project powers for
      // a document, goal, or single task resource.
      if (permission === "full" && resourceType !== "project") {
        throw new HTTPException(400, {
          message: "Full links are only available for projects",
        });
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

      // Full capabilities are deliberately narrower than ordinary share
      // links: only an authenticated workspace owner/admin (or instance
      // administrator) may create them, even if a custom role was granted
      // project:share for view/edit link administration.
      if (resourceType === "project" && permission === "full") {
        const [user] = await db
          .select({ role: schema.userTable.role })
          .from(schema.userTable)
          .where(eq(schema.userTable.id, userId))
          .limit(1);
        const [membership] = await db
          .select({ role: schema.workspaceUserTable.role })
          .from(schema.workspaceUserTable)
          .where(
            and(
              eq(schema.workspaceUserTable.userId, userId),
              eq(schema.workspaceUserTable.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        if (
          user?.role !== "admin" &&
          membership?.role !== "admin" &&
          membership?.role !== "owner"
        ) {
          throw new HTTPException(403, {
            message: "Only workspace owners and admins can create full project links",
          });
        }
      }

      if (
        resourceType === "project" &&
        permission === "edit" &&
        (await isProjectAgentControlled(resourceId))
      ) {
        throw new HTTPException(403, {
          message: "Agent-controlled projects do not support public edit links",
        });
      }
      // NOTE: `full` links are intentionally allowed for agent-controlled
      // projects — restrictions are enforced per object at use time (spec
      // Assumptions + T1 matrix §B). Only the basic-edit guard stays.

      if (resourceType === "task_description") {
        const [task] = await db
          .select({ projectId: schema.taskTable.projectId })
          .from(schema.taskTable)
          .where(eq(schema.taskTable.id, resourceId))
          .limit(1);
        if (!task || (await isProjectAgentControlled(task.projectId))) {
          throw new HTTPException(403, {
            message: "This task does not support public description links",
          });
        }
      }

      const rawToken = generateShareToken();
      const linkId = createId();
      let tokenCiphertext: string;
      try {
        tokenCiphertext = encryptShareToken(
          rawToken,
          shareLinkTokenAad({
            id: linkId,
            resourceType,
            resourceId,
            permission,
          }),
        );
      } catch {
        throw new HTTPException(503, {
          message: "Share-link encryption is not configured",
        });
      }
      const expiresAt =
        permission === "edit" || permission === "full"
          ? new Date(Date.now() + EDIT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000)
          : null;

      const created = await db
        .insert(schema.shareLinkTable)
        .values({
          id: linkId,
          resourceType,
          resourceId,
          permission,
          tokenHash: hashShareToken(rawToken),
          tokenCiphertext,
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
        resourceType: v.picklist([
          "project",
          "document",
          "goal",
          "task_description",
          "activity_comment",
        ]),
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
          tokenHash: schema.shareLinkTable.tokenHash,
          tokenCiphertext: schema.shareLinkTable.tokenCiphertext,
        })
        .from(schema.shareLinkTable)
        .where(and(...conditions))
        .orderBy(desc(schema.shareLinkTable.createdAt));

      const clientUrl = (
        process.env.KANEO_CLIENT_URL || "http://localhost:5173"
      ).replace(/\/$/, "");

      return c.json(
        links.map((link) => {
          const active =
            link.revokedAt === null &&
            (link.expiresAt === null || link.expiresAt.getTime() > Date.now());
          let url: string | null = null;
          if (active && link.tokenCiphertext) {
            try {
              const rawToken = decryptShareToken(
                link.tokenCiphertext,
                link.tokenHash,
                shareLinkTokenAad({
                  id: link.id,
                  resourceType: link.resourceType,
                  resourceId: link.resourceId,
                  permission: link.permission,
                }),
              );
              url = `${clientUrl}/share/${link.resourceType}/${rawToken}`;
            } catch {
              throw new HTTPException(503, {
                message: "Share-link encryption is unavailable",
              });
            }
          }
          return {
            id: link.id,
            resourceType: link.resourceType,
            resourceId: link.resourceId,
            permission: link.permission,
            expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
            revokedAt: link.revokedAt ? link.revokedAt.toISOString() : null,
            createdAt: link.createdAt.toISOString(),
            url,
          };
        }),
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
