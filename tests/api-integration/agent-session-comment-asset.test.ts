import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  assertKeyMatches: vi.fn(() => true),
  deleteObject: vi.fn(async () => {}),
  getMeta: vi.fn(),
  getPrefix: vi.fn(),
  validateUpload: vi.fn(),
  presign: vi.fn(),
}));

vi.mock("../../apps/api/src/storage/s3", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../apps/api/src/storage/s3")>();
  return {
    ...actual,
    assertContentAssetKeyMatchesContext: storage.assertKeyMatches,
    deleteS3Object: storage.deleteObject,
    getPrivateObjectMeta: storage.getMeta,
    getPrivateObjectPrefix: storage.getPrefix,
    validateFullLinkUploadInput: storage.validateUpload,
    createContentAssetUploadUrl: storage.presign,
  };
});

import { eq } from "drizzle-orm";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

// SPEC-2026-11-10 UAT bug B (iss_20261116113109): uploading an asset bound to
// a specific comment (ownerType=task_comment + ownerId=commentId) previously
// 404ed because the owner resolver only looked the id up in the task table.

const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function bindCard(
  app: ReturnType<typeof createApp>["app"],
  taskId: string,
  userId: string,
) {
  const [principal] = await db
    .insert(schema.agentPrincipalTable)
    .values({
      userId,
      runtimeId: `pi-comment-${Math.random().toString(36).slice(2, 8)}`,
      hostId: "test-host",
      scopes: ["run:claim"],
      isActive: true,
    })
    .returning();
  if (!principal) throw new Error("Principal fixture failed to create");
  const response = await app.request("/api/agent-session/bindings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId,
      agentPrincipalId: principal.id,
      sessionId: "pi-comment-session",
    }),
  });
  if (response.status !== 200) {
    throw new Error(
      `bind failed ${response.status}: '${await response.text()}'`,
    );
  }
  return (await response.json()) as {
    bindingId: string;
    bindingGeneration: number;
  };
}

describe("API integration: comment-bound card asset upload (UAT bug B)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    storage.assertKeyMatches.mockReturnValue(true);
    storage.deleteObject.mockResolvedValue(undefined);
    storage.getMeta.mockResolvedValue({
      contentType: "image/png",
      contentLength: pngSignature.length,
    });
    storage.getPrefix.mockResolvedValue(pngSignature);
    storage.validateUpload.mockImplementation(() => {});
    storage.presign.mockImplementation(async (ctx) => ({
      key: `workspace/${ctx.workspaceId}/content/${ctx.ownerType}/${ctx.ownerId}/image.png`,
      uploadUrl: "https://presigned.example/upload",
      headers: {},
    }));
  });

  it("accepts a comment-scoped upload ticket with ownerId=commentId", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Comment asset root",
        status: "to-do",
        number: null,
      })
      .returning();
    if (!task) throw new Error("Task fixture failed to create");
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const binding = await bindCard(app, task.id, admin.user.id);

    const comment = await app.request(
      "/api/agent-session/card/comments/create",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bindingId: binding.bindingId,
          sessionId: "pi-comment-session",
          generation: binding.bindingGeneration,
          content: "Comment that will own the asset",
        }),
      },
    );
    expect(comment.status).toBe(200);
    const { id: commentId } = (await comment.json()) as { id: string };

    const ticket = await app.request(
      "/api/agent-session/card/assets/upload-ticket",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bindingId: binding.bindingId,
          sessionId: "pi-comment-session",
          generation: binding.bindingGeneration,
          ownerType: "task_comment",
          ownerId: commentId,
          filename: "screenshot.png",
          contentType: "image/png",
          size: pngSignature.length,
        }),
      },
    );
    expect(ticket.status).toBe(200);
    const ticketBody = (await ticket.json()) as { key: string };
    expect(ticketBody.key).toContain(`content/task_comment/${commentId}`);
  });

  it("finalizes a comment-scoped asset onto the owning task", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Comment asset finalize root",
        status: "to-do",
        number: null,
      })
      .returning();
    if (!task) throw new Error("Task fixture failed to create");
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const binding = await bindCard(app, task.id, admin.user.id);

    const comment = await app.request(
      "/api/agent-session/card/comments/create",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bindingId: binding.bindingId,
          sessionId: "pi-comment-session",
          generation: binding.bindingGeneration,
          content: "Comment for finalize",
        }),
      },
    );
    expect(comment.status).toBe(200);
    const { id: commentId } = (await comment.json()) as { id: string };

    const finalize = await app.request(
      "/api/agent-session/card/assets/finalize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bindingId: binding.bindingId,
          sessionId: "pi-comment-session",
          generation: binding.bindingGeneration,
          ownerType: "task_comment",
          ownerId: commentId,
          key: `workspace/${project.workspaceId}/content/task_comment/${commentId}/image.png`,
          filename: "screenshot.png",
          contentType: "image/png",
          size: pngSignature.length,
        }),
      },
    );
    expect(finalize.status).toBe(200);
    const receipt = (await finalize.json()) as { id: string };

    const [asset] = await db
      .select()
      .from(schema.assetTable)
      .where(eq(schema.assetTable.id, receipt.id))
      .limit(1);
    expect(asset?.taskId).toBe(task.id);
    expect(asset?.surface).toBe("comment");
    expect(asset?.objectKey).toContain(commentId);
  });

  it("keeps the established task-level comment-surface form working", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Task-level comment asset root",
        status: "to-do",
        number: null,
      })
      .returning();
    if (!task) throw new Error("Task fixture failed to create");
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const binding = await bindCard(app, task.id, admin.user.id);

    const finalize = await app.request(
      "/api/agent-session/card/assets/finalize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bindingId: binding.bindingId,
          sessionId: "pi-comment-session",
          generation: binding.bindingGeneration,
          ownerType: "task_comment",
          ownerId: task.id,
          key: "unit-test-object-key",
          filename: "image.png",
          contentType: "image/png",
          size: pngSignature.length,
        }),
      },
    );
    expect(finalize.status).toBe(200);
  });

  it("404s with a clear message when ownerId matches no comment or task", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Missing owner root",
        status: "to-do",
        number: null,
      })
      .returning();
    if (!task) throw new Error("Task fixture failed to create");
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const binding = await bindCard(app, task.id, admin.user.id);

    const ticket = await app.request(
      "/api/agent-session/card/assets/upload-ticket",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bindingId: binding.bindingId,
          sessionId: "pi-comment-session",
          generation: binding.bindingGeneration,
          ownerType: "task_comment",
          ownerId: "does-not-exist-anywhere",
          filename: "screenshot.png",
          contentType: "image/png",
          size: pngSignature.length,
        }),
      },
    );
    expect(ticket.status).toBe(404);
    expect(await ticket.text()).toContain("No comment or task matches");
  });

  it("still accepts description-surface uploads keyed by the task id", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Description asset root",
        status: "to-do",
        number: null,
      })
      .returning();
    if (!task) throw new Error("Task fixture failed to create");
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const binding = await bindCard(app, task.id, admin.user.id);

    const ticket = await app.request(
      "/api/agent-session/card/assets/upload-ticket",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bindingId: binding.bindingId,
          sessionId: "pi-comment-session",
          generation: binding.bindingGeneration,
          ownerType: "task_description",
          ownerId: task.id,
          filename: "notes.png",
          contentType: "image/png",
          size: pngSignature.length,
        }),
      },
    );
    expect(ticket.status).toBe(200);
    const ticketBody = (await ticket.json()) as { key: string };
    expect(ticketBody.key).toContain(`content/task_description/${task.id}`);
  });
});
