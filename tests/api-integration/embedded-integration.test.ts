import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import {
  mockAnonymousSession,
  mockAuthenticatedSessions,
} from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const ENV_KEYS = [
  "KANEO_MITRA_BASE_URL",
  "KANEO_MITRA_VIEW_MODE",
  "KANEO_WISEMAPPING_BASE_URL",
  "KANEO_WISEMAPPING_VIEW_MODE",
] as const;

function setServiceEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
) {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function countWisemappingRows(projectId: string) {
  const rows = await db.query.integrationTable.findMany({
    where: (integration, { and, eq }) =>
      and(
        eq(integration.projectId, projectId),
        eq(integration.type, "wisemapping"),
      ),
  });
  return rows.length;
}

describe("API integration: embedded services config", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    setServiceEnv({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setServiceEnv({});
  });

  it("never exposes embedded service config through the public /api/config", async () => {
    setServiceEnv({
      KANEO_MITRA_BASE_URL: "https://calendar.internal.example",
      KANEO_MITRA_VIEW_MODE: "embedded",
      KANEO_WISEMAPPING_BASE_URL: "https://maps.internal.example",
      KANEO_WISEMAPPING_VIEW_MODE: "open-only",
    });
    mockAnonymousSession();
    const { app } = createApp();

    const response = await app.request("/api/config");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(payload).not.toHaveProperty("mitra");
    expect(payload).not.toHaveProperty("wisemapping");
    expect(JSON.stringify(payload)).not.toContain("internal.example");
  });

  it("returns null services for members when nothing is configured", async () => {
    const member = await createWorkspaceMember({ role: "member" });
    mockAuthenticatedSessions(member.user, {});
    const { app } = createApp();

    const response = await app.request(
      `/api/embedded-integration/workspace-config?workspaceId=${member.workspace.id}`,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      mitra: unknown;
      wisemapping: unknown;
    };
    expect(payload.mitra).toBeNull();
    expect(payload.wisemapping).toBeNull();
  });

  it("returns configured URL and explicit mode for workspace members", async () => {
    const member = await createWorkspaceMember({ role: "member" });
    setServiceEnv({
      KANEO_MITRA_BASE_URL: "https://calendar.internal.example/",
      KANEO_MITRA_VIEW_MODE: "embedded",
      KANEO_WISEMAPPING_BASE_URL: "https://maps.internal.example",
      KANEO_WISEMAPPING_VIEW_MODE: "open-only",
    });
    mockAuthenticatedSessions(member.user, {});
    const { app } = createApp();

    const response = await app.request(
      `/api/embedded-integration/workspace-config?workspaceId=${member.workspace.id}`,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      mitra: { baseUrl: string; viewMode: string } | null;
      wisemapping: { baseUrl: string; viewMode: string } | null;
    };
    expect(payload.mitra).toEqual({
      baseUrl: "https://calendar.internal.example",
      viewMode: "embedded",
    });
    expect(payload.wisemapping).toEqual({
      baseUrl: "https://maps.internal.example",
      viewMode: "open-only",
    });
  });

  it.each([
    ["missing mode", { KANEO_MITRA_BASE_URL: "https://x.example" }],
    ["missing url", { KANEO_MITRA_VIEW_MODE: "embedded" }],
    [
      "invalid mode",
      {
        KANEO_MITRA_BASE_URL: "https://x.example",
        KANEO_MITRA_VIEW_MODE: "auto",
      },
    ],
    [
      "non-https url",
      {
        KANEO_MITRA_BASE_URL: "http://x.example",
        KANEO_MITRA_VIEW_MODE: "embedded",
      },
    ],
    [
      "url with userinfo",
      {
        KANEO_MITRA_BASE_URL: "https://user:pass@x.example",
        KANEO_MITRA_VIEW_MODE: "embedded",
      },
    ],
    [
      "url with query",
      {
        KANEO_MITRA_BASE_URL: "https://x.example/?a=1",
        KANEO_MITRA_VIEW_MODE: "embedded",
      },
    ],
    [
      "url with fragment",
      {
        KANEO_MITRA_BASE_URL: "https://x.example/#login",
        KANEO_MITRA_VIEW_MODE: "embedded",
      },
    ],
    [
      "not a url",
      {
        KANEO_MITRA_BASE_URL: "not a url",
        KANEO_MITRA_VIEW_MODE: "embedded",
      },
    ],
  ])("disables mitra on %s config", async (_label, env) => {
    const member = await createWorkspaceMember({ role: "member" });
    setServiceEnv(env);
    mockAuthenticatedSessions(member.user, {});
    const { app } = createApp();

    const response = await app.request(
      `/api/embedded-integration/workspace-config?workspaceId=${member.workspace.id}`,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { mitra: unknown };
    expect(payload.mitra).toBeNull();
  });

  it("blocks unauthenticated access to the services config", async () => {
    const member = await createWorkspaceMember({ role: "member" });
    setServiceEnv({
      KANEO_MITRA_BASE_URL: "https://calendar.internal.example",
      KANEO_MITRA_VIEW_MODE: "embedded",
    });
    mockAnonymousSession();
    const { app } = createApp();

    const response = await app.request(
      `/api/embedded-integration/workspace-config?workspaceId=${member.workspace.id}`,
    );
    expect(response.status).toBe(401);
    const body = (await response.text()) || "";
    expect(body).not.toContain("calendar.internal.example");
  });
});

describe("API integration: project mind map binding", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    setServiceEnv({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setServiceEnv({});
  });

  it("starts unlinked and links a map for an admin", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    mockAuthenticatedSessions(admin.user, {});
    const { app } = createApp();

    const initial = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
    );
    expect(initial.status).toBe(200);
    expect(((await initial.json()) as { mapId: unknown }).mapId).toBeNull();

    const link = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mapId: "mindmap-abc-123" }),
      },
    );
    expect(link.status).toBe(200);
    expect(((await link.json()) as { mapId: unknown }).mapId).toBe(
      "mindmap-abc-123",
    );

    const fetched = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
    );
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as { mapId: unknown }).mapId).toBe(
      "mindmap-abc-123",
    );
    expect(await countWisemappingRows(project.id)).toBe(1);
  });

  it("replaces an existing binding without duplicating rows", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    mockAuthenticatedSessions(admin.user, {});
    const { app } = createApp();

    for (const mapId of ["map-one", "map-two"]) {
      const link = await app.request(
        `/api/embedded-integration/project/${project.id}/mind-map`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mapId }),
        },
      );
      expect(link.status).toBe(200);
    }

    expect(await countWisemappingRows(project.id)).toBe(1);
    const fetched = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
    );
    expect(((await fetched.json()) as { mapId: unknown }).mapId).toBe(
      "map-two",
    );
  });

  it("allows non-alphanumeric opaque IDs and preserves them", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    mockAuthenticatedSessions(admin.user, {});
    const { app } = createApp();

    const mapId = "bàn-đồ-tư-duy-🧠-1";
    const link = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mapId }),
      },
    );
    expect(link.status).toBe(200);

    const fetched = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
    );
    expect(((await fetched.json()) as { mapId: unknown }).mapId).toBe(mapId);
  });

  it.each([
    ["empty", ""],
    ["dot", "."],
    ["dot-dot", ".."],
    ["encoded-dot", "%2E"],
    ["encoded-dot-dot", "%2e%2e"],
    ["encoded-slash", "%2F"],
    ["encoded-space", "a%20b"],
    ["slash", "a/b"],
    ["backslash", "a\\b"],
    ["question", "a?b"],
    ["hash", "a#b"],
    ["newline", "a\nb"],
    ["tab", "a\tb"],
    ["too-long", "a".repeat(257)],
  ])("rejects invalid mapId: %s", async (_label, mapId) => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    mockAuthenticatedSessions(admin.user, {});
    const { app } = createApp();

    const link = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mapId }),
      },
    );
    expect(link.status).toBe(400);
  });

  it("rejects a plain member without manage_settings on link", async () => {
    const member = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    mockAuthenticatedSessions(member.user, {});
    const { app } = createApp();

    const link = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mapId: "map-1" }),
      },
    );
    expect(link.status).toBe(403);

    const unlink = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      { method: "DELETE" },
    );
    expect(unlink.status).toBe(403);
  });

  it("blocks an authenticated outsider from another workspace", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const outsider = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    mockAuthenticatedSessions(admin.user, {
      "outsider-token": outsider.user,
    });
    const { app } = createApp();

    const fetched = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      { headers: { authorization: "Bearer outsider-token" } },
    );
    expect(fetched.status).toBe(403);

    const link = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer outsider-token",
        },
        body: JSON.stringify({ mapId: "map-1" }),
      },
    );
    expect(link.status).toBe(403);
  });

  it("blocks an authenticated outsider from the workspace services config", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const outsider = await createWorkspaceMember({ role: "admin" });
    setServiceEnv({
      KANEO_MITRA_BASE_URL: "https://calendar.internal.example",
      KANEO_MITRA_VIEW_MODE: "embedded",
    });
    mockAuthenticatedSessions(admin.user, {
      "outsider-token": outsider.user,
    });
    const { app } = createApp();

    const response = await app.request(
      `/api/embedded-integration/workspace-config?workspaceId=${admin.workspace.id}`,
      { headers: { authorization: "Bearer outsider-token" } },
    );
    expect(response.status).toBe(403);
    const body = (await response.text()) || "";
    expect(body).not.toContain("calendar.internal.example");
  });

  it("lets a plain member read the binding but not mutate it", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const member = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    // Member must share the workspace to pass the membership guard.
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: admin.workspace.id,
      userId: member.user.id,
      role: "member",
      joinedAt: new Date(),
    });
    mockAuthenticatedSessions(admin.user, {
      "member-token": member.user,
    });
    const { app } = createApp();

    const link = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer member-token",
        },
        body: JSON.stringify({ mapId: "map-x" }),
      },
    );
    expect(link.status).toBe(403);

    const fetched = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      { headers: { authorization: "Bearer member-token" } },
    );
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as { mapId: unknown }).mapId).toBeNull();
  });

  it("treats a malformed binding row as unlinked", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    await db.insert(schema.integrationTable).values({
      projectId: project.id,
      type: "wisemapping",
      config: "not-json{",
      isActive: true,
    });
    mockAuthenticatedSessions(admin.user, {});
    const { app } = createApp();

    const fetched = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
    );
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as { mapId: unknown }).mapId).toBeNull();
  });

  it("blocks unauthenticated access to the binding", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    mockAnonymousSession();
    const { app } = createApp();

    const fetched = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
    );
    expect(fetched.status).toBe(401);
  });

  it("keeps bindings project-scoped", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project: projectA } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const { project: projectB } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    mockAuthenticatedSessions(admin.user, {});
    const { app } = createApp();

    await app.request(
      `/api/embedded-integration/project/${projectA.id}/mind-map`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mapId: "map-a" }),
      },
    );

    const other = await app.request(
      `/api/embedded-integration/project/${projectB.id}/mind-map`,
    );
    expect(other.status).toBe(200);
    expect(((await other.json()) as { mapId: unknown }).mapId).toBeNull();
  });

  it("unlinks without touching the external map", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    mockAuthenticatedSessions(admin.user, {});
    const { app } = createApp();

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mapId: "map-a" }),
      },
    );

    const unlink = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
      { method: "DELETE" },
    );
    expect(unlink.status).toBe(200);
    expect(((await unlink.json()) as { mapId: unknown }).mapId).toBeNull();

    const fetched = await app.request(
      `/api/embedded-integration/project/${project.id}/mind-map`,
    );
    expect(((await fetched.json()) as { mapId: unknown }).mapId).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
