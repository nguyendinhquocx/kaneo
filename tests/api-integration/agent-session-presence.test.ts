import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import {
  mockAuthenticatedSession,
  mockAuthenticatedSessions,
} from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";
import {
  PRESENCE_TTL_MS,
  sweepStalePresence,
} from "../../apps/api/src/agent-session/presence-service";

// SPEC-2026-11-25-kaneo-ui-agent-binding T1: presence announce/roster, the
// web-caller bind ownership guard, and the heartbeat presence piggyback.

function hashApiKey(key: string) {
  return createHash("sha256")
    .update(key)
    .digest()
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

let principalSeq = 0;

async function seedPrincipal(userId: string, hostId: string) {
  const [principal] = await db
    .insert(schema.agentPrincipalTable)
    .values({
      userId,
      runtimeId: `pi-${hostId}-${++principalSeq}`,
      hostId,
      scopes: ["run:claim"],
      isActive: true,
    })
    .returning();
  return principal;
}

async function createTask(projectId: string, title: string, number: number | null = null) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title,
      status: "to-do",
      number,
    })
    .returning();
  return task;
}

async function announce(
  app: ReturnType<typeof createApp>["app"],
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.request("/api/agent-session/sessions/announce", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function createApiKeyForUser(userId: string, key: string) {
  await db.insert(schema.apikeyTable).values({
    referenceId: userId,
    userId,
    key: hashApiKey(key),
    start: key.slice(0, 4),
    createdAt: new Date(),
    updatedAt: new Date(),
    permissions: JSON.stringify({ task: ["update"] }),
  });
}

describe("API integration: agent session presence (SPEC-2026-11-25 T1)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    // Deterministic sweep rolls: 1 never sweeps, 0 always sweeps.
    vi.spyOn(Math, "random").mockReturnValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("announce twice upserts one row with fresh last_seen_at and returns the full binding shape when bound", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await createTask(project.id, "Bound card", 23);
    const principal = await seedPrincipal(admin.user.id, "pi-laptop");
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();

    const body = {
      sessionId: "pi-session-announce",
      agentPrincipalId: principal.id,
      host: "pi-laptop",
      title: "fix build",
      cwd: "D:/work/app",
      model: "glm-5.3-flash",
    };
    const first = await announce(app, body);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { binding: null }).binding).toBeNull();

    // Bind through the API-key path so the session becomes bound, then
    // announce again to receive the full adopt-ready binding shape.
    const key = "test-api-key-announce";
    await createApiKeyForUser(admin.user.id, key);
    const bindResponse = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({
        taskId: task.id,
        agentPrincipalId: principal.id,
        sessionId: "pi-session-announce",
      }),
    });
    expect(bindResponse.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await announce(app, body);
    expect(second.status).toBe(200);
    const payload = (await second.json()) as {
      binding: {
        bindingId: string;
        bindingGeneration: number;
        taskId: string;
        projectId: string;
        sessionId: string;
        hostId: string;
        status: string;
        revision: number;
        taskTitle: string;
        taskNumber: number | null;
      } | null;
    };
    expect(payload.binding).not.toBeNull();
    const binding = payload.binding!;
    expect(binding.taskId).toBe(task.id);
    expect(binding.projectId).toBe(project.id);
    expect(binding.hostId).toBe("pi-laptop");
    expect(binding.status).toBe("active");
    expect(binding.taskTitle).toBe("Bound card");
    expect(binding.taskNumber).toBe(23);
    expect(typeof binding.bindingId).toBe("string");
    expect(binding.bindingGeneration).toBe(1);
    expect(typeof binding.revision).toBe("number");

    // Exactly one presence row, last_seen_at refreshed by the second call.
    const [row] = await db
      .select()
      .from(schema.agentSessionPresenceTable)
      .where(
        eq(schema.agentSessionPresenceTable.sessionId, "pi-session-announce"),
      );
    expect(row).toBeDefined();
    expect(row!.title).toBe("fix build");
    expect(Date.now() - row!.lastSeenAt.getTime()).toBeLessThan(1000);
    const all = await db.select().from(schema.agentSessionPresenceTable);
    expect(all).toHaveLength(1);
  });

  it("announce with a principal not owned by the caller is a 403", async () => {
    const owner = await createWorkspaceMember({ role: "admin" });
    const stranger = await createWorkspaceMember({ role: "admin" });
    const strangerPrincipal = await seedPrincipal(stranger.user.id, "pi-laptop");
    mockAuthenticatedSession(owner.user);
    const { app } = createApp();
    const response = await announce(app, {
      sessionId: "pi-session-x",
      agentPrincipalId: strangerPrincipal.id,
      host: "pi-laptop",
    });
    expect(response.status).toBe(403);
  });

  it("roster returns only TTL-live rows of the caller's principals, sorted by host, with bound task info", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const boundTask = await createTask(project.id, "Bound elsewhere", 7);
    const stranger = await createWorkspaceMember({ role: "admin" });
    const adminLaptop = await seedPrincipal(admin.user.id, "pi-laptop");
    const adminProdesk = await seedPrincipal(admin.user.id, "prodesk-home");
    const strangerPrincipal = await seedPrincipal(stranger.user.id, "pi-laptop");

    await db.insert(schema.agentSessionPresenceTable).values([
      {
        sessionId: "pi-live-b",
        agentPrincipalId: adminLaptop.id,
        host: "pi-laptop",
        title: "later",
        cwd: "/work/b",
        model: "luna",
        lastSeenAt: new Date(Date.now() - 30_000),
      },
      {
        sessionId: "pi-live-a",
        agentPrincipalId: adminLaptop.id,
        host: "pi-laptop",
        title: "earlier",
        cwd: "/work/a",
        model: "glm",
        lastSeenAt: new Date(Date.now() - 10_000),
      },
      {
        sessionId: "pi-desk",
        agentPrincipalId: adminProdesk.id,
        host: "prodesk-home",
        title: "desk",
        cwd: "/work/d",
        model: "sonnet",
      },
      {
        sessionId: "pi-expired",
        agentPrincipalId: adminLaptop.id,
        host: "pi-laptop",
        title: "gone",
        cwd: "/work/g",
        model: "old",
        lastSeenAt: new Date(Date.now() - PRESENCE_TTL_MS - 60_000),
      },
      {
        sessionId: "pi-stranger",
        agentPrincipalId: strangerPrincipal.id,
        host: "pi-laptop",
        title: "not mine",
      },
    ]);

    const key = "test-api-key-roster-bind";
    await createApiKeyForUser(admin.user.id, key);
    mockAuthenticatedSessions(admin.user, {});
    const { app } = createApp();
    const bindResponse = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        taskId: boundTask.id,
        agentPrincipalId: adminLaptop.id,
        sessionId: "pi-live-b",
      }),
    });
    expect(bindResponse.status).toBe(200);

    mockAuthenticatedSession(admin.user);
    const roster = await app.request("/api/agent-session/sessions/roster");
    expect(roster.status).toBe(200);
    const { sessions } = (await roster.json()) as {
      sessions: Array<{
        sessionId: string;
        host: string;
        agentPrincipalId: string;
        lastSeenAt: string;
        binding: { taskId: string; taskTitle: string; taskNumber: number | null } | null;
      }>;
    };

    const ids = sessions.map((session) => session.sessionId);
    expect(ids).toContain("pi-live-a");
    expect(ids).toContain("pi-live-b");
    expect(ids).toContain("pi-desk");
    // TTL-expired rows never appear; other users' rows never appear.
    expect(ids).not.toContain("pi-expired");
    expect(ids).not.toContain("pi-stranger");

    const boundRow = sessions.find((session) => session.sessionId === "pi-live-b");
    expect(boundRow!.binding).not.toBeNull();
    expect(boundRow!.binding!.taskId).toBe(boundTask.id);
    expect(boundRow!.binding!.taskTitle).toBe("Bound elsewhere");
    expect(boundRow!.binding!.taskNumber).toBe(7);
    expect(boundRow!.agentPrincipalId).toBe(adminLaptop.id);
    const unboundRow = sessions.find((session) => session.sessionId === "pi-live-a");
    expect(unboundRow!.binding).toBeNull();

    // Host groups ascending; within a host, most recent first.
    expect(sessions[0]!.host).toBe("pi-laptop");
    expect(ids.indexOf("pi-live-a")).toBeLessThan(ids.indexOf("pi-live-b"));
  });

  it("web callers may only bind sessions with their own recent presence; API-key callers skip the guard", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const taskA = await createTask(project.id, "Card A");
    const taskB = await createTask(project.id, "Card B");
    const principal = await seedPrincipal(admin.user.id, "pi-laptop");
    await db.insert(schema.agentSessionPresenceTable).values({
      sessionId: "pi-announced",
      agentPrincipalId: principal.id,
      host: "pi-laptop",
    });
    const key = "test-api-key-bind-guard";
    await createApiKeyForUser(admin.user.id, key);
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();

    // Web caller + announced session passes.
    const okResponse = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: taskA.id,
        agentPrincipalId: principal.id,
        sessionId: "pi-announced",
      }),
    });
    expect(okResponse.status).toBe(200);

    // Web caller + unknown session string is blocked.
    const blocked = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: taskB.id,
        agentPrincipalId: principal.id,
        sessionId: "pi-never-announced",
      }),
    });
    expect(blocked.status).toBe(403);

    // API-key caller (extension /kaneo-card cold start) skips the guard.
    const apiKeyBind = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        taskId: taskB.id,
        agentPrincipalId: principal.id,
        sessionId: "pi-cold-start",
      }),
    });
    expect(apiKeyBind.status).toBe(200);
  });

  it("the web-bind guard honors the 1x TTL grace window for a recently expired row", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await createTask(project.id, "Slow announce");
    const principal = await seedPrincipal(admin.user.id, "pi-laptop");
    await db.insert(schema.agentSessionPresenceTable).values({
      sessionId: "pi-slow",
      agentPrincipalId: principal.id,
      host: "pi-laptop",
      lastSeenAt: new Date(Date.now() - PRESENCE_TTL_MS - 30_000),
    });
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const response = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: task.id,
        agentPrincipalId: principal.id,
        sessionId: "pi-slow",
      }),
    });
    expect(response.status).toBe(200);
  });

  it("heartbeat piggyback upserts presence, including for a session that never announced", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await createTask(project.id, "Restored bound card");
    const principal = await seedPrincipal(admin.user.id, "prodesk-home");
    const key = "test-api-key-heartbeat";
    await createApiKeyForUser(admin.user.id, key);
    mockAuthenticatedSessions(admin.user, {});
    const { app } = createApp();

    const bindResponse = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        taskId: task.id,
        agentPrincipalId: principal.id,
        sessionId: "pi-restored-bound",
      }),
    });
    expect(bindResponse.status).toBe(200);
    const bound = (await bindResponse.json()) as {
      bindingId: string;
      bindingGeneration: number;
    };

    // Restore/resume case: no announce ever ran for this session.
    const [before] = await db
      .select()
      .from(schema.agentSessionPresenceTable)
      .where(
        eq(schema.agentSessionPresenceTable.sessionId, "pi-restored-bound"),
      );
    expect(before).toBeUndefined();

    const heartbeat = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          sessionId: "pi-restored-bound",
          generation: bound.bindingGeneration,
        }),
      },
    );
    expect(heartbeat.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.agentSessionPresenceTable)
      .where(
        eq(schema.agentSessionPresenceTable.sessionId, "pi-restored-bound"),
      );
    expect(row).toBeDefined();
    expect(row!.agentPrincipalId).toBe(principal.id);
    expect(row!.host).toBe("prodesk-home");
  });

  it("heartbeat keeps pre-announced title/cwd/model and fills host/principal from the binding row", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await createTask(project.id, "Preserved announce fields");
    const principal = await seedPrincipal(admin.user.id, "pi-laptop");
    const key = "test-api-key-preserved";
    await createApiKeyForUser(admin.user.id, key);
    const { app } = createApp();

    mockAuthenticatedSession(admin.user);
    const announced = await announce(app, {
      sessionId: "pi-preserved-fields",
      agentPrincipalId: principal.id,
      host: "pi-laptop",
      title: "announce title",
      cwd: "D:/keep/me",
      model: "glm-5.3-flash",
    });
    expect(announced.status).toBe(200);

    mockAuthenticatedSessions(admin.user, {});
    const bindResponse = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        taskId: task.id,
        agentPrincipalId: principal.id,
        sessionId: "pi-preserved-fields",
      }),
    });
    expect(bindResponse.status).toBe(200);
    const bound = (await bindResponse.json()) as {
      bindingId: string;
      bindingGeneration: number;
    };

    const heartbeat = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          sessionId: "pi-preserved-fields",
          generation: bound.bindingGeneration,
        }),
      },
    );
    expect(heartbeat.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.agentSessionPresenceTable)
      .where(
        eq(schema.agentSessionPresenceTable.sessionId, "pi-preserved-fields"),
      );
    expect(row!.title).toBe("announce title");
    expect(row!.cwd).toBe("D:/keep/me");
    expect(row!.model).toBe("glm-5.3-flash");
    expect(row!.host).toBe("pi-laptop");
  });

  it("the lazy sweep removes rows stale beyond 7 days and keeps fresh ones", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const principal = await seedPrincipal(admin.user.id, "pi-laptop");
    await db.insert(schema.agentSessionPresenceTable).values([
      {
        sessionId: "pi-ancient",
        agentPrincipalId: principal.id,
        host: "pi-laptop",
        lastSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
      },
      {
        sessionId: "pi-fresh",
        agentPrincipalId: principal.id,
        host: "pi-laptop",
      },
    ]);
    await sweepStalePresence();
    const remaining = await db.select().from(schema.agentSessionPresenceTable);
    expect(remaining.map((row) => row.sessionId)).toEqual(["pi-fresh"]);

    // Deterministic gate: ~2% of announces trigger the sweep.
    const { shouldSweepPresence } = await import(
      "../../apps/api/src/agent-session/presence-service"
    );
    expect(shouldSweepPresence(0.019)).toBe(true);
    expect(shouldSweepPresence(0.5)).toBe(false);
  });

  it("an announce whose sweep roll triggers deletes ancient rows inline", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const principal = await seedPrincipal(admin.user.id, "pi-laptop");
    await db.insert(schema.agentSessionPresenceTable).values({
      sessionId: "pi-ancient-announce",
      agentPrincipalId: principal.id,
      host: "pi-laptop",
      lastSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60_000),
    });
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const response = await announce(app, {
      sessionId: "pi-new",
      agentPrincipalId: principal.id,
      host: "pi-laptop",
    });
    expect(response.status).toBe(200);
    const remaining = await db.select().from(schema.agentSessionPresenceTable);
    expect(remaining.map((row) => row.sessionId)).toEqual(["pi-new"]);
  });
});
