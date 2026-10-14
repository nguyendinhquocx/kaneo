import { Hono } from "hono";
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

export default app;
