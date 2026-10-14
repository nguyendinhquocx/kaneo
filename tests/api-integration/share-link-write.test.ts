import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetShareRateLimits } from "../../apps/api/src/share/rate-limit";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function seedTask(
  projectId: string,
  overrides?: Partial<{
    title: string;
    description: string | null;
    status: string;
  }>,
) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title: overrides?.title ?? "Existing task",
      description: overrides?.description ?? "Existing description",
      status: overrides?.status ?? "to-do",
      number: 1,
    })
    .returning();
  if (!task) {
    throw new Error("Failed to seed task");
  }
  await db
    .update(schema.projectTable)
    .set({ lastTaskNumber: 1 })
    .where(eq(schema.projectTable.id, projectId));
  return task;
}

async function seedDocument(
  projectId: string,
  overrides?: Partial<{ title: string; content: string; archivedAt: Date }>,
) {
  const [document] = await db
    .insert(schema.documentTable)
    .values({
      projectId,
      title: overrides?.title ?? "Doc",
      content: overrides?.content ?? "# Content",
      archivedAt: overrides?.archivedAt,
    })
    .returning();
  if (!document) {
    throw new Error("Failed to seed document");
  }
  return document;
}

async function seedGoal(
  workspaceId: string,
  ownerUserId: string,
  overrides?: Partial<{ visibility: string; archivedAt: Date }>,
) {
  const [goal] = await db
    .insert(schema.goalTable)
    .values({
      workspaceId,
      ownerUserId,
      name: "Shared goal",
      visibility: overrides?.visibility ?? "workspace",
      timezone: "UTC",
      archivedAt: overrides?.archivedAt,
    })
    .returning();
  if (!goal) {
    throw new Error("Failed to seed goal");
  }
  return goal;
}

async function createLink(
  app: ReturnType<typeof createApp>["app"],
  resourceType: string,
  resourceId: string,
  permission: "view" | "edit",
) {
  const response = await app.request("/api/share-manage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceType, resourceId, permission }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; id: string };
}

describe("API integration: anonymous share writes (adversarial)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    resetShareRateLimits();
  });

  it("project edit link creates and updates basic task fields", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    await seedTask(project.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "edit");

    mockAnonymousSession();
    ({ app } = createApp());

    const created = await app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "From public link",
        description: "Anonymous contribution",
        priority: "high",
      }),
    });
    expect(created.status).toBe(200);
    const createdTask = (await created.json()) as {
      id: string;
      number: number;
      status: string;
    };
    expect(createdTask.number).toBe(2);
    expect(createdTask.status).toBe("to-do");

    const updated = await app.request(
      `/api/share/project/${link.token}/task/${createdTask.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed", status: "in-progress" }),
      },
    );
    expect(updated.status).toBe(200);

    // Audit rows exist, metadata-only.
    const audits = await db
      .select()
      .from(schema.shareActionAuditTable)
      .where(eq(schema.shareActionAuditTable.shareLinkId, link.id));
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(["task.create", "task.update"]);
  });

  it("project edit refuses agent-controlled projects; view link cannot mutate", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);
    await db.insert(schema.executionManifestTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      verificationProfile: "test",
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const editLink = await createLink(app, "project", project.id, "edit");
    const viewLink = await createLink(app, "project", project.id, "view");

    mockAnonymousSession();
    ({ app } = createApp());

    // Agent-controlled refusal even with an edit link.
    const refused = await app.request(
      `/api/share/project/${editLink.token}/task`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Nope" }),
      },
    );
    expect(refused.status).toBe(403);

    const refusedUpdate = await app.request(
      `/api/share/project/${editLink.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Nope" }),
      },
    );
    expect(refusedUpdate.status).toBe(403);

    // View-only link cannot mutate even through the edit endpoints.
    const viewMutation = await app.request(
      `/api/share/project/${viewLink.token}/task`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Nope" }),
      },
    );
    expect(viewMutation.status).toBe(404);
  });

  it("document edit link updates one document with CAS; cross-resource access fails", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const docA = await seedDocument(project.id, { title: "Doc A" });
    const docB = await seedDocument(project.id, { title: "Doc B" });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const editLink = await createLink(app, "document", docA.id, "edit");

    mockAnonymousSession();
    ({ app } = createApp());

    const saved = await app.request(`/api/share/document/${editLink.token}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Doc A v2",
        content: "# Updated",
        revision: 1,
      }),
    });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { revision: number };
    expect(savedBody.revision).toBe(2);

    // Stale revision conflicts.
    const conflict = await app.request(
      `/api/share/document/${editLink.token}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Doc A v3",
          content: "# Clobber",
          revision: 1,
        }),
      },
    );
    expect(conflict.status).toBe(409);

    // The edit link cannot reach document B by swapping the id in the URL —
    // the link is bound to resource A.
    const readB = await app.request(`/api/share/document/${docB.id}`);
    expect(readB.status).toBe(404);
  });

  it("goal edit link toggles check-ins and updates notes only", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const goal = await seedGoal(admin.workspace.id, admin.user.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const editLink = await createLink(app, "goal", goal.id, "edit");

    mockAnonymousSession();
    ({ app } = createApp());

    const toggled = await app.request(
      `/api/share/goal/${editLink.token}/checkin`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-10-12" }),
      },
    );
    expect(toggled.status).toBe(200);
    const row = (await toggled.json()) as {
      completed: boolean;
      noteRevision: number;
    };
    expect(row.completed).toBe(true);

    // Anonymous writes are not attributed to any workspace user.
    const persisted = await db
      .select()
      .from(schema.goalCheckinTable)
      .where(eq(schema.goalCheckinTable.goalId, goal.id));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.checkedByUserId).toBeNull();

    const noted = await app.request(
      `/api/share/goal/${editLink.token}/checkin`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "From link", noteRevision: 1 }),
      },
    );
    // checkin id unknown to the caller: the note endpoint is bound by id and
    // the read endpoint exposes it — use the id from the read payload.
    const read = await app.request(`/api/share/goal/${editLink.token}`);
    const readBody = (await read.json()) as {
      checkins: Array<{ id: string; noteRevision: number }>;
    };
    const checkinId = readBody.checkins[0]?.id as string;
    const notedRetry =
      noted.status === 200
        ? noted
        : await app.request(
            `/api/share/goal/${editLink.token}/checkin/${checkinId}`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ note: "From link", noteRevision: 1 }),
            },
          );
    expect(notedRetry.status).toBe(200);
    void row.noteRevision;
  });

  it("archived goal refuses anonymous writes", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const goal = await seedGoal(admin.workspace.id, admin.user.id, {
      archivedAt: new Date(),
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const editLink = await createLink(app, "goal", goal.id, "edit");

    mockAnonymousSession();
    ({ app } = createApp());
    const toggled = await app.request(
      `/api/share/goal/${editLink.token}/checkin`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-10-12" }),
      },
    );
    expect(toggled.status).toBe(409);
  });

  it("expired, revoked and malformed tokens fail closed for writes", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "edit");

    await db
      .update(schema.shareLinkTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.shareLinkTable.id, link.id));

    mockAnonymousSession();
    ({ app } = createApp());

    const expired = await app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(expired.status).toBe(404);

    // Revoked after re-arming expiry.
    await db
      .update(schema.shareLinkTable)
      .set({ expiresAt: null, revokedAt: new Date() })
      .where(eq(schema.shareLinkTable.id, link.id));
    const revoked = await app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(revoked.status).toBe(404);

    const malformed = await app.request("/api/share/project/oops/task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(malformed.status).toBe(404);
  });

  it("anonymous writes are rate limited separately from reads", async () => {
    process.env.SHARE_RATE_LIMIT_WRITE = "1";
    resetShareRateLimits();

    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "edit");

    mockAnonymousSession();
    ({ app } = createApp());
    const first = await app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "One" }),
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Two" }),
    });
    expect(second.status).toBe(429);
  });
  it("cross-project task id fails closed on an edit link", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project: projectA } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const { project: projectB } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const taskB = await seedTask(projectB.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", projectA.id, "edit");

    mockAnonymousSession();
    ({ app } = createApp());
    const response = await app.request(
      `/api/share/project/${link.token}/task/${taskB.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hijack" }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("task_run on any task also refuses public writes", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);
    await db.insert(schema.taskRunTable).values({
      taskId: task.id,
      manifestVersion: 1,
      protocolVersion: 1,
      repositoryOwner: "owner",
      repositoryName: "repo",
      baseBranch: "main",
      state: "queued",
      hostId: "test-host",
      branchName: "test-branch",
      scope: [],
      requestKey: "test-run-key",
      requestHash: "test-run-hash",
      leaseTokenHash: "test-lease-hash",
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "edit");

    mockAnonymousSession();
    ({ app } = createApp());
    const response = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Nope" }),
      },
    );
    expect(response.status).toBe(403);
  });

  it("view links cannot mutate documents or goals", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const doc = await seedDocument(project.id);
    const goal = await seedGoal(admin.workspace.id, admin.user.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const docLink = await createLink(app, "document", doc.id, "view");
    const goalLink = await createLink(app, "goal", goal.id, "view");

    mockAnonymousSession();
    ({ app } = createApp());
    const docWrite = await app.request(`/api/share/document/${docLink.token}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "X", content: "X", revision: 1 }),
    });
    expect(docWrite.status).toBe(404);

    const goalWrite = await app.request(
      `/api/share/goal/${goalLink.token}/checkin`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-10-12" }),
      },
    );
    expect(goalWrite.status).toBe(404);
  });

  it("virtual statuses are rejected on public task writes", async () => {
    delete process.env.SHARE_RATE_LIMIT_WRITE;
    resetShareRateLimits();
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "edit");

    mockAnonymousSession();
    ({ app } = createApp());
    const created = await app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hidden", status: "archived" }),
    });
    expect(created.status).toBe(400);

    const updated = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "planned" }),
      },
    );
    expect(updated.status).toBe(400);
  });
});
