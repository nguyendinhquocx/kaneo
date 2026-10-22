import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import db, { schema } from "../database";
import {
  buildPublicProjectPayload,
  isProjectAgentControlled,
} from "../project/controllers/public-project-dto";
import { buildAssetResponse } from "../storage/asset-response";
import { contentReferencesAsset } from "../storage/cleanup-assets";
import { getPrivateObject } from "../storage/s3";
import { rewriteContentAssetRefs } from "./agent-content";

// Public origin for share asset rewrites. Behind the reverse proxy c.req.url
// carries the internal http scheme/host, so configured origins must win —
// otherwise absolute same-origin asset refs never match and stay private.
function shareOrigin(fallback: string): string {
  const configured =
    process.env.KANEO_PUBLIC_API_URL?.trim() ||
    process.env.KANEO_API_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Misconfigured URL falls through to the request origin.
    }
  }
  return fallback;
}

import {
  publicCreateTask,
  publicToggleGoalCheckin,
  publicUpdateDocument,
  publicUpdateGoalNote,
  publicUpdateTask,
} from "./public-write";
import {
  applyShareSecurityHeaders,
  assertShareRateLimit,
  isShareResourceType,
  type ResolvedShareLink,
  resolveShareLink,
} from "./resolve-share-link";
import { hashShareToken } from "./token";

// SPEC-2026-10-08-kaneo-workspace-collaboration T2: unauthenticated
// capability routes. Registered in index.ts BEFORE the global authentication
// middleware; each handler validates token/resource/permission/expiry itself
// and fails closed. Wildcard auth must never be weakened for these.

const app = new Hono();

// Security headers on every share response, including errors.
app.use("*", async (c, next) => {
  applyShareSecurityHeaders(c);
  await next();
});

app.get("/project/:token", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "read", hashShareToken(token));

  const link = await resolveShareLink(token, "project", "view");
  const payload = await buildPublicProjectPayload(link.resourceId, {
    requirePublic: false,
  });
  const isReadOnly =
    link.permission === "edit" &&
    (await isProjectAgentControlled(link.resourceId));

  // Task descriptions can embed asset refs; share-scoped URLs let the link
  // holder fetch them with the same capability instead of leaking private
  // /api/asset/ paths that 401 for anonymous consumers.
  const origin = shareOrigin(new URL(c.req.url).origin);
  const withAssetUrls = (description: string | null): string | null =>
    description
      ? rewriteContentAssetRefs(description, origin, "project", token)
      : description;
  const withTaskAssetUrls = <T extends { description: string | null }>(
    task: T,
  ): T => ({
    ...task,
    description: withAssetUrls(task.description),
  });

  return c.json({
    ...payload,
    description: withAssetUrls(payload.description),
    columns: payload.columns.map((column) => ({
      ...column,
      tasks: column.tasks.map(withTaskAssetUrls),
    })),
    archivedTasks: payload.archivedTasks.map(withTaskAssetUrls),
    plannedTasks: payload.plannedTasks.map(withTaskAssetUrls),
    // Existing edit links may predate agent control; never advertise an edit
    // affordance when the public write routes will refuse the operation.
    scope: isReadOnly ? "view" : link.permission,
  });
});

// SPEC-2026-10-08-kaneo-workspace-collaboration T3/T4: capability-scoped
// document reads. The link grants exactly this document — never the project,
// its tasks, or sibling documents. Archived documents fail closed so a
// stale link cannot resurrect hidden content.
async function getPublicDocument(token: string) {
  const link = await resolveShareLink(token, "document", "view");
  const [document] = await db
    .select()
    .from(schema.documentTable)
    .where(eq(schema.documentTable.id, link.resourceId))
    .limit(1);

  if (!document || document.archivedAt !== null) {
    throw new HTTPException(404, {
      message: "Not found",
    });
  }
  return document;
}

app.get("/document/:token", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "read", hashShareToken(token));

  const link = await resolveShareLink(token, "document", "view");
  const document = await getPublicDocument(token);
  const origin = shareOrigin(new URL(c.req.url).origin);
  return c.json({
    id: document.id,
    title: document.title,
    content: rewriteContentAssetRefs(
      document.content,
      origin,
      "document",
      token,
    ),
    revision: document.revision,
    updatedAt: document.updatedAt,
    scope: link.permission,
  });
});

async function getPublicTaskDescription(token: string) {
  const link = await resolveShareLink(token, "task_description", "view");
  const [task] = await db
    .select({
      id: schema.taskTable.id,
      projectId: schema.taskTable.projectId,
      title: schema.taskTable.title,
      description: schema.taskTable.description,
    })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, link.resourceId))
    .limit(1);
  if (!task || (await isProjectAgentControlled(task.projectId))) {
    throw new HTTPException(404, { message: "Not found" });
  }
  return { link, task };
}

async function getPublicActivityComment(token: string) {
  const link = await resolveShareLink(token, "activity_comment", "view");
  const [comment] = await db
    .select({
      id: schema.activityTable.id,
      taskId: schema.activityTable.taskId,
      content: schema.activityTable.content,
      createdAt: schema.activityTable.createdAt,
    })
    .from(schema.activityTable)
    .where(
      and(
        eq(schema.activityTable.id, link.resourceId),
        eq(schema.activityTable.type, "comment"),
      ),
    )
    .limit(1);
  if (!comment) {
    throw new HTTPException(404, { message: "Not found" });
  }
  return { link, comment };
}

app.get("/task_description/:token", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "read", hashShareToken(token));
  const { link, task } = await getPublicTaskDescription(token);
  const origin = shareOrigin(new URL(c.req.url).origin);
  return c.json({
    title: task.title,
    content: task.description
      ? rewriteContentAssetRefs(
          task.description,
          origin,
          "task_description",
          token,
        )
      : task.description,
    scope: link.permission,
  });
});

app.get("/activity_comment/:token", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "read", hashShareToken(token));
  const { link, comment } = await getPublicActivityComment(token);
  const origin = shareOrigin(new URL(c.req.url).origin);
  return c.json({
    content: comment.content
      ? rewriteContentAssetRefs(
          comment.content,
          origin,
          "activity_comment",
          token,
        )
      : comment.content,
    createdAt: comment.createdAt,
    scope: link.permission,
  });
});

async function canShareReadAsset(
  link: ResolvedShareLink,
  asset: {
    id: string;
    projectId: string | null;
    taskId: string | null;
    activityId: string | null;
    surface: string;
    documentId: string | null;
    goalCheckinId: string | null;
  },
): Promise<boolean> {
  if (link.resourceType === "project") {
    if (
      asset.projectId !== link.resourceId ||
      !asset.taskId ||
      asset.surface !== "description"
    ) {
      return false;
    }
    const payload = await buildPublicProjectPayload(link.resourceId, {
      requirePublic: false,
    });
    return [
      ...payload.columns.flatMap((column) => column.tasks),
      ...payload.archivedTasks,
      ...payload.plannedTasks,
    ].some(
      (task) =>
        task.id === asset.taskId &&
        task.description !== null &&
        contentReferencesAsset(task.description, asset.id),
    );
  }

  if (link.resourceType === "document") {
    if (asset.documentId !== link.resourceId || asset.surface !== "document") {
      return false;
    }
    const document = await getPublicDocumentFromId(link.resourceId);
    return contentReferencesAsset(document.content, asset.id);
  }

  if (link.resourceType === "goal") {
    if (!asset.goalCheckinId || asset.surface !== "goal_note") return false;
    const [checkin] = await db
      .select({
        goalId: schema.goalCheckinTable.goalId,
        note: schema.goalCheckinTable.note,
      })
      .from(schema.goalCheckinTable)
      .where(eq(schema.goalCheckinTable.id, asset.goalCheckinId))
      .limit(1);
    return Boolean(
      checkin &&
        checkin.goalId === link.resourceId &&
        contentReferencesAsset(checkin.note, asset.id),
    );
  }

  if (link.resourceType === "task_description") {
    if (asset.taskId !== link.resourceId || asset.surface !== "description") {
      return false;
    }
    const { task } = await getPublicTaskDescriptionFromId(link.resourceId);
    return contentReferencesAsset(task.description, asset.id);
  }

  const { comment } = await getPublicActivityCommentById(link.resourceId);
  const isCommentUpload =
    asset.surface === "comment" &&
    (asset.activityId === null || asset.activityId === comment.id);
  const isCopiedTaskAsset =
    asset.surface === "description" && asset.activityId === null;
  if (
    asset.taskId !== comment.taskId ||
    (!isCommentUpload && !isCopiedTaskAsset)
  ) {
    return false;
  }
  // A comment may reuse an image uploaded to its task description. Sharing the
  // comment grants only assets its exact Markdown references, never siblings.
  return contentReferencesAsset(comment.content, asset.id);
}

async function getPublicDocumentFromId(documentId: string) {
  const [document] = await db
    .select()
    .from(schema.documentTable)
    .where(eq(schema.documentTable.id, documentId))
    .limit(1);
  if (!document || document.archivedAt !== null) {
    throw new HTTPException(404, { message: "Not found" });
  }
  return document;
}

async function getPublicTaskDescriptionFromId(taskId: string) {
  const [task] = await db
    .select({
      id: schema.taskTable.id,
      projectId: schema.taskTable.projectId,
      title: schema.taskTable.title,
      description: schema.taskTable.description,
    })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, taskId))
    .limit(1);
  if (!task || (await isProjectAgentControlled(task.projectId))) {
    throw new HTTPException(404, { message: "Not found" });
  }
  return { task };
}

async function getPublicActivityCommentById(commentId: string) {
  const [comment] = await db
    .select({
      id: schema.activityTable.id,
      taskId: schema.activityTable.taskId,
      content: schema.activityTable.content,
    })
    .from(schema.activityTable)
    .where(
      and(
        eq(schema.activityTable.id, commentId),
        eq(schema.activityTable.type, "comment"),
      ),
    )
    .limit(1);
  if (!comment) throw new HTTPException(404, { message: "Not found" });
  return { comment };
}

app.get("/:resourceType/:token/asset/:assetId", async (c) => {
  const resourceType = c.req.param("resourceType");
  const token = c.req.param("token");
  const assetId = c.req.param("assetId");
  if (!isShareResourceType(resourceType)) {
    throw new HTTPException(404, { message: "Not found" });
  }

  assertShareRateLimit(c, "read", hashShareToken(token));
  const link = await resolveShareLink(token, resourceType, "view");
  const [asset] = await db
    .select({
      id: schema.assetTable.id,
      objectKey: schema.assetTable.objectKey,
      filename: schema.assetTable.filename,
      mimeType: schema.assetTable.mimeType,
      projectId: schema.assetTable.projectId,
      taskId: schema.assetTable.taskId,
      activityId: schema.assetTable.activityId,
      surface: schema.assetTable.surface,
      documentId: schema.assetTable.documentId,
      goalCheckinId: schema.assetTable.goalCheckinId,
    })
    .from(schema.assetTable)
    .where(eq(schema.assetTable.id, assetId))
    .limit(1);

  if (!asset || !(await canShareReadAsset(link, asset))) {
    throw new HTTPException(404, { message: "Not found" });
  }

  try {
    const object = await getPrivateObject(asset.objectKey);
    return buildAssetResponse(asset, object, "private, no-store");
  } catch {
    throw new HTTPException(404, { message: "Not found" });
  }
});

// Agent-readable Markdown: raw text/markdown over plain HTTP, no JS/cookie/
// login/Tailscale required. Asset references are rewritten to absolute
// share-scoped URLs so an agent can fetch images/files with the same
// capability in one request each.
app.get("/document/:token/raw", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "read", hashShareToken(token));

  const document = await getPublicDocument(token);
  const origin = shareOrigin(new URL(c.req.url).origin);
  return c.body(
    rewriteContentAssetRefs(document.content, origin, "document", token),
    200,
    {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  );
});

// Agent-readable task description: the title as an H1 followed by the
// description markdown with fetchable asset URLs.
app.get("/task_description/:token/raw", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "read", hashShareToken(token));

  const { task } = await getPublicTaskDescription(token);
  const origin = shareOrigin(new URL(c.req.url).origin);
  const heading = task.title ? `# ${task.title}\n\n` : "";
  return c.body(
    heading +
      rewriteContentAssetRefs(
        task.description ?? "",
        origin,
        "task_description",
        token,
      ),
    200,
    {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  );
});

// Agent-readable comment: the comment markdown with fetchable asset URLs.
app.get("/activity_comment/:token/raw", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "read", hashShareToken(token));

  const { comment } = await getPublicActivityComment(token);
  const origin = shareOrigin(new URL(c.req.url).origin);
  return c.body(
    rewriteContentAssetRefs(
      comment.content ?? "",
      origin,
      "activity_comment",
      token,
    ),
    200,
    {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  );
});

// Goal capability read: the link grants exactly this goal's check-in history
// (dates, completion, notes). No owner identity, no workspace/project IDs.
app.get("/goal/:token", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "read", hashShareToken(token));

  const link = await resolveShareLink(token, "goal", "view");
  const [goal] = await db
    .select()
    .from(schema.goalTable)
    .where(eq(schema.goalTable.id, link.resourceId))
    .limit(1);
  if (!goal) {
    throw new HTTPException(404, { message: "Not found" });
  }

  const checkins = await db
    .select({
      id: schema.goalCheckinTable.id,
      checkInDate: schema.goalCheckinTable.checkInDate,
      completed: schema.goalCheckinTable.completed,
      note: schema.goalCheckinTable.note,
      noteRevision: schema.goalCheckinTable.noteRevision,
    })
    .from(schema.goalCheckinTable)
    .where(eq(schema.goalCheckinTable.goalId, goal.id))
    .orderBy(schema.goalCheckinTable.checkInDate);

  return c.json({
    id: goal.id,
    name: goal.name,
    timezone: goal.timezone,
    targetPerWeek: goal.targetPerWeek,
    archivedAt: goal.archivedAt,
    // R2-T8: the page renders an interactive matrix only for edit links.
    // Exposing the link's own scope to the link holder reveals nothing the
    // holder cannot probe by attempting a write.
    scope: link.permission,
    checkins: checkins.map((checkin) => ({
      ...checkin,
      note: checkin.note
        ? rewriteContentAssetRefs(
            checkin.note,
            new URL(c.req.url).origin,
            "goal",
            token,
          )
        : checkin.note,
    })),
  });
});

// --- T7: anonymous writes through edit links ------------------------------
// View links can never mutate (resolveShareLink enforces permission); edit
// links expire in 30 days and every write is audited by share-link ID.

const taskCreateSchema = v.object({
  title: v.string(),
  description: v.optional(v.string()),
  status: v.optional(v.string()),
  priority: v.optional(v.string()),
  startDate: v.optional(v.string()),
  dueDate: v.optional(v.string()),
});

const taskUpdateSchema = v.object({
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  status: v.optional(v.string()),
  priority: v.optional(v.string()),
  startDate: v.optional(v.nullable(v.string())),
  dueDate: v.optional(v.nullable(v.string())),
});

app.post("/project/:token/task", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "write", hashShareToken(token));

  const link = await resolveShareLink(token, "project", "edit");
  const body = await c.req.json().then((raw) => v.parse(taskCreateSchema, raw));
  const task = await publicCreateTask(link, body);
  return c.json(task);
});

app.put("/project/:token/task/:taskId", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "write", hashShareToken(token));

  const link = await resolveShareLink(token, "project", "edit");
  const taskId = c.req.param("taskId");
  const body = await c.req.json().then((raw) => v.parse(taskUpdateSchema, raw));
  const task = await publicUpdateTask(link, taskId, body);
  return c.json(task);
});

const documentUpdateSchema = v.object({
  title: v.string(),
  content: v.string(),
  revision: v.number(),
});

app.put("/document/:token", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "write", hashShareToken(token));

  const link = await resolveShareLink(token, "document", "edit");
  const body = await c.req
    .json()
    .then((raw) => v.parse(documentUpdateSchema, raw));
  const document = await publicUpdateDocument(link, body);
  return c.json(document);
});

const checkinToggleSchema = v.object({ date: v.string() });

app.post("/goal/:token/checkin", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "write", hashShareToken(token));

  const link = await resolveShareLink(token, "goal", "edit");
  const body = await c.req
    .json()
    .then((raw) => v.parse(checkinToggleSchema, raw));
  const row = await publicToggleGoalCheckin(link, body.date);
  return c.json(row);
});

const checkinNoteSchema = v.object({
  note: v.string(),
  noteRevision: v.number(),
});

app.put("/goal/:token/checkin/:checkinId", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "write", hashShareToken(token));

  const link = await resolveShareLink(token, "goal", "edit");
  const checkinId = c.req.param("checkinId");
  const body = await c.req
    .json()
    .then((raw) => v.parse(checkinNoteSchema, raw));
  const row = await publicUpdateGoalNote(link, checkinId, body);
  return c.json(row);
});

export default app;
