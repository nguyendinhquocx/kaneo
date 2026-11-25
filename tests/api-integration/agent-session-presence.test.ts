import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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

type AdvisoryLockIdentity = {
  classid: string;
  objid: string;
  objsubid: string;
};
type PresenceTestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function acquireSessionLockForTest(
  tx: PresenceTestTransaction,
  sessionId: string,
): Promise<AdvisoryLockIdentity> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`session:${sessionId}`}))`,
  );
  const result = await tx.execute(sql`
    select classid::text, objid::text, objsubid::text
    from pg_locks
    where pid = pg_backend_pid()
      and locktype = 'advisory'
      and granted
    limit 1
  `);
  const rows = (result as { rows?: AdvisoryLockIdentity[] }).rows ?? [];
  if (!rows[0]) throw new Error("test did not acquire the session advisory lock");
  return rows[0];
}

async function waitForAdvisoryWaiters(
  lock: AdvisoryLockIdentity,
  minimum: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await db.execute(sql`
      select count(*)::int as count
      from pg_locks
      where locktype = 'advisory'
        and not granted
        and classid = ${lock.classid}::oid
        and objid = ${lock.objid}::oid
        and objsubid = ${lock.objsubid}::smallint
    `);
    const rows = (result as { rows?: Array<{ count: number | string }> }).rows ?? [];
    if (Number(rows[0]?.count ?? 0) >= minimum) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
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

    const [firstPresence] = await db
      .select()
      .from(schema.agentSessionPresenceTable)
      .where(eq(schema.agentSessionPresenceTable.sessionId, body.sessionId));
    expect(firstPresence).toBeDefined();
    const deliberatelyOldLastSeenAt = new Date(Date.now() - 10_000);
    await db
      .update(schema.agentSessionPresenceTable)
      .set({ lastSeenAt: deliberatelyOldLastSeenAt })
      .where(eq(schema.agentSessionPresenceTable.sessionId, body.sessionId));

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
    expect(binding.sessionId).toBe(body.sessionId);
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
    expect(row!.lastSeenAt.getTime()).toBeGreaterThan(
      deliberatelyOldLastSeenAt.getTime(),
    );
    expect(Date.now() - row!.lastSeenAt.getTime()).toBeLessThan(1000);
    const all = await db.select().from(schema.agentSessionPresenceTable);
    expect(all).toHaveLength(1);
  });

  it("serializes concurrent announcements so one account cannot take over a session id", async () => {
    const firstOwner = await createWorkspaceMember({ role: "admin" });
    const secondOwner = await createWorkspaceMember({ role: "admin" });
    const firstPrincipal = await seedPrincipal(firstOwner.user.id, "pi-laptop");
    const secondPrincipal = await seedPrincipal(secondOwner.user.id, "prodesk-home");
    const sessionId = "pi-session-cross-account-announce";
    mockAuthenticatedSessions(firstOwner.user, {
      "first-account": firstOwner.user,
      "second-account": secondOwner.user,
    });
    const { app } = createApp();

    let releaseLock!: () => void;
    let publishLock!: (identity: AdvisoryLockIdentity) => void;
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockReady = new Promise<AdvisoryLockIdentity>((resolve) => {
      publishLock = resolve;
    });
    const lockHolder = db.transaction(async (tx) => {
      publishLock(await acquireSessionLockForTest(tx, sessionId));
      await gate;
    });
    const lockIdentity = await lockReady;

    const firstRequest = announce(
      app,
      {
        sessionId,
        agentPrincipalId: firstPrincipal.id,
        host: "pi-laptop",
        title: "first account",
      },
      { authorization: "Bearer first-account" },
    );
    const secondRequest = announce(
      app,
      {
        sessionId,
        agentPrincipalId: secondPrincipal.id,
        host: "prodesk-home",
        title: "second account",
      },
      { authorization: "Bearer second-account" },
    );

    const bothQueued = await waitForAdvisoryWaiters(lockIdentity, 2);
    releaseLock();
    await lockHolder;
    const responses = await Promise.all([firstRequest, secondRequest]);

    expect(bothQueued).toBe(true);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const [row] = await db
      .select()
      .from(schema.agentSessionPresenceTable)
      .where(eq(schema.agentSessionPresenceTable.sessionId, sessionId));
    expect(row).toBeDefined();
    const winner =
      row!.title === "first account" ? firstPrincipal : secondPrincipal;
    expect(row!.agentPrincipalId).toBe(winner.id);
  });

  it("rechecks web-bind ownership if another account binds after route preflight", async () => {
    const priorOwner = await createWorkspaceMember({ role: "admin" });
    const webOwner = await createWorkspaceMember({ role: "admin" });
    const { project: priorProject } = await createProjectFixture({
      workspaceId: priorOwner.workspace.id,
    });
    const { project: webProject } = await createProjectFixture({
      workspaceId: webOwner.workspace.id,
    });
    const priorTask = await createTask(priorProject.id, "Prior owner task");
    const webTask = await createTask(webProject.id, "Web target task");
    const priorPrincipal = await seedPrincipal(priorOwner.user.id, "pi-laptop");
    const webPrincipal = await seedPrincipal(webOwner.user.id, "prodesk-home");
    const sessionId = "pi-session-bind-preflight-race";
    const { app } = createApp();
    mockAuthenticatedSession(webOwner.user);

    // This row lets the web request pass its route-level presence preflight.
    await db.insert(schema.agentSessionPresenceTable).values({
      sessionId,
      agentPrincipalId: webPrincipal.id,
      host: "prodesk-home",
      title: "web target",
    });

    let releasePriorTransaction!: () => void;
    let publishLock!: (identity: AdvisoryLockIdentity) => void;
    const releaseGate = new Promise<void>((resolve) => {
      releasePriorTransaction = resolve;
    });
    const lockReady = new Promise<AdvisoryLockIdentity>((resolve) => {
      publishLock = resolve;
    });
    const competingTransaction = db.transaction(async (tx) => {
      publishLock(await acquireSessionLockForTest(tx, sessionId));
      await releaseGate;
      await tx.insert(schema.agentSessionBindingTable).values({
        taskId: priorTask.id,
        projectId: priorProject.id,
        agentPrincipalId: priorPrincipal.id,
        hostId: "pi-laptop",
        sessionId,
      });
    });
    const lockIdentity = await lockReady;

    const webBindRequest = app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: webTask.id,
        agentPrincipalId: webPrincipal.id,
        sessionId,
      }),
    });

    // Wait until the real route has passed both preflight checks and is blocked
    // on the service's session lock. Then commit the competing binding before
    // the route enters its transaction critical section.
    let observedWait = false;
    try {
      observedWait = await waitForAdvisoryWaiters(lockIdentity, 1);
    } finally {
      releasePriorTransaction();
    }
    await competingTransaction;
    const response = await webBindRequest;

    expect(observedWait).toBe(true);
    expect(response.status).toBe(409);
    const [activeBinding] = await db
      .select()
      .from(schema.agentSessionBindingTable)
      .where(
        and(
          eq(schema.agentSessionBindingTable.sessionId, sessionId),
          eq(schema.agentSessionBindingTable.status, "active"),
        ),
      );
    expect(activeBinding?.taskId).toBe(priorTask.id);
    expect(activeBinding?.agentPrincipalId).toBe(priorPrincipal.id);
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

  it("announce cannot take over another user's session id, and its roster never shows the foreign binding", async () => {
    const owner = await createWorkspaceMember({ role: "admin" });
    const stranger = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: owner.workspace.id,
    });
    const ownerTask = await createTask(project.id, "Owner card", 42);
    const ownerPrincipal = await seedPrincipal(owner.user.id, "pi-laptop");
    const strangerPrincipal = await seedPrincipal(stranger.user.id, "pi-laptop");
    const sharedSessionId = "pi-shared-session-id";
    const ownerKey = "test-api-key-owner-bind";
    await createApiKeyForUser(owner.user.id, ownerKey);

    // The owner binds the shared session id through the API-key path WITHOUT
    // ever announcing it (no presence row for the owner).
    mockAuthenticatedSessions(owner.user, {});
    const { app } = createApp();
    const bindResponse = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ownerKey },
      body: JSON.stringify({
        taskId: ownerTask.id,
        agentPrincipalId: ownerPrincipal.id,
        sessionId: sharedSessionId,
      }),
    });
    expect(bindResponse.status).toBe(200);

    // The stranger cannot announce a session that already has a binding
    // owned by another account, even though no presence row exists yet.
    mockAuthenticatedSession(stranger.user);
    const strangerAnnounce = await announce(app, {
      sessionId: sharedSessionId,
      agentPrincipalId: strangerPrincipal.id,
      host: "pi-laptop",
      title: "stranger session",
    });
    expect(strangerAnnounce.status).toBe(409);

    // The stranger's roster must not acquire a poisoned row for that session.
    const strangerRoster = await app.request("/api/agent-session/sessions/roster");
    const { sessions } = (await strangerRoster.json()) as {
      sessions: Array<{ sessionId: string; binding: unknown }>;
    };
    expect(sessions.some((item) => item.sessionId === sharedSessionId)).toBe(false);

    // The owner has no presence row yet (never announced) — their roster
    // shows nothing for this session id.
    mockAuthenticatedSession(owner.user);
    const ownerRosterBefore = await app.request("/api/agent-session/sessions/roster");
    const ownerSessionsBefore = (await ownerRosterBefore.json()) as {
      sessions: Array<{ sessionId: string }>;
    };
    expect(
      ownerSessionsBefore.sessions.some((item) => item.sessionId === sharedSessionId),
    ).toBe(false);

    // Once the owner's extension heartbeats its binding, the piggyback
    // upserts the presence row under the OWNER's principal (reclaiming the
    // session-id slot) and the owner then sees their own binding.
    mockAuthenticatedSessions(owner.user, {});
    const bound = (await bindResponse.json()) as {
      bindingId: string;
      bindingGeneration: number;
    };
    const heartbeat = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": ownerKey },
        body: JSON.stringify({
          sessionId: sharedSessionId,
          generation: bound.bindingGeneration,
        }),
      },
    );
    expect(heartbeat.status).toBe(200);

    mockAuthenticatedSession(owner.user);
    const ownerRoster = await app.request("/api/agent-session/sessions/roster");
    const ownerSessions = (await ownerRoster.json()) as {
      sessions: Array<{ sessionId: string; binding: { taskId: string } | null }>;
    };
    const ownerRow = ownerSessions.sessions.find(
      (item) => item.sessionId === sharedSessionId,
    );
    expect(ownerRow).toBeDefined();
    expect(ownerRow!.binding).not.toBeNull();
    expect(ownerRow!.binding!.taskId).toBe(ownerTask.id);
  });

  it("announce rejects overwriting a presence row owned by another account with 409", async () => {
    const owner = await createWorkspaceMember({ role: "admin" });
    const stranger = await createWorkspaceMember({ role: "admin" });
    const ownerPrincipal = await seedPrincipal(owner.user.id, "pi-laptop");
    const strangerPrincipal = await seedPrincipal(stranger.user.id, "pi-laptop");

    mockAuthenticatedSession(owner.user);
    const { app } = createApp();
    const first = await announce(app, {
      sessionId: "pi-owned-session",
      agentPrincipalId: ownerPrincipal.id,
      host: "pi-laptop",
      title: "owner session",
    });
    expect(first.status).toBe(200);

    mockAuthenticatedSession(stranger.user);
    const takeover = await announce(app, {
      sessionId: "pi-owned-session",
      agentPrincipalId: strangerPrincipal.id,
      host: "pi-laptop",
      title: "stranger session",
    });
    expect(takeover.status).toBe(409);

    // The row still belongs to the original owner.
    const [row] = await db
      .select()
      .from(schema.agentSessionPresenceTable)
      .where(eq(schema.agentSessionPresenceTable.sessionId, "pi-owned-session"));
    expect(row!.agentPrincipalId).toBe(ownerPrincipal.id);
    expect(row!.title).toBe("owner session");
  });

  it("a web caller cannot force-rebind a session actively bound by another account", async () => {
    const owner = await createWorkspaceMember({ role: "admin" });
    const stranger = await createWorkspaceMember({ role: "admin" });
    const { project: ownerProject } = await createProjectFixture({
      workspaceId: owner.workspace.id,
    });
    const { project: strangerProject } = await createProjectFixture({
      workspaceId: stranger.workspace.id,
    });
    const ownerTask = await createTask(ownerProject.id, "Owner bound card");
    const strangerTask = await createTask(strangerProject.id, "Stranger card");
    const ownerPrincipal = await seedPrincipal(owner.user.id, "pi-laptop");
    const strangerPrincipal = await seedPrincipal(stranger.user.id, "pi-laptop");
    const ownerKey = "test-api-key-forcebind-owner";
    await createApiKeyForUser(owner.user.id, ownerKey);

    mockAuthenticatedSessions(owner.user, {});
    const { app } = createApp();
    const bindResponse = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ownerKey },
      body: JSON.stringify({
        taskId: ownerTask.id,
        agentPrincipalId: ownerPrincipal.id,
        sessionId: "pi-forcebind-target",
      }),
    });
    expect(bindResponse.status).toBe(200);

    // Announce itself must not create a cross-account roster row, and the
    // web bind remains blocked if the owner never announced this session.
    mockAuthenticatedSession(stranger.user);
    const strangerAnnounce = await announce(app, {
      sessionId: "pi-forcebind-target",
      agentPrincipalId: strangerPrincipal.id,
      host: "pi-laptop",
    });
    expect(strangerAnnounce.status).toBe(409);

    const forceBind = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: strangerTask.id,
        agentPrincipalId: strangerPrincipal.id,
        sessionId: "pi-forcebind-target",
      }),
    });
    expect(forceBind.status).toBe(403);

    // The owner's binding survives untouched.
    const [binding] = await db
      .select()
      .from(schema.agentSessionBindingTable)
      .where(
        and(
          eq(schema.agentSessionBindingTable.sessionId, "pi-forcebind-target"),
          eq(schema.agentSessionBindingTable.status, "active"),
        ),
      );
    expect(binding!.agentPrincipalId).toBe(ownerPrincipal.id);
    expect(binding!.taskId).toBe(ownerTask.id);
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
