import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { buildContentAssetObjectKey } from "../../apps/api/src/storage/s3";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const s3Env = {
  S3_ENDPOINT: "https://storage.example.test",
  S3_BUCKET: "test-bucket",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
  S3_MAX_IMAGE_UPLOAD_BYTES: String(10 * 1024 * 1024),
};

afterEach(() => {
  for (const key of Object.keys(s3Env)) delete process.env[key];
  delete process.env.S3_KEY_PREFIX;
});

describe("API integration: resource-scoped content assets", () => {
  it("presigns and finalizes document and project-less goal-note files", async () => {
    await resetTestDatabase();
    Object.assign(process.env, s3Env);
    delete process.env.S3_KEY_PREFIX;

    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [document] = await db
      .insert(schema.documentTable)
      .values({ projectId: project.id, title: "Doc", content: "" })
      .returning();
    const [goal] = await db
      .insert(schema.goalTable)
      .values({
        workspaceId: member.workspace.id,
        ownerUserId: member.user.id,
        name: "Personal goal",
        visibility: "private",
        projectId: null,
      })
      .returning();
    const [checkin] = await db
      .insert(schema.goalCheckinTable)
      .values({
        goalId: goal.id,
        checkInDate: "2026-10-20",
        completed: false,
        note: "",
      })
      .returning();
    if (!document || !goal || !checkin) {
      throw new Error("Failed to create content asset fixtures");
    }

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const documentContext = {
      ownerType: "document",
      ownerId: document.id,
      filename: "notes.pdf",
      contentType: "application/pdf",
      size: 1024,
    };
    const documentUpload = await app.request("/api/content-asset/upload", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(documentContext),
    });
    expect(documentUpload.status).toBe(200);
    const documentPlan = (await documentUpload.json()) as {
      key: string;
      uploadUrl: string;
      headers: Record<string, string>;
    };
    expect(documentPlan.key).toContain(
      `workspace/${member.workspace.id}/content/document/${document.id}/`,
    );

    const documentFinalize = await app.request("/api/content-asset/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...documentContext, key: documentPlan.key }),
    });
    expect(documentFinalize.status).toBe(200);
    const documentAsset = (await documentFinalize.json()) as {
      id: string;
      kind: string;
      url: string;
    };
    expect(documentAsset.kind).toBe("attachment");
    expect(documentAsset.url).toContain(`/asset/${documentAsset.id}`);

    const goalContext = {
      ownerType: "goal_checkin",
      ownerId: checkin.id,
      filename: "practice.png",
      contentType: "image/png",
      size: 2048,
    };
    const goalKey = buildContentAssetObjectKey({
      workspaceId: member.workspace.id,
      ownerType: "goal_checkin",
      ownerId: checkin.id,
      filename: goalContext.filename,
      contentType: goalContext.contentType,
    });
    const goalFinalize = await app.request("/api/content-asset/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...goalContext, key: goalKey }),
    });
    expect(goalFinalize.status).toBe(200);
    const goalAsset = (await goalFinalize.json()) as {
      id: string;
      kind: string;
    };
    expect(goalAsset.kind).toBe("image");

    const [storedGoalAsset] = await db
      .select()
      .from(schema.assetTable)
      .where(eq(schema.assetTable.id, goalAsset.id))
      .limit(1);
    expect(storedGoalAsset?.workspaceId).toBe(member.workspace.id);
    expect(storedGoalAsset?.projectId).toBeNull();
    expect(storedGoalAsset?.goalCheckinId).toBe(checkin.id);
    expect(storedGoalAsset?.taskId).toBeNull();
  });

  it("rejects an upload key from another resource and validates its size", async () => {
    await resetTestDatabase();
    Object.assign(process.env, s3Env);

    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [document] = await db
      .insert(schema.documentTable)
      .values({ projectId: project.id, title: "Doc", content: "" })
      .returning();
    if (!document) throw new Error("Failed to create document fixture");

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const wrongKey = buildContentAssetObjectKey({
      workspaceId: member.workspace.id,
      ownerType: "document",
      ownerId: "different-document",
      filename: "notes.txt",
      contentType: "text/plain",
    });
    const wrongOwner = await app.request("/api/content-asset/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerType: "document",
        ownerId: document.id,
        key: wrongKey,
        filename: "notes.txt",
        contentType: "text/plain",
        size: 100,
      }),
    });
    expect(wrongOwner.status).toBe(400);

    const tooLarge = await app.request("/api/content-asset/upload", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerType: "document",
        ownerId: document.id,
        filename: "notes.pdf",
        contentType: "application/pdf",
        size: 50 * 1024 * 1024,
      }),
    });
    expect(tooLarge.status).toBe(400);
  });
});
