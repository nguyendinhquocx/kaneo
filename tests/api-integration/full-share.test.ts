import { and, asc, eq, sql } from "drizzle-orm";
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
  assertContentAssetKeyMatchesContext: vi.fn().mockReturnValue(true),
  createContentAssetUploadUrl: vi.fn(),
  getPrivateObjectMeta: vi.fn().mockResolvedValue({
    contentType: "image/png",
    contentLength: 100,
  }),
  getPrivateObjectPrefix: vi
    .fn()
    .mockResolvedValue(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
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
    assertContentAssetKeyMatchesContext:
      storageMocks.assertContentAssetKeyMatchesContext,
    createContentAssetUploadUrl: storageMocks.createContentAssetUploadUrl,
    getPrivateObjectMeta: storageMocks.getPrivateObjectMeta,
    getPrivateObjectPrefix: storageMocks.getPrivateObjectPrefix,
    getPrivateObject: storageMocks.getPrivateObject,
    deleteS3Object: storageMocks.deleteS3Object,
  };
});

// Audit atomicity is driven through a mutable flag so individual tests can
// simulate the audit insert failing mid-transaction.
const auditMock = vi.hoisted(() => ({ fail: false }));
const resourceCountRace = vi.hoisted(() => ({
  enabled: false,
  calls: 0,
  precheckCounts: [] as number[],
  transactionCounts: [] as number[],
  waitForPair: null as null | (() => Promise<void>),
}));
const relationRace = vi.hoisted(() => ({
  enabled: false,
  calls: 0,
  blockAfter: 0,
  onBlocked: null as null | (() => void),
  waitForRelease: null as null | (() => Promise<void>),
}));
const documentRace = vi.hoisted(() => ({
  enabled: false,
  onBlocked: null as null | (() => void),
  waitForRelease: null as null | (() => Promise<void>),
}));
const projectLaneLockRace = vi.hoisted(() => ({
  enabled: false,
  calls: 0,
  onFirstLocked: null as null | (() => void),
  onSecondAttempt: null as null | (() => void),
  waitForFirstRelease: null as null | (() => Promise<void>),
}));
const agentGuardRace = vi.hoisted(() => ({
  enabled: false,
  kind: null as null | "task" | "project",
  calls: 0,
  blockAfter: 0,
  // holdAll: every matching guard call waits for release instead of only the
  // Nth one. Used for multi-request races where each precheck must observe
  // the pre-seed state while every transaction sees the post-seed state.
  holdAll: false,
  onBlocked: null as null | (() => void),
  waitForRelease: null as null | (() => Promise<void>),
}));

vi.mock("../../apps/api/src/share/full-access", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../apps/api/src/share/full-access")
    >();
  return {
    ...actual,
    countResourceAssets: async (
      where: Parameters<typeof actual.countResourceAssets>[0],
      executor: Parameters<typeof actual.countResourceAssets>[1],
    ) => {
      const count = await actual.countResourceAssets(where, executor);
      if (resourceCountRace.enabled && executor === undefined) {
        resourceCountRace.precheckCounts.push(count);
        await resourceCountRace.waitForPair?.();
      } else if (resourceCountRace.enabled) {
        resourceCountRace.transactionCounts.push(count);
      }
      return count;
    },
    loadProjectTask: async (...args: Parameters<typeof actual.loadProjectTask>) => {
      const task = await actual.loadProjectTask(...args);
      if (relationRace.enabled) {
        relationRace.calls += 1;
        if (relationRace.calls === relationRace.blockAfter) {
          relationRace.onBlocked?.();
          await relationRace.waitForRelease?.();
        }
      }
      return task;
    },
    loadProjectDocument: async (
      ...args: Parameters<typeof actual.loadProjectDocument>
    ) => {
      const document = await actual.loadProjectDocument(...args);
      if (documentRace.enabled) {
        // Only the FIRST call pauses — the guest update's precheck. The
        // owner's archive goes through the same loader and must not block
        // on its own barrier.
        documentRace.enabled = false;
        documentRace.onBlocked?.();
        await documentRace.waitForRelease?.();
      }
      return document;
    },
    isTaskAgentControlled: async (...args: Parameters<typeof actual.isTaskAgentControlled>) => {
      const controlled = await actual.isTaskAgentControlled(...args);
      if (
        !controlled &&
        agentGuardRace.enabled &&
        agentGuardRace.kind === "task"
      ) {
        agentGuardRace.calls += 1;
        if (agentGuardRace.calls === agentGuardRace.blockAfter) {
          agentGuardRace.onBlocked?.();
          await agentGuardRace.waitForRelease?.();
        }
      }
      return controlled;
    },
    isProjectAgentControlledStrict: async (
      ...args: Parameters<typeof actual.isProjectAgentControlledStrict>
    ) => {
      const controlled = await actual.isProjectAgentControlledStrict(...args);
      if (
        !controlled &&
        agentGuardRace.enabled &&
        agentGuardRace.kind === "project"
      ) {
        agentGuardRace.calls += 1;
        if (
          agentGuardRace.holdAll ||
          agentGuardRace.calls === agentGuardRace.blockAfter
        ) {
          agentGuardRace.onBlocked?.();
          await agentGuardRace.waitForRelease?.();
        }
      }
      return controlled;
    },
  };
});

vi.mock(
  "../../apps/api/src/task/lock-project-task-lanes",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../apps/api/src/task/lock-project-task-lanes")
      >();
    return {
      ...actual,
      lockProjectTaskLanes: async (
        ...args: Parameters<typeof actual.lockProjectTaskLanes>
      ) => {
        if (!projectLaneLockRace.enabled) {
          return actual.lockProjectTaskLanes(...args);
        }
        projectLaneLockRace.calls += 1;
        if (projectLaneLockRace.calls === 1) {
          await actual.lockProjectTaskLanes(...args);
          projectLaneLockRace.onFirstLocked?.();
          await projectLaneLockRace.waitForFirstRelease?.();
          return;
        }
        if (projectLaneLockRace.calls === 2) {
          projectLaneLockRace.onSecondAttempt?.();
        }
        return actual.lockProjectTaskLanes(...args);
      },
    };
  },
);

vi.mock(
  "../../apps/api/src/share/resolve-share-link",
  async (importOriginal) => {
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
        return actual.appendShareActionAudit(
          link,
          action,
          tx,
          resourceIdOverride,
        );
      },
    };
  },
);

type App = ReturnType<typeof createApp>["app"];

function createAgentGuardBarrier(
  kind: "task" | "project",
  blockAfter = 1,
  options: { holdAll?: boolean } = {},
) {
  let markBlocked = () => {};
  let releaseBlocked = () => {};
  const blocked = new Promise<void>((resolve) => {
    markBlocked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseBlocked = resolve;
  });
  agentGuardRace.enabled = true;
  agentGuardRace.kind = kind;
  agentGuardRace.calls = 0;
  agentGuardRace.blockAfter = blockAfter;
  agentGuardRace.holdAll = options.holdAll ?? false;
  agentGuardRace.onBlocked = markBlocked;
  agentGuardRace.waitForRelease = () => released;
  return {
    blocked,
    release: releaseBlocked,
    reset: () => {
      agentGuardRace.enabled = false;
      agentGuardRace.kind = null;
      agentGuardRace.calls = 0;
      agentGuardRace.blockAfter = 0;
      agentGuardRace.holdAll = false;
      agentGuardRace.onBlocked = null;
      agentGuardRace.waitForRelease = null;
    },
  };
}

function createTaskMoveBarrier(blockAfter: number) {
  let markBlocked = () => {};
  let releaseBlocked = () => {};
  const blocked = new Promise<void>((resolve) => {
    markBlocked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseBlocked = resolve;
  });
  relationRace.enabled = true;
  relationRace.calls = 0;
  relationRace.blockAfter = blockAfter;
  relationRace.onBlocked = markBlocked;
  relationRace.waitForRelease = () => released;
  return {
    blocked,
    release: releaseBlocked,
    reset: () => {
      relationRace.enabled = false;
      relationRace.calls = 0;
      relationRace.blockAfter = 0;
      relationRace.onBlocked = null;
      relationRace.waitForRelease = null;
    },
  };
}

function createDocumentArchiveBarrier() {
  let markBlocked = () => {};
  let releaseBlocked = () => {};
  const blocked = new Promise<void>((resolve) => {
    markBlocked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseBlocked = resolve;
  });
  documentRace.enabled = true;
  documentRace.onBlocked = markBlocked;
  documentRace.waitForRelease = () => released;
  return {
    blocked,
    release: releaseBlocked,
    reset: () => {
      documentRace.enabled = false;
      documentRace.onBlocked = null;
      documentRace.waitForRelease = null;
    },
  };
}

function createProjectLaneLockBarrier() {
  let markFirstLocked = () => {};
  let markSecondAttempt = () => {};
  let releaseFirst = () => {};
  const firstLocked = new Promise<void>((resolve) => {
    markFirstLocked = resolve;
  });
  const secondAttempted = new Promise<void>((resolve) => {
    markSecondAttempt = resolve;
  });
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  projectLaneLockRace.enabled = true;
  projectLaneLockRace.calls = 0;
  projectLaneLockRace.onFirstLocked = markFirstLocked;
  projectLaneLockRace.onSecondAttempt = markSecondAttempt;
  projectLaneLockRace.waitForFirstRelease = () => firstReleased;
  return {
    firstLocked,
    secondAttempted,
    release: releaseFirst,
    reset: () => {
      projectLaneLockRace.enabled = false;
      projectLaneLockRace.calls = 0;
      projectLaneLockRace.onFirstLocked = null;
      projectLaneLockRace.onSecondAttempt = null;
      projectLaneLockRace.waitForFirstRelease = null;
    },
  };
}

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
  overrides?: Partial<{
    title: string;
    description: string | null;
    status: string;
    userId: string | null;
  }>,
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
    const expiresAt = link.expiresAt;
    expect(expiresAt).not.toBeNull();
    if (!expiresAt) {
      throw new Error("Full links must have an expiration time.");
    }
    const days = (expiresAt.getTime() - link.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it("requires workspace owner/admin for full links even when a custom role has project:share", async () => {
    const member = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: member.workspace.id,
      role: "custom-share",
      permission: JSON.stringify({ project: ["share"] }),
    });
    await db
      .update(schema.workspaceUserTable)
      .set({ role: "custom-share" })
      .where(eq(schema.workspaceUserTable.userId, member.user.id));

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const full = await app.request("/api/share-manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "project",
        resourceId: project.id,
        permission: "full",
      }),
    });
    expect(full.status).toBe(403);

    // Existing link administration keeps its existing custom-role semantics.
    const edit = await app.request("/api/share-manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "project",
        resourceId: project.id,
        permission: "edit",
      }),
    });
    expect(edit.status).toBe(200);
  });

  it("restricts full-link listing/revocation and one-time URL to owner/admin", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const custom = await createWorkspaceMember({ role: "member" });
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: admin.workspace.id,
      role: "custom-share",
      permission: JSON.stringify({ project: ["share"] }),
    });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: admin.workspace.id,
      userId: custom.user.id,
      role: "custom-share",
      joinedAt: new Date(),
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const full = await createLink(app, "project", project.id, "full");
    const edit = await createLink(app, "project", project.id, "edit");

    const adminList = await app.request(
      `/api/share-manage?resourceType=project&resourceId=${project.id}`,
    );
    expect(adminList.status).toBe(200);
    const adminRows = (await adminList.json()) as Array<{
      id: string;
      permission: string;
      url: string | null;
    }>;
    expect(adminRows.find((row) => row.id === full.id)?.url).toBeNull();

    mockAuthenticatedSession(custom.user);
    ({ app } = createApp());

    const customList = await app.request(
      `/api/share-manage?resourceType=project&resourceId=${project.id}`,
    );
    expect(customList.status).toBe(200);
    const customRows = (await customList.json()) as Array<{
      id: string;
      permission: string;
      url: string | null;
    }>;
    expect(customRows.some((row) => row.id === full.id)).toBe(false);
    expect(customRows.find((row) => row.id === edit.id)?.url).toContain(
      edit.token,
    );

    const fullRevoke = await app.request(`/api/share-manage/${full.id}`, {
      method: "DELETE",
    });
    expect(fullRevoke.status).toBe(403);
    const [persistedFull] = await db
      .select({ revokedAt: schema.shareLinkTable.revokedAt })
      .from(schema.shareLinkTable)
      .where(eq(schema.shareLinkTable.id, full.id));
    expect(persistedFull?.revokedAt).toBeNull();
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

  it("exposes column ids as slugs so the kanban drag contract holds", async () => {
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
    expect(read.status).toBe(200);
    const payload = (await read.json()) as {
      columns: Array<{ id: string; slug: string }>;
    };
    expect(payload.columns.length).toBeGreaterThan(0);
    // The kanban drag layer writes column.id back into task.status and the
    // server validates task.status against column slugs. A nanoid column id
    // here turns every drag into a 400 storm (owner UAT regression).
    for (const column of payload.columns) {
      expect(column.id).toBe(column.slug);
    }

    const firstColumn = payload.columns[0];
    const created = await app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "drag contract", status: firstColumn.id }),
    });
    expect(created.status).toBe(200);
    const createdTask = (await created.json()) as {
      id: string;
      status: string;
    };
    // The drag layer never PUTs lane order: it calls the move endpoint.
    const targetStatus = payload.columns[1]?.id ?? firstColumn.id;
    const moved = await app.request(
      `/api/share/project/${link.token}/task/${createdTask.id}/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: targetStatus, position: 0 }),
      },
    );
    expect(moved.status).toBe(200);

    // SPEC-2026-10-27-kaneo-subtask-board-focus-markers: even when the owner
    // task carries non-zero marker counts, the guest board payload must not
    // expose the marker keys or the authenticated subtask projection.
    await db
      .update(schema.taskTable)
      .set({
        workMarkerCounts: { redCross: 3, boxedRedCross: 1, redCircle: 5, greenCheck: 0 },
      })
      .where(eq(schema.taskTable.id, createdTask.id));
    const boardAfterMarker = await app.request(
      `/api/share/project/${link.token}`,
    );
    expect(boardAfterMarker.status).toBe(200);
    const markerPayload = (await boardAfterMarker.json()) as {
      showSubtaskCardsByDefault?: unknown;
      columns: Array<{ tasks: Array<Record<string, unknown>> }>;
    };
    expect(markerPayload).not.toHaveProperty("showSubtaskCardsByDefault");
    for (const column of markerPayload.columns) {
      for (const guestTask of column.tasks) {
        expect(guestTask).not.toHaveProperty("workMarkerCounts");
        expect(guestTask).not.toHaveProperty("isSubtask");
        expect(guestTask).not.toHaveProperty("nextSubtaskPreview");
      }
    }
  });

  it("moves guest kanban cards in one write and reindexes integer lane positions", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const first = await seedTask(project.id, { title: "first" });
    const moving = await seedTask(project.id, { title: "moving" });
    const last = await seedTask(project.id, { title: "last" });
    const destination = await seedTask(project.id, {
      title: "destination",
      status: "in-progress",
    });
    const destinationNullPosition = await seedTask(project.id, {
      title: "null-position destination",
      status: "in-progress",
    });
    const controlled = await seedTask(project.id, {
      title: "hidden controlled task",
    });
    await seedTaskRun(project.id, controlled.id);

    await Promise.all(
      [first, moving, last, destination, destinationNullPosition, controlled].map((task, index) =>
        db
          .update(schema.taskTable)
          .set({ position: index })
          .where(eq(schema.taskTable.id, task.id)),
      ),
    );
    await db
      .update(schema.taskTable)
      .set({ position: null })
      .where(eq(schema.taskTable.id, destinationNullPosition.id));

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");
    const [targetColumn] = await db
      .select({ id: schema.columnTable.id })
      .from(schema.columnTable)
      .where(
        and(
          eq(schema.columnTable.projectId, project.id),
          eq(schema.columnTable.slug, "in-progress"),
        ),
      );
    mockAnonymousSession();
    ({ app } = createApp());

    const move = (taskId: string, status: string, position: number) =>
      app.request(`/api/share/project/${link.token}/task/${taskId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, position }),
      });

    const malformedJson = await app.request(
      `/api/share/project/${link.token}/task/${moving.id}/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    );
    expect(malformedJson.status).toBe(400);

    const fractionalPosition = await move(moving.id, "in-progress", 0.5);
    expect(fractionalPosition.status).toBe(400);

    const movedAcross = await move(moving.id, "in-progress", 2);
    expect(movedAcross.status).toBe(200);
    const sourceRows = await db
      .select({ id: schema.taskTable.id, position: schema.taskTable.position })
      .from(schema.taskTable)
      .where(
        and(
          eq(schema.taskTable.projectId, project.id),
          eq(schema.taskTable.status, "to-do"),
        ),
      )
      .orderBy(asc(schema.taskTable.position));
    expect(sourceRows.map((row) => row.id)).toEqual([
      first.id,
      last.id,
      controlled.id,
    ]);
    expect(sourceRows.map((row) => row.position)).toEqual([0, 1, 5]);

    const destinationRows = await db
      .select({
        id: schema.taskTable.id,
        position: schema.taskTable.position,
        columnId: schema.taskTable.columnId,
      })
      .from(schema.taskTable)
      .where(
        and(
          eq(schema.taskTable.projectId, project.id),
          eq(schema.taskTable.status, "in-progress"),
        ),
      )
      .orderBy(asc(schema.taskTable.position));
    expect(destinationRows.map((row) => row.id)).toEqual([
      destination.id,
      destinationNullPosition.id,
      moving.id,
    ]);
    expect(destinationRows.map((row) => row.position)).toEqual([0, 1, 2]);
    expect(destinationRows.map((row) => row.columnId)).toEqual([
      targetColumn?.id,
      targetColumn?.id,
      targetColumn?.id,
    ]);

    const movedWithinLane = await move(moving.id, "in-progress", 1);
    expect(movedWithinLane.status).toBe(200);
    const finalRows = await db
      .select({ id: schema.taskTable.id, position: schema.taskTable.position })
      .from(schema.taskTable)
      .where(
        and(
          eq(schema.taskTable.projectId, project.id),
          eq(schema.taskTable.status, "in-progress"),
        ),
      )
      .orderBy(asc(schema.taskTable.position));
    expect(finalRows.map((row) => row.id)).toEqual([
      destination.id,
      moving.id,
      destinationNullPosition.id,
    ]);
    expect(finalRows.map((row) => row.position)).toEqual([0, 1, 2]);

    // Dropping onto an empty lane passes that lane's ID and the current
    // empty-list length (zero); the API must keep the task at index zero.
    const movedToEmptyLane = await move(moving.id, "done", 0);
    expect(movedToEmptyLane.status).toBe(200);
    const [emptyLaneTask] = await db
      .select({
        status: schema.taskTable.status,
        position: schema.taskTable.position,
        columnId: schema.taskTable.columnId,
      })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, moving.id));
    expect(emptyLaneTask?.status).toBe("done");
    expect(emptyLaneTask?.position).toBe(0);
    expect(emptyLaneTask?.columnId).toBeTruthy();

    const [controlledRow] = await db
      .select({ position: schema.taskTable.position })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, controlled.id));
    expect(controlledRow?.position).toBe(5);

    const auditRows = await db
      .select({ action: schema.shareActionAuditTable.action })
      .from(schema.shareActionAuditTable)
      .where(eq(schema.shareActionAuditTable.shareLinkId, link.id));
    expect(auditRows.map((row) => row.action)).toEqual([
      "task.move",
      "task.move",
      "task.move",
    ]);
  });

  it("serializes a guest reindex against an owner lane-status update", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const guestTask = await seedTask(project.id, { title: "guest move" });
    const ownerTask = await seedTask(project.id, { title: "owner status change" });
    const destination = await seedTask(project.id, {
      title: "existing destination",
      status: "in-progress",
    });
    await Promise.all(
      [guestTask, ownerTask, destination].map((task, position) =>
        db
          .update(schema.taskTable)
          .set({ position })
          .where(eq(schema.taskTable.id, task.id)),
      ),
    );

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");
    mockAnonymousSession();
    ({ app } = createApp());
    const guestApp = app;

    const barrier = createProjectLaneLockBarrier();
    try {
      const guestMove = guestApp.request(
        `/api/share/project/${link.token}/task/${guestTask.id}/move`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "in-progress", position: 0 }),
        },
      );
      await barrier.firstLocked;

      mockAuthenticatedSession(admin.user);
      ({ app } = createApp());
      const ownerMove = app.request(`/api/task/status/${ownerTask.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "in-progress" }),
      });
      await barrier.secondAttempted;
      barrier.release();

      const [guestResponse, ownerResponse] = await Promise.all([
        guestMove,
        ownerMove,
      ]);
      expect(guestResponse.status).toBe(200);
      expect(ownerResponse.status).toBe(200);
    } finally {
      barrier.release();
      barrier.reset();
    }

    const rows = await db
      .select({ id: schema.taskTable.id, position: schema.taskTable.position })
      .from(schema.taskTable)
      .where(
        and(
          eq(schema.taskTable.projectId, project.id),
          eq(schema.taskTable.status, "in-progress"),
        ),
      )
      .orderBy(asc(schema.taskTable.position));
    expect(rows.map((row) => row.id)).toEqual([
      guestTask.id,
      destination.id,
      ownerTask.id,
    ]);
    expect(rows.map((row) => row.position)).toEqual([0, 1, 2]);
  });

  it("locks every project lane touched by cross-project subtask reordering", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project: parentProject } = await createProjectFixture({
      workspaceId: admin.workspace.id,
      name: "Subtask parent project",
    });
    const { project: childProject } = await createProjectFixture({
      workspaceId: admin.workspace.id,
      name: "Subtask child project",
    });
    const parent = await seedTask(parentProject.id, { title: "Parent" });
    const child = await seedTask(childProject.id, { title: "Child" });
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: parent.id,
      targetTaskId: child.id,
      relationType: "subtask",
      position: 0,
    });

    mockAuthenticatedSession(admin.user);
    const { app: ownerApp } = createApp();
    const link = await createLink(ownerApp, "project", childProject.id, "full");

    const barrier = createProjectLaneLockBarrier();
    try {
      const reorder = ownerApp.request(
        `/api/task-relation/subtasks/${parent.id}/order`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderedTargetTaskIds: [child.id] }),
        },
      );
      await barrier.firstLocked;

      mockAnonymousSession();
      const { app: guestApp } = createApp();
      const move = guestApp.request(
        `/api/share/project/${link.token}/task/${child.id}/move`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "in-progress", position: 0 }),
        },
      );
      await barrier.secondAttempted;
      barrier.release();

      const [reorderResponse, moveResponse] = await Promise.all([reorder, move]);
      expect(reorderResponse.status).toBe(200);
      expect(moveResponse.status).toBe(200);
    } finally {
      barrier.release();
      barrier.reset();
    }

    const [movedChild] = await db
      .select({ status: schema.taskTable.status, position: schema.taskTable.position })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, child.id));
    expect(movedChild?.status).toBe("in-progress");
    expect(movedChild?.position).toBe(0);
    const [relation] = await db
      .select({ position: schema.taskRelationTable.position })
      .from(schema.taskRelationTable)
      .where(
        and(
          eq(schema.taskRelationTable.sourceTaskId, parent.id),
          eq(schema.taskRelationTable.targetTaskId, child.id),
        ),
      );
    expect(relation?.position).toBe(0);
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
    const createdPayload = (await created.json()) as Record<string, unknown>;
    expect(createdPayload).not.toHaveProperty("executionState");
    expect(createdPayload).not.toHaveProperty("taskRevision");
    // SPEC-2026-10-27-kaneo-subtask-board-focus-markers: work marker counts
    // are authenticated-only data and must never leak into guest payloads.
    expect(createdPayload).not.toHaveProperty("workMarkerCounts");
    const task = createdPayload as { id: string; status: string };
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
    const updatedPayload = (await updated.json()) as Record<string, unknown>;
    expect(updatedPayload).not.toHaveProperty("executionState");
    expect(updatedPayload).not.toHaveProperty("taskRevision");

    const guestMarkerWrite = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workMarkerCounts: {
            redCross: 1,
            boxedRedCross: 0,
            redCircle: 0,
            greenCheck: 0,
          },
        }),
      },
    );
    expect(guestMarkerWrite.status).toBe(400);

    // Lane order is owned by the POST move endpoint; PUT must not accept it.
    const positionWrite = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: 7 }),
      },
    );
    expect(positionWrite.status).toBe(400);

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

  it("rechecks task execution markers in the mutation transaction for task, comment, label, and upload writes", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const updateTask = await seedTask(project.id, { title: "Update task" });
    const commentTask = await seedTask(project.id, { title: "Comment task" });
    const labelTask = await seedTask(project.id, { title: "Label task" });
    const uploadTask = await seedTask(project.id, { title: "Upload task" });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");
    mockAnonymousSession();
    ({ app } = createApp());

    const addRunAfterPrecheck = async (
      taskId: string,
      request: () => Promise<Response>,
    ) => {
      const barrier = createAgentGuardBarrier("task");
      const pending = request();
      try {
        await barrier.blocked;
        await seedTaskRun(project.id, taskId);
        const [run] = await db
          .select({ id: schema.taskRunTable.id })
          .from(schema.taskRunTable)
          .where(eq(schema.taskRunTable.taskId, taskId));
        expect(run).toBeTruthy();
        barrier.release();
        return await pending;
      } finally {
        barrier.release();
        barrier.reset();
      }
    };

    const update = await addRunAfterPrecheck(updateTask.id, () =>
      app.request(
        `/api/share/project/${link.token}/task/${updateTask.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ priority: "high" }),
        },
      ),
    );
    expect(update.status).toBe(403);
    const [unchangedTask] = await db
      .select({ priority: schema.taskTable.priority })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, updateTask.id));
    expect(unchangedTask?.priority).toBe(updateTask.priority);

    const comment = await addRunAfterPrecheck(commentTask.id, () =>
      app.request(
        `/api/share/project/${link.token}/task/${commentTask.id}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "must not persist" }),
        },
      ),
    );
    expect(comment.status).toBe(403);
    const [commentCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.activityTable)
      .where(eq(schema.activityTable.taskId, commentTask.id));
    expect(Number(commentCount?.count)).toBe(0);

    const label = await addRunAfterPrecheck(labelTask.id, () =>
      app.request(
        `/api/share/project/${link.token}/task/${labelTask.id}/labels`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "must-not-persist", color: "#000000" }),
        },
      ),
    );
    expect(label.status).toBe(403);
    const [labelCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.labelTable)
      .where(eq(schema.labelTable.taskId, labelTask.id));
    expect(Number(labelCount?.count)).toBe(0);

    storageMocks.getPrivateObjectMeta.mockResolvedValue({
      contentType: "image/png",
      contentLength: 100,
    });
    storageMocks.getPrivateObjectPrefix.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    storageMocks.deleteS3Object.mockClear();
    const finalize = await addRunAfterPrecheck(uploadTask.id, () =>
      app.request(`/api/share/project/${link.token}/asset/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerType: "task_description",
          ownerId: uploadTask.id,
          key: `workspace/${admin.workspace.id}/content/task_description/${uploadTask.id}/staged.png`,
          filename: "staged.png",
          contentType: "image/png",
          size: 100,
        }),
      }),
    );
    expect(finalize.status).toBe(403);
    expect(storageMocks.deleteS3Object).toHaveBeenCalledOnce();
    const [assetCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.taskId, uploadTask.id));
    expect(Number(assetCount?.count)).toBe(0);
  }, 15_000);

  it("rechecks the project manifest inside task-description and upload transactions", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id, { title: "Description task" });
    const [{ count: taskCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");
    mockAnonymousSession();
    ({ app } = createApp());

    storageMocks.getPrivateObjectMeta.mockResolvedValue({
      contentType: "image/png",
      contentLength: 100,
    });
    storageMocks.getPrivateObjectPrefix.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    storageMocks.deleteS3Object.mockClear();
    // holdAll keeps all three prechecks paused until the manifest is seeded:
    // every request authorizes against the pre-seed state, then must fail in
    // its transaction against the post-seed state (the TOCTOU window).
    const barrier = createAgentGuardBarrier("project", 3, { holdAll: true });
    const update = app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "must remain unchanged" }),
      },
    );
    const create = app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Must not be created",
        description: "must not persist",
      }),
    });
    const stagedKey = `workspace/${admin.workspace.id}/content/task_description/${task.id}/manifest-race.png`;
    const upload = app.request(
      `/api/share/project/${link.token}/asset/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerType: "task_description",
          ownerId: task.id,
          key: stagedKey,
          filename: "manifest-race.png",
          contentType: "image/png",
          size: 100,
        }),
      },
    );
    try {
      await barrier.blocked;
      await seedProjectManifest(project.id);
      barrier.release();
      const [updateResponse, createResponse, uploadResponse] =
        await Promise.all([update, create, upload]);
      expect(updateResponse.status).toBe(403);
      const createBody = await createResponse.text();
      expect(createResponse.status, createBody).toBe(403);
      expect(uploadResponse.status).toBe(403);
      expect(storageMocks.deleteS3Object).toHaveBeenCalledWith(stagedKey);
    } finally {
      barrier.release();
      barrier.reset();
    }

    const [updatedTask] = await db
      .select({ description: schema.taskTable.description })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(updatedTask?.description).toBe("Existing description");
    const [remainingTaskCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    expect(Number(remainingTaskCount?.count)).toBe(Number(taskCount));
  }, 15_000);

  it("hides descriptions project-wide under a manifest but keeps structural edits working", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);
    await db.insert(schema.activityTable).values([
      {
        taskId: task.id,
        type: "comment",
        userId: null,
        content: "worker control narrative",
      },
      {
        taskId: task.id,
        type: "comment",
        userId: admin.user.id,
        content: "Member comment",
      },
    ]);
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
      comments: Array<{ content: string; authorName: string }>;
    };
    expect(detailPayload.description).toBeNull();
    expect(detailPayload).not.toHaveProperty("agentControlled");
    expect(detailPayload).not.toHaveProperty("descriptionLocked");
    expect(detailPayload).not.toHaveProperty("workMarkerCounts");
    expect(detailPayload.comments.map((comment) => comment.content)).toEqual([
      "Member comment",
    ]);
    expect(JSON.stringify(detailPayload)).not.toContain(
      "worker control narrative",
    );

    const postedComment = await app.request(
      `/api/share/project/${link.token}/task/${task.id}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Share comment" }),
      },
    );
    expect(postedComment.status).toBe(200);
    const refetchedDetail = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
    );
    const refetchedPayload = (await refetchedDetail.json()) as {
      comments: Array<{ content: string; authorName: string }>;
    };
    expect(refetchedPayload.comments.map((comment) => comment.content)).toEqual(
      ["Member comment", "Share comment"],
    );

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

    // Structural creation remains available, but no description mutation is
    // accepted anywhere in the manifest-controlled project.
    const created = await app.request(`/api/share/project/${link.token}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Ordinary structural task" }),
    });
    expect(created.status).toBe(200);
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
    expect(detail.status).toBe(404);

    const projectRead = await app.request(`/api/share/project/${link.token}`);
    const payload = (await projectRead.json()) as {
      columns: Array<{ tasks: Array<{ id: string }> }>;
    };
    expect(
      payload.columns.flatMap((column) => column.tasks).map((task) => task.id),
    ).not.toContain(controlled.id);

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
    const comment = (await created.json()) as {
      id: string;
      authorName: string;
    };
    expect(comment.authorName).toBe("Share link holder");

    const [activity] = await db
      .select()
      .from(schema.activityTable)
      .where(eq(schema.activityTable.id, comment.id));
    expect(activity.userId).toBeNull();
    expect(activity.externalUserName).toBe("Share link holder");

    // No steering, no notifications — side-effect matrix T1 §D.
    const notifications = await db.select().from(schema.notificationTable);
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

  it("rechecks project scope before guest comment and label edit/delete transactions", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const otherProject = await createProjectFixture({
      workspaceId: admin.workspace.id,
      name: "Other project",
    });
    const updateTask = await seedTask(project.id, { title: "Comment update" });
    const deleteTask = await seedTask(project.id, { title: "Comment delete" });
    const labelTask = await seedTask(project.id, { title: "Label delete" });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");
    mockAnonymousSession();
    ({ app } = createApp());

    const createComment = async (taskId: string, content: string) => {
      const response = await app.request(
        `/api/share/project/${link.token}/task/${taskId}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { id: string };
    };
    const commentToUpdate = await createComment(updateTask.id, "keep me");
    const commentToDelete = await createComment(deleteTask.id, "also keep me");
    const [label] = await db
      .insert(schema.labelTable)
      .values({
        taskId: labelTask.id,
        workspaceId: admin.workspace.id,
        name: "keep-label",
        color: "#000000",
      })
      .returning();

    const moveDuringGuard = async (
      taskId: string,
      request: () => Promise<Response>,
    ) => {
      const barrier = createAgentGuardBarrier("task");
      const pending = request();
      try {
        await barrier.blocked;
        await db
          .update(schema.taskTable)
          .set({ projectId: otherProject.project.id })
          .where(eq(schema.taskTable.id, taskId));
        barrier.release();
        return await pending;
      } finally {
        barrier.release();
        barrier.reset();
      }
    };

    const updated = await moveDuringGuard(updateTask.id, () =>
      app.request(
        `/api/share/project/${link.token}/comment/${commentToUpdate.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "must not change" }),
        },
      ),
    );
    expect(updated.status).toBe(404);
    const [unchangedComment] = await db
      .select({ content: schema.activityTable.content })
      .from(schema.activityTable)
      .where(eq(schema.activityTable.id, commentToUpdate.id));
    expect(unchangedComment?.content).toBe("keep me");

    const deleted = await moveDuringGuard(deleteTask.id, () =>
      app.request(
        `/api/share/project/${link.token}/comment/${commentToDelete.id}`,
        { method: "DELETE" },
      ),
    );
    expect(deleted.status).toBe(404);
    const [remainingComment] = await db
      .select({ id: schema.activityTable.id })
      .from(schema.activityTable)
      .where(eq(schema.activityTable.id, commentToDelete.id));
    expect(remainingComment?.id).toBe(commentToDelete.id);

    const removedLabel = await moveDuringGuard(labelTask.id, () =>
      app.request(`/api/share/project/${link.token}/label/${label.id}`, {
        method: "DELETE",
      }),
    );
    expect(removedLabel.status).toBe(404);
    const [remainingLabel] = await db
      .select({ id: schema.labelTable.id })
      .from(schema.labelTable)
      .where(eq(schema.labelTable.id, label.id));
    expect(remainingLabel?.id).toBe(label.id);
  }, 15_000);

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
        body: JSON.stringify({
          title: "Guest doc",
          content: "# Changed",
          revision: 1,
        }),
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

  it("never writes into a document archived before the update transaction", async () => {
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
        body: JSON.stringify({ title: "Doc", content: "# Before archive" }),
      },
    );
    expect(created.status).toBe(200);
    const document = (await created.json()) as { id: string; revision: number };

    const archived = await app.request(
      `/api/share/project/${link.token}/document/${document.id}/archive`,
      { method: "POST" },
    );
    expect(archived.status).toBe(200);

    // Same revision the guest saw before the archive: the update must lose
    // to the archive instead of writing content into an archived document.
    const update = await app.request(
      `/api/share/project/${link.token}/document/${document.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Doc",
          content: "# After archive",
          revision: document.revision,
        }),
      },
    );
    expect(update.status).toBe(404);

    const [row] = await db
      .select({ content: schema.documentTable.content })
      .from(schema.documentTable)
      .where(eq(schema.documentTable.id, document.id));
    expect(row?.content).toBe("# Before archive");
  });

  it("never writes into a document archived between precheck and commit", async () => {
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
        body: JSON.stringify({ title: "Doc", content: "# Before archive" }),
      },
    );
    expect(created.status).toBe(200);
    const document = (await created.json()) as { id: string; revision: number };

    const barrier = createDocumentArchiveBarrier();
    try {
      const update = app.request(
        `/api/share/project/${link.token}/document/${document.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Doc",
            content: "# After archive",
            revision: document.revision,
          }),
        },
      );
      await barrier.blocked;
      const archive = await app.request(
        `/api/share/project/${link.token}/document/${document.id}/archive`,
        { method: "POST" },
      );
      expect(archive.status).toBe(200);
      barrier.release();
      const response = await update;
      // The in-transaction archive check must win over the stale precheck.
      expect(response.status).toBe(409);
    } finally {
      barrier.release();
      barrier.reset();
    }

    const [row] = await db
      .select({ content: schema.documentTable.content })
      .from(schema.documentTable)
      .where(eq(schema.documentTable.id, document.id));
    expect(row?.content).toBe("# Before archive");
  });

  it("rechecks the root project inside the transaction before deleting", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const otherProject = await createProjectFixture({
      workspaceId: admin.workspace.id,
      name: "Other project",
    });
    const task = await seedTask(project.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");
    mockAnonymousSession();
    ({ app } = createApp());

    const barrier = createTaskMoveBarrier(1);
    const deletion = app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      { method: "DELETE" },
    );
    try {
      await barrier.blocked;
      await db
        .update(schema.taskTable)
        .set({ projectId: otherProject.project.id })
        .where(eq(schema.taskTable.id, task.id));
      barrier.release();
      const response = await deletion;
      expect(response.status).toBe(404);
    } finally {
      barrier.release();
      barrier.reset();
    }

    const [movedTask] = await db
      .select({ projectId: schema.taskTable.projectId })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(movedTask?.projectId).toBe(otherProject.project.id);
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
    // Owner relation APIs permit same-workspace cross-project relations; the
    // share reader must omit the foreign endpoint rather than leak its data.
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: taskA.id,
      targetTaskId: foreignTask.id,
      relationType: "related",
      position: 0,
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const detail = await app.request(
      `/api/share/project/${link.token}/task/${taskA.id}`,
    );
    expect(detail.status).toBe(200);
    const detailPayload = (await detail.json()) as {
      relations: Array<{
        sourceTask: { projectId: string };
        targetTask: { projectId: string };
      }>;
    };
    expect(detailPayload.relations).toHaveLength(0);

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

  it("refuses task deletion when its cascade would remove a cross-project relation", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const otherProject = await createProjectFixture({
      workspaceId: admin.workspace.id,
      name: "Other project",
    });
    const task = await seedTask(project.id);
    const foreignTask = await seedTask(otherProject.project.id);
    const [relation] = await db
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId: task.id,
        targetTaskId: foreignTask.id,
        relationType: "related",
        position: 0,
      })
      .returning();

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const response = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(409);

    const [remainingTask] = await db
      .select({ id: schema.taskTable.id })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    const [remainingRelation] = await db
      .select({ id: schema.taskRelationTable.id })
      .from(schema.taskRelationTable)
      .where(eq(schema.taskRelationTable.id, relation.id));
    expect(remainingTask?.id).toBe(task.id);
    expect(remainingRelation?.id).toBe(relation.id);
  });

  it("rechecks both relation endpoints after a concurrent project move", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const otherProject = await createProjectFixture({
      workspaceId: admin.workspace.id,
      name: "Other project",
    });
    const createSource = await seedTask(project.id, { title: "Create source" });
    const createTarget = await seedTask(project.id, { title: "Create target" });
    const deleteSource = await seedTask(project.id, { title: "Delete source" });
    const deleteTarget = await seedTask(project.id, { title: "Delete target" });
    const parent = await seedTask(project.id, { title: "Parent" });
    const child = await seedTask(project.id, { title: "Child" });
    const [relationToDelete] = await db
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId: deleteSource.id,
        targetTaskId: deleteTarget.id,
        relationType: "related",
        position: 0,
      })
      .returning();
    const [subtaskRelation] = await db
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId: parent.id,
        targetTaskId: child.id,
        relationType: "subtask",
        position: 0,
      })
      .returning();

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");
    mockAnonymousSession();
    ({ app } = createApp());

    const moveDuringPrecheck = async (
      blockAfter: number,
      taskId: string,
      request: () => Promise<Response>,
    ) => {
      const barrier = createTaskMoveBarrier(blockAfter);
      const pendingRequest = request();
      try {
        await barrier.blocked;
        await db
          .update(schema.taskTable)
          .set({ projectId: otherProject.project.id })
          .where(eq(schema.taskTable.id, taskId));
        barrier.release();
        return await pendingRequest;
      } finally {
        barrier.release();
        barrier.reset();
      }
    };

    const createResponse = await moveDuringPrecheck(2, createTarget.id, () =>
      app.request(
        `/api/share/project/${link.token}/task/${createSource.id}/relations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetTaskId: createTarget.id,
            relationType: "related",
          }),
        },
      ),
    );
    expect(createResponse.status).toBe(404);

    const deleteResponse = await moveDuringPrecheck(2, deleteTarget.id, () =>
      app.request(`/api/share/project/${link.token}/relation/${relationToDelete.id}`, {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(404);
    const [remainingRelation] = await db
      .select({ id: schema.taskRelationTable.id })
      .from(schema.taskRelationTable)
      .where(eq(schema.taskRelationTable.id, relationToDelete.id));
    expect(remainingRelation?.id).toBe(relationToDelete.id);

    const reorderResponse = await moveDuringPrecheck(2, child.id, () =>
      app.request(
        `/api/share/project/${link.token}/task/${parent.id}/subtasks/reorder`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderedTargetTaskIds: [child.id] }),
        },
      ),
    );
    expect(reorderResponse.status).toBe(404);
    const [unchangedSubtask] = await db
      .select({ position: schema.taskRelationTable.position })
      .from(schema.taskRelationTable)
      .where(eq(schema.taskRelationTable.id, subtaskRelation.id));
    expect(unchangedSubtask?.position).toBe(0);
  }, 15_000);

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

    const members = await app.request(
      `/api/share/project/${full.token}/members`,
    );
    expect(members.status).toBe(200);
    const payload = (await members.json()) as Array<Record<string, unknown>>;
    expect(payload.length).toBeGreaterThan(0);
    for (const member of payload) {
      expect(Object.keys(member).sort()).toEqual(["avatarUrl", "id", "name"]);
      expect(member.id).toBeTruthy();
    }

    const denied = await app.request(
      `/api/share/project/${edit.token}/members`,
    );
    expect(denied.status).toBe(404);
  });

  it("hides custom-role users from the assignee directory and assignment API", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);
    const custom = await createWorkspaceMember({
      userName: "Custom Share Role",
    });
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: admin.workspace.id,
      role: "custom-share",
      permission: JSON.stringify({ project: ["share"] }),
    });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: admin.workspace.id,
      userId: custom.user.id,
      role: "custom-share",
      joinedAt: new Date(),
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const membersResponse = await app.request(
      `/api/share/project/${link.token}/members`,
    );
    expect(membersResponse.status).toBe(200);
    const members = (await membersResponse.json()) as Array<{ id: string }>;
    expect(members.some((member) => member.id === custom.user.id)).toBe(false);

    const assignment = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assigneeId: custom.user.id }),
      },
    );
    expect(assignment.status).toBe(400);
  });

  it("serializes the per-resource upload cap across different full links", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);
    await db.insert(schema.assetTable).values(
      Array.from({ length: 19 }, (_, index) => ({
        workspaceId: admin.workspace.id,
        projectId: project.id,
        taskId: task.id,
        objectKey: `workspace/${admin.workspace.id}/content/task_description/${task.id}/existing-${index}.png`,
        filename: `existing-${index}.png`,
        mimeType: "image/png",
        size: 10,
        surface: "description",
      })),
    );

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const firstLink = await createLink(app, "project", project.id, "full");
    const secondLink = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());
    storageMocks.getPrivateObjectMeta.mockResolvedValue({
      contentType: "image/png",
      contentLength: 100,
    });
    storageMocks.getPrivateObjectPrefix.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );

    const finalize = (token: string, key: string) =>
      app.request(`/api/share/project/${token}/asset/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerType: "task_description",
          ownerId: task.id,
          key,
          filename: `${key}.png`,
          contentType: "image/png",
          size: 100,
        }),
      });
    let releasePrecheckPair = () => {};
    const precheckPair = new Promise<void>((resolve) => {
      releasePrecheckPair = resolve;
    });
    resourceCountRace.enabled = true;
    resourceCountRace.calls = 0;
    resourceCountRace.precheckCounts = [];
    resourceCountRace.transactionCounts = [];
    resourceCountRace.waitForPair = async () => {
      resourceCountRace.calls += 1;
      if (resourceCountRace.calls === 2) {
        releasePrecheckPair();
      }
      await precheckPair;
    };
    let responses: Response[];
    try {
      responses = await Promise.all([
        finalize(
          firstLink.token,
          `workspace/${admin.workspace.id}/content/task_description/${task.id}/first.png`,
        ),
        finalize(
          secondLink.token,
          `workspace/${admin.workspace.id}/content/task_description/${task.id}/second.png`,
        ),
      ]);
    } finally {
      resourceCountRace.enabled = false;
      resourceCountRace.waitForPair = null;
    }
    expect(resourceCountRace.precheckCounts).toEqual([19, 19]);
    expect(resourceCountRace.transactionCounts.sort((a, b) => a - b)).toEqual([
      19, 20,
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);

    const [count] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.taskId, task.id));
    expect(Number(count?.count)).toBe(20);
  }, 15_000);

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

    const finalize = (
      size: number,
      contentType = "image/png",
      key = upload.key,
    ) =>
      app.request(`/api/share/project/${link.token}/asset/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerType: "task_description",
          ownerId: task.id,
          key,
          filename: "file.png",
          contentType,
          size,
        }),
      });

    storageMocks.deleteS3Object.mockClear();
    const invalidMime = await finalize(100, "application/octet-stream");
    expect(invalidMime.status).toBe(400);
    expect(storageMocks.deleteS3Object).toHaveBeenCalledWith(upload.key);

    storageMocks.deleteS3Object.mockClear();
    const invalidSize = await finalize(11 * 1024 * 1024);
    expect(invalidSize.status).toBe(400);
    expect(storageMocks.deleteS3Object).toHaveBeenCalledWith(upload.key);

    storageMocks.deleteS3Object.mockClear();
    storageMocks.assertContentAssetKeyMatchesContext.mockReturnValueOnce(false);
    const wrongScope = await finalize(100, "image/png", "other-resource/file.png");
    expect(wrongScope.status).toBe(400);
    expect(storageMocks.deleteS3Object).not.toHaveBeenCalled();

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
    storageMocks.getPrivateObjectPrefix.mockResolvedValue(
      new Uint8Array([
        60, 33, 100, 111, 99, 116, 121, 112, 101, 32, 104, 116, 109, 108,
      ]),
    );
    const spoofedImage = await finalize(100);
    expect(spoofedImage.status).toBe(400);
    expect(storageMocks.deleteS3Object).toHaveBeenCalled();

    storageMocks.getPrivateObjectPrefix.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const good = await finalize(100);
    expect(good.status).toBe(200);
    const asset = (await good.json()) as { id: string; url: string };
    expect(asset.url).not.toContain(link.token);

    // The short-lived URL is scoped to this asset, not the parent bearer.
    const ticketPath = new URL(asset.url).pathname;
    expect(ticketPath).toContain("/api/share/asset-ticket/");
    expect(ticketPath).not.toContain(link.token);
    const assetRead = await app.request(ticketPath);
    expect(assetRead.status).toBe(200);

    const update = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: `![upload](${asset.url})`,
        }),
      },
    );
    expect(update.status).toBe(200);
    const [storedTask] = await db
      .select({ description: schema.taskTable.description })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(storedTask.description).not.toContain(link.token);
    expect(storedTask.description).toContain(`/asset/${asset.id}`);

    const detail = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
    );
    const detailBody = await detail.text();
    expect(detailBody).not.toContain(link.token);
    expect(detailBody).toContain("/api/share/asset-ticket/");

    storageMocks.deleteS3Object.mockClear();
    const duplicateFinalize = await finalize(100);
    expect(duplicateFinalize.status).toBe(409);
    expect(storageMocks.deleteS3Object).not.toHaveBeenCalled();
  });

  it("keeps the committed object when concurrent finalizes collide on one key", async () => {
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

    const ticket = await app.request(
      `/api/share/project/${link.token}/asset/upload-ticket`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerType: "task_description",
          ownerId: task.id,
          filename: "race.png",
          contentType: "image/png",
          size: 100,
        }),
      },
    );
    const { key } = (await ticket.json()) as { key: string };

    storageMocks.getPrivateObjectMeta.mockResolvedValue({
      contentType: "image/png",
      contentLength: 100,
    });
    storageMocks.getPrivateObjectPrefix.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    storageMocks.deleteS3Object.mockClear();

    const finalizeRequest = () =>
      app.request(`/api/share/project/${link.token}/asset/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerType: "task_description",
          ownerId: task.id,
          key,
          filename: "race.png",
          contentType: "image/png",
          size: 100,
        }),
      });

    // holdAll parks BOTH prechecks while both still see an empty asset
    // table; the loser must then fail inside its transaction WITHOUT
    // deleting the storage object the winner just committed.
    const barrier = createAgentGuardBarrier("project", 2, { holdAll: true });
    let first: Response;
    let second: Response;
    try {
      const a = finalizeRequest();
      const b = finalizeRequest();
      await barrier.blocked;
      barrier.release();
      [first, second] = await Promise.all([a, b]);
    } finally {
      barrier.release();
      barrier.reset();
    }

    expect([first.status, second.status].sort((x, y) => x - y)).toEqual([
      200, 409,
    ]);
    expect(storageMocks.deleteS3Object).not.toHaveBeenCalledWith(key);
    const [assetCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, key));
    expect(Number(assetCount?.count)).toBe(1);
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

  it("never exposes the full bearer token outside the authorized create response", async () => {
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

describe("API integration: T4 security matrix", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    resetShareRateLimits();
    storageMocks.deleteS3Object.mockClear();
    auditMock.fail = false;
  });

  it("a full-link holder cannot mint, list, or revoke any share link", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const mint = await app.request("/api/share-manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "project",
        resourceId: project.id,
        permission: "full",
      }),
    });
    expect(mint.status).toBe(401);

    const list = await app.request(
      `/api/share-manage?resourceType=project&resourceId=${project.id}`,
    );
    expect(list.status).toBe(401);

    const revoke = await app.request(`/api/share-manage/${link.id}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(401);
  });

  it("an expired full link is denied on every route", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");
    await db
      .update(schema.shareLinkTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.shareLinkTable.id, link.id));

    mockAnonymousSession();
    ({ app } = createApp());

    const read = await app.request(`/api/share/project/${link.token}`);
    expect(read.status).toBe(404);
    const members = await app.request(
      `/api/share/project/${link.token}/members`,
    );
    expect(members.status).toBe(404);
    const detail = await app.request(
      `/api/share/project/${link.token}/task/${task.id}`,
    );
    expect(detail.status).toBe(404);
  });

  it("cross-project asset ids and task ids never resolve through the link", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const otherProject = await createProjectFixture({
      workspaceId: admin.workspace.id,
      name: "Other",
    });
    const foreignTask = await seedTask(otherProject.project.id);
    const [foreignAsset] = await db
      .insert(schema.assetTable)
      .values({
        workspaceId: admin.workspace.id,
        projectId: otherProject.project.id,
        taskId: foreignTask.id,
        objectKey: `workspace/${admin.workspace.id}/content/task_description/${foreignTask.id}/foreign.png`,
        filename: "foreign.png",
        mimeType: "image/png",
        size: 10,
        surface: "description",
      })
      .returning();

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const link = await createLink(app, "project", project.id, "full");

    mockAnonymousSession();
    ({ app } = createApp());

    const assetRead = await app.request(
      `/api/share/project/${link.token}/asset/${foreignAsset.id}`,
    );
    expect(assetRead.status).toBe(404);

    const taskRead = await app.request(
      `/api/share/project/${link.token}/task/${foreignTask.id}`,
    );
    expect(taskRead.status).toBe(404);

    const taskWrite = await app.request(
      `/api/share/project/${link.token}/task/${foreignTask.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "hijack" }),
      },
    );
    expect(taskWrite.status).toBe(404);
  });
});
