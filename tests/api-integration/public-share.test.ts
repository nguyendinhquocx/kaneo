import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetShareRateLimits } from "../../apps/api/src/share/rate-limit";
import { hashShareToken } from "../../apps/api/src/share/token";
import * as s3 from "../../apps/api/src/storage/s3";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function createWorkspaceRoleRow(
  workspaceId: string,
  role: string,
  permission: Record<string, string[]> | string,
) {
  await db.insert(schema.workspaceRoleTable).values({
    workspaceId,
    role,
    permission:
      typeof permission === "string" ? permission : JSON.stringify(permission),
  });
}

async function createShareLinkViaApi(
  app: ReturnType<typeof createApp>["app"],
  payload: { resourceType: string; resourceId: string; permission: string },
) {
  const response = await app.request("/api/share-manage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response;
}

async function seedTask(
  projectId: string,
  overrides?: Partial<{
    title: string;
    description: string | null;
    status: string;
    userId: string;
  }>,
) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title: overrides?.title ?? "Public task",
      description:
        overrides?.description === undefined
          ? "Shared description"
          : overrides.description,
      status: overrides?.status ?? "to-do",
      userId: overrides?.userId,
    })
    .returning();
  if (!task) {
    throw new Error("Failed to seed task");
  }
  return task;
}

describe("API integration: public share boundary", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    resetShareRateLimits();
    delete process.env.SHARE_RATE_LIMIT_READ;
    delete process.env.SHARE_RATE_LIMIT_WRITE;
  });

  afterEach(() => {
    delete process.env.SHARE_RATE_LIMIT_READ;
    delete process.env.SHARE_RATE_LIMIT_WRITE;
    vi.restoreAllMocks();
  });

  it("anonymous legacy public-project returns minimized DTO without identity or integration data", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const assignee = await createWorkspaceMember({ role: "member" });
    await seedTask(project.id, {
      userId: assignee.user.id,
    });
    await db
      .update(schema.projectTable)
      .set({ isPublic: true })
      .where(eq(schema.projectTable.id, project.id));

    mockAnonymousSession();
    const { app } = createApp();
    const response = await app.request(`/api/public-project/${project.id}`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as Record<string, unknown>;
    // Data minimization: no workspace, no user identity, no integration data.
    expect(payload).not.toHaveProperty("workspaceId");
    const columns = payload.columns as Array<Record<string, unknown>>;
    const flatTasks = columns.flatMap(
      (c) => c.tasks as Array<Record<string, unknown>>,
    );
    for (const task of flatTasks) {
      expect(task).not.toHaveProperty("userId");
      expect(task).not.toHaveProperty("assigneeName");
      expect(task).not.toHaveProperty("assigneeId");
      expect(task).not.toHaveProperty("assigneeImage");
      expect(task).not.toHaveProperty("externalLinks");
      expect(task).toHaveProperty("title");
    }
    expect(flatTasks.length).toBeGreaterThan(0);
  });

  it("anonymous legacy route refuses private projects", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAnonymousSession();
    const { app } = createApp();
    const response = await app.request(`/api/public-project/${project.id}`);
    expect(response.status).toBe(403);
  });

  it("changing public visibility requires project:share even with project:update", async () => {
    const member = await createWorkspaceMember({ role: "updater" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await createWorkspaceRoleRow(member.workspace.id, "updater", {
      project: ["read", "update"],
      task: ["read"],
      workspace: ["read"],
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(`/api/project/${project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: project.name,
        icon: project.icon ?? "Folder",
        slug: project.slug,
        description: project.description ?? "",
        isPublic: true,
      }),
    });
    expect(response.status).toBe(403);
  });

  it("admin with project:share can toggle public visibility", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(`/api/project/${project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: project.name,
        icon: project.icon ?? "Folder",
        slug: project.slug,
        description: project.description ?? "",
        isPublic: true,
      }),
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as { isPublic: boolean };
    expect(updated.isPublic).toBe(true);
  });

  it("share link flow: create, read anonymously, revoke fails closed", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await seedTask(project.id);

    mockAuthenticatedSession(member.user);
    let { app } = createApp();

    const createResponse = await createShareLinkViaApi(app, {
      resourceType: "project",
      resourceId: project.id,
      permission: "view",
    });
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      id: string;
      token: string;
      expiresAt: string | null;
      url: string;
    };
    // View links do not expire by default.
    expect(created.expiresAt).toBeNull();
    expect(created.url).toContain(`/share/project/${created.token}`);

    mockAnonymousSession();
    ({ app } = createApp());

    // Anonymous read through the capability link works even while the project
    // itself stays private (capability grants exactly this resource).
    const readResponse = await app.request(
      `/api/share/project/${created.token}`,
    );
    expect(readResponse.status).toBe(200);
    const payload = (await readResponse.json()) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("workspaceId");
    expect(payload.id).toBe(project.id);
    expect(readResponse.headers.get("referrer-policy")).toBe("no-referrer");
    expect(readResponse.headers.get("x-robots-tag")).toContain("noindex");

    // Malformed / unknown tokens fail closed without leaking existence.
    const badShape = await app.request("/api/share/project/not-a-token");
    expect(badShape.status).toBe(404);
    const unknownToken = `${"A".repeat(43)}`;
    const unknown = await app.request(`/api/share/project/${unknownToken}`);
    expect(unknown.status).toBe(404);

    // Revoke, then the same token fails closed.
    mockAuthenticatedSession(member.user);
    const revokeResponse = await app.request(
      `/api/share-manage/${created.id}`,
      {
        method: "DELETE",
      },
    );
    expect(revokeResponse.status).toBe(200);

    mockAnonymousSession();
    const revokedRead = await app.request(
      `/api/share/project/${created.token}`,
    );
    expect(revokedRead.status).toBe(404);
  });

  it("edit share links expire after 30 days and expired links fail closed", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAuthenticatedSession(member.user);
    let { app } = createApp();
    const createResponse = await createShareLinkViaApi(app, {
      resourceType: "project",
      resourceId: project.id,
      permission: "edit",
    });
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      token: string;
      expiresAt: string | null;
    };
    expect(created.expiresAt).not.toBeNull();
    const expiresAt = new Date(created.expiresAt as string);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(Date.now() + thirtyDays - expiresAt.getTime()).toBeLessThan(60_000);

    // Force-expire the link directly, then read must fail closed.
    await db
      .update(schema.shareLinkTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.shareLinkTable.resourceId, project.id));

    mockAnonymousSession();
    ({ app } = createApp());
    const expired = await app.request(`/api/share/project/${created.token}`);
    expect(expired.status).toBe(404);
  });

  it("public DTO redacts task descriptions for agent-controlled projects", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await seedTask(project.id, { description: "ENVELOPE run steps" });
    await db.insert(schema.executionManifestTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      verificationProfile: "test",
    });
    await db
      .update(schema.projectTable)
      .set({ isPublic: true })
      .where(eq(schema.projectTable.id, project.id));

    mockAnonymousSession();
    const { app } = createApp();
    const response = await app.request(`/api/public-project/${project.id}`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      columns: Array<{ tasks: Array<{ description: string | null }> }>;
      agentControlled?: boolean;
    };
    // P2-F4: the agent-control signal must not leak into the public payload.
    expect(payload.agentControlled).toBeUndefined();
    for (const column of payload.columns) {
      for (const task of column.tasks) {
        expect(task.description).toBeNull();
      }
    }

    // Same redaction through capability route.
    mockAuthenticatedSession(member.user);
    let { app: app2 } = createApp();
    const createResponse = await createShareLinkViaApi(app2, {
      resourceType: "project",
      resourceId: project.id,
      permission: "view",
    });
    const created = (await createResponse.json()) as { token: string };

    mockAnonymousSession();
    ({ app: app2 } = createApp());
    const shareRead = await app2.request(`/api/share/project/${created.token}`);
    expect(shareRead.status).toBe(200);
    const sharePayload = (await shareRead.json()) as {
      columns: Array<{ tasks: Array<{ description: string | null }> }>;
    };
    for (const column of sharePayload.columns) {
      for (const task of column.tasks) {
        expect(task.description).toBeNull();
      }
    }
  });

  it("public reads are rate limited with 429 and recovery guidance", async () => {
    process.env.SHARE_RATE_LIMIT_READ = "2";
    resetShareRateLimits();

    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await seedTask(project.id);

    mockAuthenticatedSession(member.user);
    let { app } = createApp();
    const createResponse = await createShareLinkViaApi(app, {
      resourceType: "project",
      resourceId: project.id,
      permission: "view",
    });
    const created = (await createResponse.json()) as { token: string };

    mockAnonymousSession();
    ({ app } = createApp());
    const first = await app.request(`/api/share/project/${created.token}`);
    expect(first.status).toBe(200);
    const second = await app.request(`/api/share/project/${created.token}`);
    expect(second.status).toBe(200);
    const third = await app.request(`/api/share/project/${created.token}`);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
    const body = (await third.json()) as { message?: string };
    expect(body.message).toBeTruthy();
  });

  it("creates scoped task-description/comment view links and lists copyable URLs", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const task = await seedTask(project.id, {
      title: "Private task title",
      description:
        "Only this task description is shared. ![shot](/api/asset/abc123)",
    });
    const [comment] = await db
      .insert(schema.activityTable)
      .values({
        taskId: task.id,
        userId: member.user.id,
        type: "comment",
        content: "Only this comment is shared.",
      })
      .returning();
    if (!comment) throw new Error("Failed to create comment fixture");

    mockAuthenticatedSession(member.user);
    let { app } = createApp();
    const taskLinkResponse = await createShareLinkViaApi(app, {
      resourceType: "task_description",
      resourceId: task.id,
      permission: "view",
    });
    expect(taskLinkResponse.status).toBe(200);
    const taskLink = (await taskLinkResponse.json()) as {
      id: string;
      token: string;
      url: string;
    };

    const commentLinkResponse = await createShareLinkViaApi(app, {
      resourceType: "activity_comment",
      resourceId: comment.id,
      permission: "view",
    });
    expect(commentLinkResponse.status).toBe(200);
    const commentLink = (await commentLinkResponse.json()) as {
      token: string;
      url: string;
    };

    const listed = await app.request(
      `/api/share-manage?resourceType=task_description&resourceId=${task.id}`,
    );
    expect(listed.status).toBe(200);
    const listedLinks = (await listed.json()) as Array<{
      id: string;
      url: string | null;
    }>;
    expect(listedLinks.find((link) => link.id === taskLink.id)?.url).toBe(
      taskLink.url,
    );

    mockAnonymousSession();
    ({ app } = createApp());
    const taskRead = await app.request(
      `/api/share/task_description/${taskLink.token}`,
    );
    expect(taskRead.status).toBe(200);
    const taskPayload = (await taskRead.json()) as Record<string, unknown>;
    expect(taskPayload.title).toBe(task.title);
    // JSON capability reads now carry the same canonical share-scoped asset
    // URLs as the raw markdown path, so stored absolute/relative private refs
    // never leak to the link holder.
    expect(String(taskPayload.content)).toContain(
      `/api/share/task_description/${taskLink.token}/asset/abc123`,
    );
    expect(String(taskPayload.content)).not.toContain("/api/asset/abc123");
    expect(taskPayload).not.toHaveProperty("workspaceId");
    expect(taskPayload).not.toHaveProperty("assigneeId");

    // Agent path: raw markdown with absolute share-scoped asset URLs, one
    // fetch per capability instead of browser automation.
    const taskRaw = await app.request(
      `/api/share/task_description/${taskLink.token}/raw`,
    );
    expect(taskRaw.status).toBe(200);
    expect(taskRaw.headers.get("content-type")).toContain("text/markdown");
    const taskRawText = await taskRaw.text();
    expect(taskRawText).toContain(`# ${task.title}`);
    expect(taskRawText).toContain(
      `/api/share/task_description/${taskLink.token}/asset/abc123`,
    );

    const commentRead = await app.request(
      `/api/share/activity_comment/${commentLink.token}`,
    );
    expect(commentRead.status).toBe(200);
    const commentPayload = (await commentRead.json()) as Record<
      string,
      unknown
    >;
    expect(commentPayload.content).toBe(comment.content);
    expect(commentPayload).not.toHaveProperty("userId");
    expect(commentPayload).not.toHaveProperty("userImage");
    expect(commentPayload).not.toHaveProperty("workspaceId");

    const commentRaw = await app.request(
      `/api/share/activity_comment/${commentLink.token}/raw`,
    );
    expect(commentRaw.status).toBe(200);
    expect(commentRaw.headers.get("content-type")).toContain("text/markdown");
    expect(await commentRaw.text()).toBe("Only this comment is shared.");

    mockAuthenticatedSession(member.user);
    const { app: editApp } = createApp();
    const editComment = await createShareLinkViaApi(editApp, {
      resourceType: "activity_comment",
      resourceId: comment.id,
      permission: "edit",
    });
    expect(editComment.status).toBe(400);
  });

  it("streams only assets referenced by the exact public comment", async () => {
    const getPrivateObject = vi
      .spyOn(s3, "getPrivateObject")
      .mockResolvedValue({
        body: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
        contentLength: 3,
        etag: "asset-etag",
        lastModified: new Date("2026-10-20T00:00:00.000Z"),
      });
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const task = await seedTask(project.id);
    const assetId = createId();
    const copiedTaskAssetId = createId();
    const otherAssetId = createId();
    const [comment] = await db
      .insert(schema.activityTable)
      .values({
        taskId: task.id,
        userId: member.user.id,
        type: "comment",
        content: `![proof](http://kaneo.test/api/asset/${assetId})\n![copied](http://kaneo.test/api/asset/${copiedTaskAssetId})`,
      })
      .returning();
    if (!comment) throw new Error("Failed to create comment fixture");

    await db.insert(schema.assetTable).values([
      {
        id: assetId,
        workspaceId: member.workspace.id,
        projectId: project.id,
        taskId: task.id,
        activityId: comment.id,
        objectKey: "private/comment-proof.png",
        filename: "proof.png",
        mimeType: "image/png",
        size: 3,
        kind: "image",
        surface: "comment",
      },
      {
        id: copiedTaskAssetId,
        workspaceId: member.workspace.id,
        projectId: project.id,
        taskId: task.id,
        objectKey: "private/copied-task-description.png",
        filename: "copied-task-description.png",
        mimeType: "image/png",
        size: 3,
        kind: "image",
        surface: "description",
      },
      {
        id: otherAssetId,
        workspaceId: member.workspace.id,
        projectId: project.id,
        taskId: task.id,
        objectKey: "private/unreferenced.png",
        filename: "unreferenced.png",
        mimeType: "image/png",
        size: 3,
        kind: "image",
        surface: "comment",
      },
    ]);

    mockAuthenticatedSession(member.user);
    let { app } = createApp();
    const createResponse = await createShareLinkViaApi(app, {
      resourceType: "activity_comment",
      resourceId: comment.id,
      permission: "view",
    });
    expect(createResponse.status).toBe(200);
    const link = (await createResponse.json()) as { id: string; token: string };

    mockAnonymousSession();
    ({ app } = createApp());
    const allowed = await app.request(
      `/api/share/activity_comment/${link.token}/asset/${assetId}`,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toBe("image/png");
    expect(allowed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(getPrivateObject).toHaveBeenCalledTimes(1);

    const copiedTaskAsset = await app.request(
      `/api/share/activity_comment/${link.token}/asset/${copiedTaskAssetId}`,
    );
    expect(copiedTaskAsset.status).toBe(200);
    expect(getPrivateObject).toHaveBeenCalledTimes(2);

    const unrelated = await app.request(
      `/api/share/activity_comment/${link.token}/asset/${otherAssetId}`,
    );
    expect(unrelated.status).toBe(404);

    mockAuthenticatedSession(member.user);
    ({ app } = createApp());
    const revoke = await app.request(`/api/share-manage/${link.id}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(200);
    mockAnonymousSession();
    ({ app } = createApp());
    const revoked = await app.request(
      `/api/share/activity_comment/${link.token}/asset/${assetId}`,
    );
    const revokedCopiedTaskAsset = await app.request(
      `/api/share/activity_comment/${link.token}/asset/${copiedTaskAssetId}`,
    );
    expect(revoked.status).toBe(404);
    expect(revokedCopiedTaskAsset.status).toBe(404);
  });

  it("keeps legacy hash-only links readable but cannot recover their URL", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const legacyToken = "A".repeat(43);
    await db.insert(schema.shareLinkTable).values({
      resourceType: "project",
      resourceId: project.id,
      permission: "view",
      tokenHash: hashShareToken(legacyToken),
      tokenCiphertext: null,
      workspaceId: member.workspace.id,
      createdByUserId: member.user.id,
      expiresAt: null,
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const listed = await app.request(
      `/api/share-manage?resourceType=project&resourceId=${project.id}`,
    );
    expect(listed.status).toBe(200);
    const links = (await listed.json()) as Array<{ url: string | null }>;
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBeNull();

    mockAnonymousSession();
    const { app: publicApp } = createApp();
    const stillWorks = await publicApp.request(
      `/api/share/project/${legacyToken}`,
    );
    expect(stillWorks.status).toBe(200);
  });

  it("refuses task-description links after a project becomes agent-controlled", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const task = await seedTask(project.id, { description: "ENVELOPE data" });
    await db.insert(schema.executionManifestTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      verificationProfile: "test",
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await createShareLinkViaApi(app, {
      resourceType: "task_description",
      resourceId: task.id,
      permission: "view",
    });
    expect(response.status).toBe(403);
  });

  it("share-manage requires authentication and valid permission", async () => {
    const member = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAnonymousSession();
    let { app } = createApp();
    const anonymous = await app.request("/api/share-manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "project",
        resourceId: project.id,
        permission: "view",
      }),
    });
    expect(anonymous.status).toBe(401);

    // Plain member (no project:share) is denied.
    mockAuthenticatedSession(member.user);
    ({ app } = createApp());
    const denied = await createShareLinkViaApi(app, {
      resourceType: "project",
      resourceId: project.id,
      permission: "view",
    });
    expect(denied.status).toBe(403);

    // Unknown resource fails closed.
    const admin = await createWorkspaceMember({ role: "admin" });
    mockAuthenticatedSession(admin.user);
    ({ app } = createApp());
    const unknownResource = await createShareLinkViaApi(app, {
      resourceType: "project",
      resourceId: "missing-project",
      permission: "view",
    });
    expect(unknownResource.status).toBe(404);

    // A link cannot be created for a resource outside the caller's workspace:
    // the permission check runs against the resource's own workspace, so the
    // admin of another workspace is denied even with project:share there.
    const { project: foreignProject } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const crossWorkspace = await createShareLinkViaApi(app, {
      resourceType: "project",
      resourceId: foreignProject.id,
      permission: "edit",
    });
    expect(crossWorkspace.status).toBe(403);
  });
});
