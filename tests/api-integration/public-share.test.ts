import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetShareRateLimits } from "../../apps/api/src/share/rate-limit";
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
      agentControlled: boolean;
      columns: Array<{ tasks: Array<{ description: string | null }> }>;
    };
    expect(payload.agentControlled).toBe(true);
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
      agentControlled: boolean;
      columns: Array<{ tasks: Array<{ description: string | null }> }>;
    };
    expect(sharePayload.agentControlled).toBe(true);
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
