import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import db, { schema } from "../database";
import { publishEvent } from "../events";
import { phaseCardTaskGuard } from "../execution/phase-progress";
import {
  canWriteGoal,
  getGoal,
  getGoalCheckin,
} from "../goal/controllers/goal-controllers";
import {
  assertContentAssetKeyMatchesContext,
  type ContentAssetOwnerType,
  createContentAssetUploadUrl,
  isImageContentType,
  validateTaskAssetUploadInput,
} from "../storage/s3";
import { normalizeApiServerUrl } from "../utils/openapi-spec";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { validateWorkspaceAccess } from "../utils/validate-workspace-access";

const ownerTypeSchema = v.picklist([
  "task_description",
  "task_comment",
  "document",
  "document_comment",
  "goal_checkin",
]);

const uploadRequestSchema = v.object({
  ownerType: ownerTypeSchema,
  ownerId: v.string(),
  filename: v.string(),
  contentType: v.string(),
  size: v.number(),
});

const finalizeRequestSchema = v.object({
  ownerType: ownerTypeSchema,
  ownerId: v.string(),
  key: v.string(),
  filename: v.string(),
  contentType: v.string(),
  size: v.number(),
});

type UploadOwner = {
  ownerType: ContentAssetOwnerType;
  ownerId: string;
  workspaceId: string;
  projectId: string | null;
  taskId: string | null;
  documentId: string | null;
  goalCheckinId: string | null;
  surface: string;
};

type ContentAssetEnv = {
  Variables: {
    userId: string;
    workspaceId: string;
    apiKey?: {
      id: string;
      permissions: Record<string, string[]> | null;
    };
  };
};

const contentAsset = new Hono<ContentAssetEnv>();

async function resolveUploadOwner(
  c: Context<ContentAssetEnv>,
  input: { ownerType: ContentAssetOwnerType; ownerId: string },
): Promise<UploadOwner> {
  let owner: UploadOwner | null = null;

  if (
    input.ownerType === "task_description" ||
    input.ownerType === "task_comment"
  ) {
    const [task] = await db
      .select({
        taskId: schema.taskTable.id,
        projectId: schema.taskTable.projectId,
        workspaceId: schema.projectTable.workspaceId,
      })
      .from(schema.taskTable)
      .innerJoin(
        schema.projectTable,
        eq(schema.taskTable.projectId, schema.projectTable.id),
      )
      .where(eq(schema.taskTable.id, input.ownerId))
      .limit(1);

    if (task) {
      owner = {
        ...input,
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        taskId: task.taskId,
        documentId: null,
        goalCheckinId: null,
        surface: input.ownerType === "task_comment" ? "comment" : "description",
      };
    }
  } else if (
    input.ownerType === "document" ||
    input.ownerType === "document_comment"
  ) {
    const [document] = await db
      .select({
        documentId: schema.documentTable.id,
        projectId: schema.documentTable.projectId,
        archivedAt: schema.documentTable.archivedAt,
        workspaceId: schema.projectTable.workspaceId,
      })
      .from(schema.documentTable)
      .innerJoin(
        schema.projectTable,
        eq(schema.documentTable.projectId, schema.projectTable.id),
      )
      .where(eq(schema.documentTable.id, input.ownerId))
      .limit(1);

    if (document && document.archivedAt === null) {
      owner = {
        ...input,
        workspaceId: document.workspaceId,
        projectId: document.projectId,
        taskId: null,
        documentId: document.documentId,
        goalCheckinId: null,
        surface:
          input.ownerType === "document_comment"
            ? "document_comment"
            : "document",
      };
    }
  } else {
    const checkin = await getGoalCheckin(input.ownerId).catch(() => null);
    if (checkin) {
      const goal = await getGoal(checkin.goalId).catch(() => null);
      if (goal) {
        owner = {
          ...input,
          workspaceId: goal.workspaceId,
          projectId: goal.projectId,
          taskId: null,
          documentId: null,
          goalCheckinId: checkin.id,
          surface: "goal_note",
        };
      }
    }
  }

  if (!owner) {
    throw new HTTPException(404, { message: "Content resource not found" });
  }

  const userId = c.get("userId");
  const apiKey = c.get("apiKey");
  await validateWorkspaceAccess(userId, owner.workspaceId, apiKey?.id);
  c.set("workspaceId", owner.workspaceId);

  if (owner.ownerType === "goal_checkin") {
    const checkin = await getGoalCheckin(owner.ownerId);
    const goal = await getGoal(checkin.goalId);
    if (goal.archivedAt !== null || !(await canWriteGoal(goal, userId))) {
      throw new HTTPException(403, { message: "Forbidden" });
    }
    if (apiKey && !apiKey.permissions?.task?.includes("update")) {
      throw new HTTPException(403, {
        message: "Insufficient API key scope",
      });
    }
  } else {
    const permissionMiddleware = requireWorkspacePermission({
      task: ["update"],
    });
    await permissionMiddleware(c, async () => {});
  }

  if (owner.taskId) {
    const guard = phaseCardTaskGuard("body", "ownerId");
    await guard(c, async () => {});
  }

  return owner;
}

async function getAssetApiBase(c: Context<ContentAssetEnv>) {
  return normalizeApiServerUrl(
    process.env.KANEO_PUBLIC_API_URL ||
      process.env.KANEO_API_URL ||
      new URL(c.req.url).origin,
  );
}

contentAsset.put(
  "/upload",
  describeRoute({
    operationId: "createContentAssetUpload",
    tags: ["Assets"],
    description:
      "Create a private presigned upload for task, document, or goal content",
    responses: {
      200: {
        description: "Upload URL created",
        content: { "application/json": { schema: resolver(v.any()) } },
      },
    },
  }),
  validator("json", uploadRequestSchema),
  async (c) => {
    const input = c.req.valid("json");
    const owner = await resolveUploadOwner(c, input);
    try {
      validateTaskAssetUploadInput(input.contentType, input.size);
    } catch (error) {
      throw new HTTPException(400, {
        message:
          error instanceof Error ? error.message : "Invalid asset upload",
      });
    }

    try {
      const upload = await createContentAssetUploadUrl({
        workspaceId: owner.workspaceId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        filename: input.filename,
        contentType: input.contentType,
      });
      return c.json(upload);
    } catch (error) {
      throw new HTTPException(503, {
        message:
          error instanceof Error ? error.message : "Content upload unavailable",
      });
    }
  },
);

contentAsset.post(
  "/finalize",
  describeRoute({
    operationId: "finalizeContentAssetUpload",
    tags: ["Assets"],
    description: "Bind a private uploaded object to its content owner",
    responses: {
      200: {
        description: "Content asset finalized",
        content: { "application/json": { schema: resolver(v.any()) } },
      },
    },
  }),
  validator("json", finalizeRequestSchema),
  async (c) => {
    const input = c.req.valid("json");
    const owner = await resolveUploadOwner(c, input);
    try {
      validateTaskAssetUploadInput(input.contentType, input.size);
    } catch (error) {
      throw new HTTPException(400, {
        message:
          error instanceof Error ? error.message : "Invalid asset upload",
      });
    }

    const normalizedKey = input.key.trim();
    if (
      !assertContentAssetKeyMatchesContext(normalizedKey, {
        workspaceId: owner.workspaceId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
      })
    ) {
      throw new HTTPException(400, {
        message: "Upload key does not match the content resource.",
      });
    }

    const [existing] = await db
      .select({ id: schema.assetTable.id })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, normalizedKey))
      .limit(1);

    const values = {
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
      taskId: owner.taskId,
      documentId: owner.documentId,
      goalCheckinId: owner.goalCheckinId,
      filename: input.filename,
      mimeType: input.contentType,
      size: input.size,
      kind: isImageContentType(input.contentType) ? "image" : "attachment",
      surface: owner.surface,
      createdBy: c.get("userId") || null,
    };

    const [asset] = existing
      ? await db
          .update(schema.assetTable)
          .set(values)
          .where(eq(schema.assetTable.id, existing.id))
          .returning({ id: schema.assetTable.id })
      : await db
          .insert(schema.assetTable)
          .values({ ...values, objectKey: normalizedKey })
          .returning({ id: schema.assetTable.id });

    if (!asset) {
      throw new HTTPException(500, {
        message: "Failed to persist content asset",
      });
    }

    if (owner.taskId && owner.projectId) {
      await publishEvent("asset.created", {
        taskId: owner.taskId,
        projectId: owner.projectId,
      });
    }

    const apiBaseUrl = await getAssetApiBase(c);
    return c.json({
      id: asset.id,
      url: `${apiBaseUrl}/asset/${asset.id}`,
      filename: input.filename,
      mimeType: input.contentType,
      size: input.size,
      kind: values.kind,
    });
  },
);

export default contentAsset;
