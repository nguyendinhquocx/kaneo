import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import db, { schema } from "../database";
import { buildPublicProjectPayload } from "../project/controllers/public-project-dto";
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

  return c.json(payload);
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

  const document = await getPublicDocument(token);
  return c.json({
    id: document.id,
    title: document.title,
    content: document.content,
    revision: document.revision,
    updatedAt: document.updatedAt,
  });
});

// Agent-readable Markdown: raw text/markdown over plain HTTP, no JS/cookie/
// login/Tailscale required.
app.get("/document/:token/raw", async (c) => {
  const token = c.req.param("token");
  assertShareRateLimit(c, "read", hashShareToken(token));

  const document = await getPublicDocument(token);
  return c.body(document.content, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
  });
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
    checkins,
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
