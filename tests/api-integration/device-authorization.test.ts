import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { API_KEY_DEFAULT_PERMISSIONS_JSON } from "../../apps/api/src/utils/api-key-permissions";
import { migrateApiKeyReferenceId } from "../../apps/api/src/utils/migrate-apikey-reference-id";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

const origin = "http://localhost:5173";

function mergeCookieJar(cookieJar: string, res: Response): string {
  const incoming = res.headers.getSetCookie?.() ?? [];
  if (incoming.length === 0) {
    return cookieJar;
  }
  const pairs = incoming.map((c) => c.split(";")[0]).filter(Boolean);
  const prefix = cookieJar ? `${cookieJar}; ` : "";
  return `${prefix}${pairs.join("; ")}`;
}

async function hashApiKeyForTest(key: string): Promise<string> {
  const hash = createHash("sha256").update(key).digest();
  return hash
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function signUpAndGetCookie(
  app: ReturnType<typeof createApp>["app"],
  email: string,
  password: string,
): Promise<string> {
  let jar = "csrf=1";
  const signUp = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: origin,
      Cookie: jar,
    },
    body: JSON.stringify({
      name: "Device flow user",
      email,
      password,
    }),
  });

  expect(signUp.status).toBe(200);
  jar = mergeCookieJar(jar, signUp);

  const signIn = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: origin,
      Cookie: jar,
    },
    body: JSON.stringify({ email, password }),
  });

  expect(signIn.status).toBe(200);
  jar = mergeCookieJar(jar, signIn);
  return jar;
}

describe("API integration: device authorization (RFC 8628)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("returns device and user codes for an allowed client_id", async () => {
    const { app } = createApp();

    const res = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ client_id: "kaneo-cli" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.device_code).toEqual(expect.any(String));
    expect(body.user_code).toEqual(expect.any(String));
    expect(body.verification_uri).toEqual(expect.any(String));
    expect(body.interval).toEqual(expect.any(Number));
    expect(body.expires_in).toEqual(expect.any(Number));
  });

  it("rejects disallowed client_id", async () => {
    const { app } = createApp();

    const res = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ client_id: "unknown-client" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_client");
  });

  it("returns authorization_pending before approval", async () => {
    const { app } = createApp();

    const codeRes = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ client_id: "kaneo-cli" }),
    });
    const { device_code } = (await codeRes.json()) as { device_code: string };

    const tokenRes = await app.request("/api/auth/device/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code,
        client_id: "kaneo-cli",
      }),
    });

    expect(tokenRes.status).toBe(400);
    const body = (await tokenRes.json()) as { error: string };
    expect(body.error).toBe("authorization_pending");
  });

  it("issues an access token after approval and allows API access with Bearer", async () => {
    const email = `device-${randomUUID()}@example.com`;
    const password = "device-flow-password-12345";

    const { app } = createApp();
    const cookieJar = await signUpAndGetCookie(app, email, password);

    const sessionRes = await app.request("/api/auth/get-session", {
      headers: {
        Cookie: cookieJar,
        Origin: origin,
      },
    });
    expect(sessionRes.status).toBe(200);
    const sessionJson = (await sessionRes.json()) as {
      user?: { id: string };
    };
    const userId = sessionJson.user?.id;
    if (!userId) {
      throw new Error("expected session user id after sign-in");
    }

    const workspaceId = `ws-${randomUUID()}`;
    await db.insert(schema.workspaceTable).values({
      id: workspaceId,
      name: "Device test workspace",
      slug: `slug-${randomUUID()}`,
      createdAt: new Date(),
    });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId,
      userId,
      role: "owner",
      joinedAt: new Date(),
    });

    const codeRes = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ client_id: "kaneo-cli" }),
    });
    expect(codeRes.status).toBe(200);
    const devicePayload = (await codeRes.json()) as {
      device_code: string;
      user_code: string;
      interval: number;
    };

    // better-auth >= 1.6.11 requires the authenticated user to first claim the
    // code (GET /device?user_code=...) before it can be approved.
    const claimRes = await app.request(
      `/api/auth/device?user_code=${encodeURIComponent(devicePayload.user_code)}`,
      {
        method: "GET",
        headers: {
          Origin: origin,
          Cookie: cookieJar,
        },
      },
    );
    expect(claimRes.status).toBe(200);

    const approveRes = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: origin,
        Cookie: cookieJar,
      },
      body: JSON.stringify({
        userCode: devicePayload.user_code,
      }),
    });
    if (approveRes.status !== 200) {
      const body = await approveRes.text();
      console.error("APPROVE ERROR:", approveRes.status, body);
    }
    expect(approveRes.status).toBe(200);

    let accessToken: string | undefined;
    const maxAttempts = 40;
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) {
        await new Promise((r) =>
          setTimeout(r, devicePayload.interval * 1000 + 50),
        );
      }
      const tokenRes = await app.request("/api/auth/device/token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: devicePayload.device_code,
          client_id: "kaneo-cli",
        }),
      });
      if (tokenRes.status === 200) {
        const t = (await tokenRes.json()) as { access_token?: string };
        accessToken = t.access_token;
        break;
      }
      const err = (await tokenRes.json()) as { error: string };
      if (err.error !== "authorization_pending" && err.error !== "slow_down") {
        throw new Error(`Unexpected token error: ${err.error}`);
      }
    }

    expect(accessToken).toBeTruthy();

    const organizationsRes = await app.request("/api/auth/organization/list", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(organizationsRes.status).toBe(200);
    const organizations = (await organizationsRes.json()) as unknown[];
    expect(Array.isArray(organizations)).toBe(true);

    const projectsRes = await app.request(
      `/api/project?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    expect(projectsRes.status).toBe(200);
    const projects = (await projectsRes.json()) as unknown[];
    expect(Array.isArray(projects)).toBe(true);
  });

  it("applies explicit compatibility scopes to a newly created API key", async () => {
    const email = `api-key-${randomUUID()}@example.com`;
    const password = "api-key-password-12345";
    const { app } = createApp();
    const cookieJar = await signUpAndGetCookie(app, email, password);

    const sessionRes = await app.request("/api/auth/get-session", {
      headers: { Cookie: cookieJar, Origin: origin },
    });
    const session = (await sessionRes.json()) as { user?: { id: string } };
    const userId = session.user?.id;
    if (!userId) throw new Error("expected created user id");

    const workspaceId = `ws-${randomUUID()}`;
    await db.insert(schema.workspaceTable).values({
      id: workspaceId,
      name: "API key compatibility workspace",
      slug: `slug-${randomUUID()}`,
      createdAt: new Date(),
    });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId,
      userId,
      role: "owner",
      joinedAt: new Date(),
    });

    const createKeyRes = await app.request("/api/auth/api-key/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: cookieJar,
        Origin: origin,
      },
      body: JSON.stringify({
        name: "compatibility key",
        expiresIn: 86400,
      }),
    });

    expect(createKeyRes.status).toBe(200);
    const created = (await createKeyRes.json()) as {
      key?: string;
      permissions?: Record<string, string[]> | null;
    };
    expect(created.key).toEqual(expect.any(String));
    expect(created.permissions).toEqual(
      JSON.parse(API_KEY_DEFAULT_PERMISSIONS_JSON),
    );

    const [stored] = await db
      .select({ permissions: schema.apikeyTable.permissions })
      .from(schema.apikeyTable)
      .where(eq(schema.apikeyTable.referenceId, userId))
      .limit(1);
    expect(stored?.permissions).toBe(API_KEY_DEFAULT_PERMISSIONS_JSON);

    const projectsRes = await app.request(
      `/api/project?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { Authorization: `Bearer ${created.key}` } },
    );
    expect(projectsRes.status).toBe(200);

    const projectRes = await app.request("/api/project", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Compatibility project",
        workspaceId,
        icon: "Folder",
        slug: `compatibility-${randomUUID()}`,
      }),
    });
    expect(projectRes.status).toBe(200);
  });

  it("backfills only NULL API-key scopes with the explicit compatibility envelope", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const rawKey = `kaneo_legacy_${randomUUID()}`;
    const hashed = await hashApiKeyForTest(rawKey);
    const now = new Date();

    await db.insert(schema.apikeyTable).values({
      referenceId: member.user.id,
      userId: member.user.id,
      key: hashed,
      name: "legacy key",
      start: rawKey.slice(0, 12),
      prefix: "kaneo",
      createdAt: now,
      updatedAt: now,
      permissions: null,
    });

    await migrateApiKeyReferenceId();

    const [stored] = await db
      .select({ permissions: schema.apikeyTable.permissions })
      .from(schema.apikeyTable)
      .where(eq(schema.apikeyTable.key, hashed))
      .limit(1);
    expect(stored?.permissions).toBe(API_KEY_DEFAULT_PERMISSIONS_JSON);
  });

  it("denies a permissionless API key on a protected workspace route", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const rawKey = `kaneo_scope_${randomUUID()}`;
    const hashed = await hashApiKeyForTest(rawKey);
    const now = new Date();

    await db.insert(schema.apikeyTable).values({
      referenceId: member.user.id,
      userId: member.user.id,
      key: hashed,
      name: "permissionless key",
      start: rawKey.slice(0, 12),
      prefix: "kaneo",
      createdAt: now,
      updatedAt: now,
      permissions: null,
    });

    const { app } = createApp();
    const response = await app.request("/api/project", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Permissionless project",
        workspaceId: member.workspace.id,
        icon: "Folder",
        slug: `permissionless-${randomUUID()}`,
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("Insufficient API key scope");
  });

  it("enforces the API key scope map independently from the workspace role", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const rawKey = `kaneo_scope_${randomUUID()}`;
    const hashed = await hashApiKeyForTest(rawKey);
    const now = new Date();

    await db.insert(schema.apikeyTable).values({
      referenceId: member.user.id,
      userId: member.user.id,
      key: hashed,
      name: "read-only key",
      start: rawKey.slice(0, 12),
      prefix: "kaneo",
      createdAt: now,
      updatedAt: now,
      permissions: JSON.stringify({ project: ["read"] }),
    });

    const { app } = createApp();
    const readResponse = await app.request(
      `/api/project?workspaceId=${encodeURIComponent(member.workspace.id)}`,
      { headers: { Authorization: `Bearer ${rawKey}` } },
    );
    expect(readResponse.status).toBe(200);

    const writeResponse = await app.request("/api/project", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Read-only key project",
        workspaceId: member.workspace.id,
        icon: "Folder",
        slug: `read-only-${randomUUID()}`,
      }),
    });
    expect(writeResponse.status).toBe(403);
  });

  it("rejects malformed API key permissions instead of widening scope", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const rawKey = `kaneo_scope_${randomUUID()}`;
    const hashed = await hashApiKeyForTest(rawKey);
    const now = new Date();

    await db.insert(schema.apikeyTable).values({
      referenceId: member.user.id,
      userId: member.user.id,
      key: hashed,
      name: "malformed key",
      start: rawKey.slice(0, 12),
      prefix: "kaneo",
      createdAt: now,
      updatedAt: now,
      permissions: JSON.stringify({ project: "read" }),
    });

    await migrateApiKeyReferenceId();

    const { app } = createApp();
    const response = await app.request("/api/project", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Malformed key project",
        workspaceId: member.workspace.id,
        icon: "Folder",
        slug: `malformed-${randomUUID()}`,
      }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects an API key whose stored ownership fields disagree", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const other = await createWorkspaceMember({ role: "admin" });
    const rawKey = `kaneo_binding_${randomUUID()}`;
    const hashed = await hashApiKeyForTest(rawKey);
    const now = new Date();

    await db.insert(schema.apikeyTable).values({
      referenceId: member.user.id,
      userId: other.user.id,
      key: hashed,
      name: "mismatched owner key",
      start: rawKey.slice(0, 12),
      prefix: "kaneo",
      createdAt: now,
      updatedAt: now,
      permissions: JSON.stringify({ project: ["read"] }),
    });

    const { app } = createApp();
    const response = await app.request(
      `/api/project?workspaceId=${encodeURIComponent(member.workspace.id)}`,
      { headers: { Authorization: `Bearer ${rawKey}` } },
    );

    expect(response.status).toBe(401);
  });

  it("rejects an expired API key even when its stored owner is a workspace admin", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const rawKey = `kaneo_expired_${randomUUID()}`;
    const hashed = await hashApiKeyForTest(rawKey);

    await db.insert(schema.apikeyTable).values({
      referenceId: member.user.id,
      userId: member.user.id,
      key: hashed,
      name: "expired key",
      start: rawKey.slice(0, 12),
      prefix: "kaneo",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      expiresAt: new Date(Date.now() - 1),
      permissions: JSON.stringify({ project: ["read"] }),
    });

    const { app } = createApp();
    const response = await app.request(
      `/api/project?workspaceId=${encodeURIComponent(member.workspace.id)}`,
      { headers: { Authorization: `Bearer ${rawKey}` } },
    );

    expect(response.status).toBe(401);
  });

  it("still authenticates with a valid API key Bearer", async () => {
    const member = await createWorkspaceMember();

    const rawKey = `kaneo_test_${randomUUID()}`;
    const hashed = await hashApiKeyForTest(rawKey);
    const now = new Date();

    await db.insert(schema.apikeyTable).values({
      referenceId: member.user.id,
      userId: member.user.id,
      key: hashed,
      name: "integration device test",
      start: rawKey.slice(0, 12),
      prefix: "kaneo",
      createdAt: now,
      updatedAt: now,
    });

    const { app } = createApp();

    const res = await app.request(
      `/api/project?workspaceId=${encodeURIComponent(member.workspace.id)}`,
      {
        headers: {
          Authorization: `Bearer ${rawKey}`,
        },
      },
    );

    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(schema.apikeyTable)
      .where(eq(schema.apikeyTable.key, hashed));
    expect(rows.length).toBe(1);
  });

  it("accepts a created API key Bearer on auth routes", async () => {
    const member = await createWorkspaceMember();
    const rawKey =
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const hashed = await hashApiKeyForTest(rawKey);
    const now = new Date();

    await db.insert(schema.apikeyTable).values({
      referenceId: member.user.id,
      userId: member.user.id,
      key: hashed,
      name: "auth route api key",
      start: rawKey.slice(0, 12),
      createdAt: now,
      updatedAt: now,
    });

    const { app } = createApp();

    const authRouteRes = await app.request("/api/auth/organization/list", {
      headers: {
        Authorization: `Bearer ${rawKey}`,
      },
    });

    expect(authRouteRes.status).toBe(200);
  });

  it("rejects an invalid Bearer token even when a valid session cookie is present", async () => {
    const email = `device-bearer-${randomUUID()}@example.com`;
    const password = "device-flow-password-12345";

    const { app } = createApp();
    const cookieJar = await signUpAndGetCookie(app, email, password);

    const sessionRes = await app.request("/api/auth/get-session", {
      headers: {
        Cookie: cookieJar,
        Origin: origin,
      },
    });
    expect(sessionRes.status).toBe(200);
    const sessionJson = (await sessionRes.json()) as {
      user?: { id: string };
    };
    const userId = sessionJson.user?.id;
    if (!userId) {
      throw new Error("expected session user id after sign-in");
    }

    const workspaceId = `ws-${randomUUID()}`;
    await db.insert(schema.workspaceTable).values({
      id: workspaceId,
      name: "Bearer fallback workspace",
      slug: `slug-${randomUUID()}`,
      createdAt: new Date(),
    });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId,
      userId,
      role: "owner",
      joinedAt: new Date(),
    });

    const res = await app.request(
      `/api/project?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        headers: {
          Authorization: "Bearer definitely-not-a-real-token",
          Cookie: cookieJar,
          Origin: origin,
        },
      },
    );

    expect(res.status).toBe(401);

    const lowercaseSchemeRes = await app.request(
      `/api/project?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        headers: {
          authorization: "bearer definitely-not-a-real-token",
          Cookie: cookieJar,
          Origin: origin,
        },
      },
    );

    expect(lowercaseSchemeRes.status).toBe(401);
  });
});
