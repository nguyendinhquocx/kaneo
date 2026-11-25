import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  assertKeyMatches: vi.fn(() => true),
  deleteObject: vi.fn(async () => {}),
  getMeta: vi.fn(),
  getPrefix: vi.fn(),
  validateUpload: vi.fn(),
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
  };
});

import db, { schema } from "../../apps/api/src/database";
import { subscribeToEvent } from "../../apps/api/src/events";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
  seedSessionPresence,
} from "./helpers/fixtures";

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
      runtimeId: `pi-live-${Math.random().toString(36).slice(2, 8)}`,
      hostId: "test-host",
      scopes: ["run:claim"],
      isActive: true,
    })
    .returning();
  if (!principal) throw new Error("Principal fixture failed to create");
  // SPEC-2026-11-25 D3: presence required before a web bind.
  await seedSessionPresence({
    userId,
    sessionId: "pi-session-live",
    agentPrincipalId: principal.id,
  });
  const response = await app.request("/api/agent-session/bindings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId,
      agentPrincipalId: principal.id,
      sessionId: "pi-session-live",
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    bindingId: string;
    bindingGeneration: number;
  };
}

describe("API integration: card asset live event", () => {
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
  });

  it("publishes asset.created only after a bound upload is finalized", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Asset event root",
        status: "to-do",
        number: null,
      })
      .returning();
    if (!task) throw new Error("Task fixture failed to create");
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const binding = await bindCard(app, task.id, admin.user.id);
    const seen: Array<Record<string, unknown>> = [];
    await subscribeToEvent("asset.created", async (data) => {
      seen.push(data as Record<string, unknown>);
    });

    const response = await app.request(
      "/api/agent-session/card/assets/finalize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bindingId: binding.bindingId,
          sessionId: "pi-session-live",
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
    expect(response.status).toBe(200);
    const receipt = (await response.json()) as { id: string };
    expect(seen).toContainEqual(
      expect.objectContaining({
        taskId: task.id,
        projectId: project.id,
        assetId: receipt.id,
      }),
    );
  });
});
