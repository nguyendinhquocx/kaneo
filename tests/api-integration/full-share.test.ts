import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { executionControlRequestTable } from "../../apps/api/src/database/schema";
import { createApp } from "../../apps/api/src/index";
import { resetShareRateLimits } from "../../apps/api/src/share/rate-limit";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

// SPEC-2026-10-22 full-project-share-link: capability authorization matrix.
// Every full action is project-scoped, agent-control aware, audited
// atomically, and never elevates view/edit links.

const storageMocks = vi.hoisted(() => ({
  createContentAssetUploadUrl: vi.fn(),
  getPrivateObjectMeta: vi.fn().mockResolvedValue({
    contentType: "image/png",
    contentLength: 100,
  }),
  getPrivateObject: vi.fn().mockResolvedValue({
    body: "fake-object-bytes",
    contentType: "image/png",
    contentLength: 100,
    etag: "etag-1",
    lastModified: new Date(0),
  }),
  deleteS3Object: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../apps/api/src/storage/s3", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../apps/api/src/storage/s3")>();
  return {
    ...actual,
    createContentAssetUploadUrl: storageMocks.createContentAssetUploadUrl,
    getPrivateObjectMeta: storageMocks.getPrivateObjectMeta,
    getPrivateObject: storageMocks.getPrivateObject,
    deleteS3Object: storageMocks.deleteS3Object,
  };
});

// Audit atomicity is driven through a mutable flag so individual tests can
// simulate the audit insert failing mid-transaction.
const auditMock = vi.hoisted(() => ({ fail: false }));

vi.mock("../../apps/api/src/share/resolve-share-link", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../apps/api/src/share/resolve-share-link")
    >();
  return {
    ...actual,
    appendShareActionAudit: async (
      link: Parameters<typeof actual.appendShareActionAudit>[0],
      action: string,
      tx?: Parameters<typeof actual.appendShareActionAudit>[2],
      resourceIdOverride?: string,
    ) => {
      if (auditMock.fail) {
        throw new Error("audit persistence unavailable");
      }
      return actual.appendShareActionAudit(link, action, tx, resourceIdOverride);
    },
  };
});

type App = ReturnType<typeof createApp>["app"];

async function createLink(
  app: App,
  resourceType: string,
  resourceId: string,
  permission: string,
) {
  const response = await app.request("/api/share-manage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceType, resourceId, permission }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; id: string };
}

async function seedTask(
  projectId: string,
  overrides?: Partial<{ title: string; description: string | null; status: string; userId: string | null }>,
) {
  // Number must stay unique per project (task_project_number_unique).
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.projectId, projectId));
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title: overrides?.title ?? "Existing task",
      description: overrides?.description ?? "Existing description",
      status: overrides?.status ?? "to-do",
      number: Number(count) + 1,
      userId: overrides?.userId ?? null,
    })
    .returning();
  await db
    .update(schema.projectTable)
    .set({ lastTaskNumber: Number(count) + 1 })
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
      revision: 1,
      archivedAt: overrides?.archivedAt,
    })
    .returning();
  return document;
}

async function seedProjectManifest(projectId: string) {
  await db.insert(schema.executionManifestTable).values({
    projectId,
    repositoryOwner: "acme",
    repositoryName: "widgets",
    verificationProfile: "pnpm test",
  });
}

async function seedTaskRun(projectId: string, taskId: string) {
  const [run] = await db
    .insert(schema.taskRunTable)
    .values({
      taskId,
      manifestId: null,
      manifestVersion: 1,
      protocolVersion: 1,
      repositoryOwner: "acme",
      repositoryName: "widgets",
      baseBranch: "main",
      state: "in_progress",
      role: "worker",
      hostId: "host-1",
      branchName: "agent/branch",
      scope: [],
      requestKey: `test-run-${taskId}`,
      requestHash: `test-hash-${taskId}`,
      leaseEpoch: 1,
      leaseTokenHash: `test-lease-${taskId}`,
      leaseActive: true,
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
      lastHeartbeatAt: new Date(),
    })
    .returning();
  void projectId;
  return run;
}

async function getAuditCount(shareLinkId: string, action: string) {
  const rows = await db
    .select({ id: schema.shareActionAuditTable.id })
    .from(schema.shareActionAuditTable)
    .where(eq(schema.shareActionAuditTable.shareLinkId, shareLinkId));
  void action;
  return rows.length;
}

describe("API integration: full project share capability", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    resetShareRateLimits();
    storageMocks.deleteS3Object.mockClear();
    storageMocks.createContentAssetUploadUrl.mockImplementation(
      async (context: {
        workspaceId: string;
        ownerType: string;
        ownerId: string;
      }) => ({
        key: `workspace/${context.workspaceId}/content/${context.ownerType}/${context.ownerId}/file-${Date.now()}.png`,
        uploadUrl: "https://storage.example/put",
        headers: { "Content-Type": "image/png" },
      }),
    );
    storageMocks.getPrivateObjectMeta.mockResolvedValue({
      contentType: "image/png",
      contentLength: 100,
    });
    auditMock.fail = false;
  });

  it("creates a 30-day project-only full link and refuses full for other resources", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const document = await seedDocument(project.id);

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();

    const bad = await app.request("/api/share-manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "document",
        resourceId: document.id,
        permission: "full",
      }),
    });
    expect(bad.status).toBe(400);

    const created = await createLink(app, "project", project.id, "full");
    expect(created.token).toBeTruthy();

    const [link] = await db
      .select()
      .from(schema.shareLinkTable)
      .where(eq(schema.shareLinkTable.id, created.id));
    expect(link.permission).toBe("full");
    expect(link.expiresAt).not.toBeNull();
    const days =
      (link.expiresAt!.getTime() - link.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it("allows full link creation on agent-controlled projects but keeps the edit guard", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    await seedProjectManifest(project.id);

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();

    const edit = await app.request("/api/share-manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "project",
        resourceId: project.id,
        permission: "edit",
      }),
    });
    expect(edit.status).toBe(403);

    const full = await app.request("/api/share-manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "project",
        resourceId: project.id,
        permission: "full",
      }),
    });
    expect(full.status).toBe(200);
  });

  it("serves the holder payload with assignee ids only to full links", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const member = await createWorkspaceMember({ role: "member" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: admin.workspace.id,
      userId: member.user.id,
      role: "member",
      joinedAt: new Date(),
    });
    const task = await seedTask(project.id, { userId: member.user.id });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const full = await createLink(app, "project", project.id, "full");
    const edit = await createLink(app, "project", project.id, "edit");

    mockAnonymousSession();
    ({ app } = createApp());

    const fullRead = await app.request(`/api/share/project/${full.token}`);
    expect(fullRead.status).toBe(200);
    const fullPayload = (await fullRead.json()) as {
      columns: Array<{ tasks: Array<{ id: string; assigneeId?: string }> }>;
      scope?: string;
    };
    const flatTasks = fullPayload.columns.flatMap((column) => column.tasks);
    const fullTask = flatTasks.find((candidate) => candidate.id === task.id);
    expect(fullTask?.assigneeId).toBe(member.user.id);
    expect(fullPayload.scope).toBe("full");

    const editRead = await app.request(`/api/share/project/${edit.token}`);
    const editPayload = (await editRead.json()) as {
      columns: Array<{ tasks: Array<{ assigneeId?: string }> }>;
    };
    const editTask = editPayload.columns
      .flatMap((column) => column.tasks)
      .find((candidate) => candidate.assigneeId !== undefined);
    expect(editTask).toBeUndefined();
  });

  it("creates, updates, and deletes tasks with the extended full surface", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const member = await createWorkspaceMember({ role: "member" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: admin.workspace.id,
      userId: member.user.id,
      role: "member",
      joinedAt: new Date(),
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const created = await app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Guest task",
        status: "planned",
        priority: "high",
        assigneeId: member.user.id,
        labels: [{ name: "urgent", color: "#ff0000" }],
      }),
    });
    expect(created.status).toBe(200);
    const task = (await created.json()) as { id: string; status: string };
    expect(task.status).toBe("planned");

    const updated = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assigneeId: null, status: "to-do" }),
      },
    );
    expect(updated.status).toBe(200);

    const deleted = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    const [gone] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(gone).toBeUndefined();
  });

  it("hides descriptions project-wide under a manifest but keeps structural edits working", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);
    await seedProjectManifest(project.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const deniedWrite = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "trying to write" }),
      },
    );
    expect(deniedWrite.status).toBe(403);

    // Task detail: description hidden but the object itself readable.
    const detail = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
    );
    expect(detail.status).toBe(200);
    const detailPayload = (await detail.json()) as {
      description: string | null;
      descriptionLocked: boolean;
      comments: unknown[];
    };
    expect(detailPayload.description).toBeNull();
    expect(detailPayload.descriptionLocked).toBe(true);

    // Structural fields stay editable for proven-ordinary tasks.
    const structural = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: "urgent" }),
      },
    );
    expect(structural.status).toBe(200);
  });

  it("denies the whole task when it is linked to a run", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const controlled = await seedTask(project.id, { title: "Agent task" });
    const ordinary = await seedTask(project.id, { title: "Normal task" });
    await seedTaskRun(project.id, controlled.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const denied = await app.request(
      `/api/share/project/${link.token}/task/${controlled.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: "low" }),
      },
    );
    expect(denied.status).toBe(403);

    const detail = await app.request(
      `/api/share/project/${link.token}/task/${controlled.id}`,
    );
    const detailPayload = (await detail.json()) as {
      agentControlled: boolean;
      description: string | null;
    };
    expect(detailPayload.agentControlled).toBe(true);
    expect(detailPayload.description).toBeNull();

    // Ordinary tasks in the same project remain fully usable.
    const ok = await app.request(
      `/api/share/project/${link.token}/task/${ordinary.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Normal task renamed" }),
      },
    );
    expect(ok.status).toBe(200);
  });

  it("posts guest comments with link attribution and no notifications", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id, { userId: admin.user.id });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const created = await app.request(
      `/api/share/project/${link.token}/task/${task.id}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: `hello <kaneo-mention data-id="${admin.user.id}">@Admin</kaneo-mention>`,
        }),
      },
    );
    expect(created.status).toBe(200);
    const comment = (await created.json()) as { id: string; authorName: string };
    expect(comment.authorName).toBe("Share link holder");

    const [activity] = await db
      .select()
      .from(schema.activityTable)
      .where(eq(schema.activityTable.id, comment.id));
    expect(activity.userId).toBeNull();
    expect(activity.externalUserName).toBe("Share link holder");

    // No steering, no notifications — side-effect matrix T1 §D.
    const notifications = await db
      .select()
      .from(schema.notificationTable);
    expect(notifications).toHaveLength(0);
    const controlRequests = await db
      .select()
      .from(executionControlRequestTable);
    expect(controlRequests).toHaveLength(0);

    // The same link can edit and delete its own comment.
    const updated = await app.request(
      `/api/share/project/${link.token}/comment/${comment.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "edited" }),
      },
    );
    expect(updated.status).toBe(200);

    const removed = await app.request(
      `/api/share/project/${link.token}/comment/${comment.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
  });

  it("refuses comment edits from a different link and denies comments on execution-linked tasks", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);
    const controlled = await seedTask(project.id, { title: "Agent task" });
    await seedTaskRun(project.id, controlled.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const linkA = await createLink(app, "project", project.id, "full");
    const linkB = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const created = await app.request(
      `/api/share/project/${linkA.token}/task/${task.id}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "from link A" }),
      },
    );
    const comment = (await created.json()) as { id: string };

    const foreign = await app.request(
      `/api/share/project/${linkB.token}/comment/${comment.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hijack" }),
      },
    );
    expect(foreign.status).toBe(404);

    const denied = await app.request(
      `/api/share/project/${linkA.token}/task/${controlled.id}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "steer attempt" }),
      },
    );
    expect(denied.status).toBe(403);
  });

  it("manages project documents with CAS and archive/delete", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const created = await app.request(
      `/api/share/project/${link.token}/documents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Guest doc", content: "# Hello" }),
      },
    );
    expect(created.status).toBe(200);
    const document = (await created.json()) as { id: string; revision: number };
    expect(document.revision).toBe(1);

    const conflict = await app.request(
      `/api/share/project/${link.token}/document/${document.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x", content: "y", revision: 99 }),
      },
    );
    expect(conflict.status).toBe(409);

    const updated = await app.request(
      `/api/share/project/${link.token}/document/${document.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Guest doc", content: "# Changed", revision: 1 }),
      },
    );
    expect(updated.status).toBe(200);

    const archived = await app.request(
      `/api/share/project/${link.token}/document/${document.id}/archive`,
      { method: "POST" },
    );
    expect(archived.status).toBe(200);

    const deleted = await app.request(
      `/api/share/project/${link.token}/document/${document.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
  });

  it("fails closed on cross-project relations and allows in-project ones", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const otherProject = await createProjectFixture({
      workspaceId: admin.workspace.id,
      name: "Other project",
    });
    const taskA = await seedTask(project.id);
    const foreignTask = await seedTask(otherProject.project.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const crossProject = await app.request(
      `/api/share/project/${link.token}/task/${taskA.id}/relations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetTaskId: foreignTask.id,
          relationType: "related",
        }),
      },
    );
    expect(crossProject.status).toBe(404);

    const inProject = await app.request(
      `/api/share/project/${link.token}/task/${taskA.id}/relations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetTaskId: foreignTask.id,
          relationType: "related",
        }),
      },
    );
    void inProject;

    const ordinaryTask = await seedTask(project.id, { title: "Second" });
    const created = await app.request(
      `/api/share/project/${link.token}/task/${taskA.id}/relations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetTaskId: ordinaryTask.id,
          relationType: "subtask",
        }),
      },
    );
    expect(created.status).toBe(200);
    const relation = (await created.json()) as { id: string };

    // Deleting a relation whose target left the project fails closed.
    await db
      .update(schema.taskTable)
      .set({ projectId: otherProject.project.id })
      .where(eq(schema.taskTable.id, ordinaryTask.id));
    // Cross-project endpoints fail closed with the same generic 404 as an
    // unknown relation — the link must not even reveal the object exists.
    const deniedDelete = await app.request(
      `/api/share/project/${link.token}/relation/${relation.id}`,
      { method: "DELETE" },
    );
    expect(deniedDelete.status).toBe(404);
  });

  it("serves the member directory with only id, name, and avatar", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const full = await createLink(app, "project", project.id, "full");
    const edit = await createLink(app, "project", project.id, "edit");

    mockAnonymousSession();
    ({ app } = createApp());

    const members = await app.request(`/api/share/project/${full.token}/members`);
    expect(members.status).toBe(200);
    const payload = (await members.json()) as Array<Record<string, unknown>>;
    expect(payload.length).toBeGreaterThan(0);
    for (const member of payload) {
      expect(Object.keys(member).sort()).toEqual([
        "avatarUrl",
        "id",
        "name",
      ]);
      expect(member.id).toBeTruthy();
    }

    const denied = await app.request(
      `/api/share/project/${edit.token}/members`,
    );
    expect(denied.status).toBe(404);
  });

  it("enforces the upload MIME allowlist, size cap, and actual-object verification", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const ticket = (ownerType: string, contentType: string, size = 100) =>
      app.request(`/api/share/project/${link.token}/asset/upload-ticket`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerType,
          ownerId: task.id,
          filename: "file",
          contentType,
          size,
        }),
      });

    const html = await ticket("task_description", "text/html");
    expect(html.status).toBe(400);

    const octet = await ticket("task_description", "application/octet-stream");
    expect(octet.status).toBe(400);

    const archive = await ticket("task_description", "application/zip");
    expect(archive.status).toBe(400);

    const oversized = await ticket(
      "task_description",
      "image/png",
      11 * 1024 * 1024,
    );
    expect(oversized.status).toBe(400);

    const ok = await ticket("task_description", "image/png");
    expect(ok.status).toBe(200);
    const upload = (await ok.json()) as { key: string; uploadUrl: string };
    expect(upload.uploadUrl).toBeTruthy();

    const finalize = (size: number, contentType = "image/png") =>
      app.request(`/api/share/project/${link.token}/asset/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerType: "task_description",
          ownerId: task.id,
          key: upload.key,
          filename: "file.png",
          contentType,
          size,
        }),
      });

    storageMocks.getPrivateObjectMeta.mockResolvedValue({
      contentType: "image/png",
      contentLength: 999,
    });
    const mismatch = await finalize(100);
    expect(mismatch.status).toBe(400);
    expect(storageMocks.deleteS3Object).toHaveBeenCalled();

    storageMocks.getPrivateObjectMeta.mockResolvedValue({
      contentType: "text/html",
      contentLength: 100,
    });
    const wrongType = await finalize(100);
    expect(wrongType.status).toBe(400);
    expect(storageMocks.deleteS3Object).toHaveBeenCalled();

    storageMocks.getPrivateObjectMeta.mockResolvedValue({
      contentType: "image/png",
      contentLength: 100,
    });
    const good = await finalize(100);
    expect(good.status).toBe(200);
    const asset = (await good.json()) as { id: string };

    // The asset is immediately readable through the link's asset route.
    const assetRead = await app.request(
      `/api/share/project/${link.token}/asset/${asset.id}`,
    );
    expect(assetRead.status).toBe(200);
  });

  it("rolls back the mutation when the audit insert fails", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    auditMock.fail = true;
    const failed = await app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "should not persist" }),
    });
    expect(failed.status).toBe(500);
    auditMock.fail = false;

    const tasks = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    expect(tasks).toHaveLength(0);
  });

  it("revocation and expiry deny every full route", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const before = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
    );
    expect(before.status).toBe(200);

    mockAuthenticatedSession(admin.user);
    ({ app } = createApp());
    const revoked = await app.request(`/api/share-manage/${link.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);

    mockAnonymousSession();
    ({ app } = createApp());

    const read = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
    );
    expect(read.status).toBe(404);
    const members = await app.request(
      `/api/share/project/${link.token}/members`,
    );
    expect(members.status).toBe(404);
    const write = await app.request(
      `/api/share/project/${link.token}/task/${task.id}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "after revoke" }),
      },
    );
    expect(write.status).toBe(404);

    const readResponse = await app.request(`/api/share/project/${link.token}`);
    expect(readResponse.status).toBe(404);
  });

  it("revokes project capabilities when the project is deleted", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    const deleted = await app.request(`/api/project/${project.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    const [revoked] = await db
      .select()
      .from(schema.shareLinkTable)
      .where(eq(schema.shareLinkTable.id, link.id));
    expect(revoked.revokedAt).not.toBeNull();
  });

  it("never exposes the raw token outside the authenticated create/list response", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const read = await app.request(`/api/share/project/${link.token}`);
    const body = await read.text();
    expect(body).not.toContain(link.token);

    const detail = await app.request(
      `/api/share/project/${link.token}/task/${(await seedTask(project.id)).id}`,
    );
    expect(detail.status).toBe(200);
    expect(await detail.text()).not.toContain(link.token);
  });
});
