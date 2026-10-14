import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { buildPublicProjectPayload } from "../project/controllers/public-project-dto";
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
      checkInDate: schema.goalCheckinTable.checkInDate,
      completed: schema.goalCheckinTable.completed,
      note: schema.goalCheckinTable.note,
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

export default app;
