import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import {
  mockAnonymousSession,
  mockAuthenticatedSession,
} from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
  seedSessionPresence,
} from "./helpers/fixtures";

// SPEC-2026-11-10-kaneo-card-agent-collaboration T5: durable comment delivery.

async function hashApiKeyForTest(key: string) {
  return createHash("sha256")
    .update(key)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function seedPrincipal(userId: string) {
  const [principal] = await db
    .insert(schema.agentPrincipalTable)
    .values({
      userId,
      runtimeId: `delivery-agent-${randomUUID()}`,
      hostId: "delivery-host",
      scopes: ["run:claim"],
      isActive: true,
    })
    .returning();
  return principal;
}

async function seedTask(projectId: string) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title: "Delivery task",
      status: "to-do",
      priority: "medium",
      number: null,
    })
    .returning();
  return task;
}

async function seedApiKey(userId: string, permissions: Record<string, string[]>) {
  const rawKey = `delivery_${randomUUID()}`;
  const now = new Date();
  await db.insert(schema.apikeyTable).values({
    referenceId: userId,
    userId,
    key: await hashApiKeyForTest(rawKey),
    name: "T5 delivery test key",
    start: rawKey.slice(0, 12),
    prefix: "kaneo",
    createdAt: now,
    updatedAt: now,
    permissions: JSON.stringify(permissions),
  });
  return rawKey;
}

async function bindTask(
  app: ReturnType<typeof createApp>["app"],
  userId: string,
  taskId: string,
) {
  const principal = await seedPrincipal(userId);
  // SPEC-2026-11-25 D3: the session must have presence before a web bind.
  await seedSessionPresence({
    userId,
    sessionId: "pi-delivery-session",
    agentPrincipalId: principal.id,
  });
  const response = await app.request("/api/agent-session/bindings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId,
      agentPrincipalId: principal.id,
      sessionId: "pi-delivery-session",
    }),
  });
  expect(response.status).toBe(200);
  return {
    principal,
    binding: (await response.json()) as {
      bindingId: string;
      bindingGeneration: number;
      taskId: string;
      sessionId: string;
    },
  };
}

async function createComment(
  app: ReturnType<typeof createApp>["app"],
  taskId: string,
  content: string,
  route: "activity" | "comment" = "comment",
  authorization?: string,
) {
  const response = await app.request(
    route === "activity" ? "/api/activity/comment" : `/api/comment/${taskId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { "x-api-key": authorization } : {}),
      },
      body: JSON.stringify(
        route === "activity" ? { taskId, comment: content } : { content },
      ),
    },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; content: string };
}

async function queueComment(
  app: ReturnType<typeof createApp>["app"],
  binding: { bindingId: string; bindingGeneration: number; sessionId: string },
  commentId: string,
  clientActionKey: string,
) {
  return app.request(
    `/api/agent-session/bindings/${binding.bindingId}/deliveries`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: binding.sessionId,
        generation: binding.bindingGeneration,
        commentId,
        clientActionKey,
      }),
    },
  );
}

describe("API integration: durable comment-to-Pi delivery (SPEC T5)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("queues one pinned comment idempotently, claims it for the exact session, and acknowledges queued-to-Pi", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);
    const [asset] = await db
      .insert(schema.assetTable)
      .values({
        workspaceId: admin.workspace.id,
        projectId: project.id,
        taskId: task.id,
        objectKey: `workspace/${admin.workspace.id}/content/task_comment/${task.id}/proof.png`,
        filename: "proof.png",
        mimeType: "image/png",
        size: 10,
        kind: "image",
        surface: "comment",
      })
      .returning();

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const { principal, binding } = await bindTask(app, admin.user.id, task.id);
    const comment = await createComment(
      app,
      task.id,
      `Review this image.\n<kaneo-attachment url="/api/asset/${asset.id}" filename="proof.png" mime-type="image/png" size="10" />`,
    );
    const clientActionKey = randomUUID();

    const first = await queueComment(app, binding, comment.id, clientActionKey);
    expect(first.status).toBe(200);
    const firstReceipt = (await first.json()) as {
      duplicate: boolean;
      receipt: { deliveryId: string; state: string; commentId: string };
    };
    expect(firstReceipt.duplicate).toBe(false);
    expect(firstReceipt.receipt).toMatchObject({
      commentId: comment.id,
      state: "queued",
    });

    const duplicate = await queueComment(app, binding, comment.id, clientActionKey);
    expect(duplicate.status).toBe(200);
    const duplicateReceipt = (await duplicate.json()) as typeof firstReceipt;
    expect(duplicateReceipt.duplicate).toBe(true);
    expect(duplicateReceipt.receipt.deliveryId).toBe(firstReceipt.receipt.deliveryId);

    const [stored] = await db
      .select()
      .from(schema.agentSessionDeliveryTable)
      .where(eq(schema.agentSessionDeliveryTable.id, firstReceipt.receipt.deliveryId));
    expect(stored.commentContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.commentUpdatedAt).toBeTruthy();
    expect(stored.bindingGeneration).toBe(binding.bindingGeneration);
    expect(Object.keys(stored)).not.toContain("content");
    const [rowCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.agentSessionDeliveryTable)
      .where(eq(schema.agentSessionDeliveryTable.bindingId, binding.bindingId));
    expect(Number(rowCount?.count)).toBe(1);

    const rawApiKey = await seedApiKey(admin.user.id, {
      task: ["read", "update"],
      execution: ["run:claim"],
    });
    const claimPath =
      `/api/agent-session/bindings/${binding.bindingId}/deliveries/claim` +
      `?sessionId=${encodeURIComponent(binding.sessionId)}` +
      `&generation=${binding.bindingGeneration}&waitMs=0`;
    const wrongSession = await app.request(
      claimPath.replace(encodeURIComponent(binding.sessionId), "another-pi-session"),
      { headers: { authorization: `Bearer ${rawApiKey}` } },
    );
    expect(wrongSession.status).toBe(409);

    const claim = await app.request(claimPath, {
      headers: { authorization: `Bearer ${rawApiKey}` },
    });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as {
      delivery: {
        deliveryId: string;
        bindingId: string;
        bindingGeneration: number;
        sessionId: string;
        commentId: string;
        content: string;
        attachmentAssetIds: string[];
      };
    };
    expect(claimed.delivery).toMatchObject({
      deliveryId: firstReceipt.receipt.deliveryId,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      sessionId: binding.sessionId,
      commentId: comment.id,
    });
    expect(claimed.delivery.content).toContain("Review this image.");
    expect(claimed.delivery.attachmentAssetIds).toEqual([asset.id]);

    // Formal task_run cannot take the card while Pi has a live 60-second
    // delivery claim lease.
    await db.insert(schema.executionManifestTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      verificationProfile: "delivery-test",
      allowedAgentIds: [principal.id],
    });
    await db.insert(schema.githubIntegrationTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      isActive: true,
    });
    const liveClaim = await app.request(
      `/api/execution/task/${task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${rawApiKey}`,
          "content-type": "application/json",
          "idempotency-key": "delivery-live-claim-1",
        },
        body: JSON.stringify({ agentPrincipalId: principal.id, scope: ["README.md"] }),
      },
    );
    expect(liveClaim.status).toBe(409);
    expect(await liveClaim.text()).toContain("ad-hoc-delivery-in-flight");

    const ack = await app.request(
      `/api/agent-session/bindings/${binding.bindingId}/deliveries/${claimed.delivery.deliveryId}/ack`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${rawApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: binding.sessionId,
          generation: binding.bindingGeneration,
          outcome: "enqueued",
        }),
      },
    );
    expect(ack.status).toBe(200);
    expect(await ack.json()).toMatchObject({
      receipt: { state: "enqueued", deliveryId: claimed.delivery.deliveryId },
    });

    const resend = await queueComment(app, binding, comment.id, randomUUID());
    expect(resend.status).toBe(200);
    const resendReceipt = (await resend.json()) as {
      receipt: { deliveryId: string; state: string };
    };
    expect(resendReceipt.receipt.deliveryId).not.toBe(firstReceipt.receipt.deliveryId);
    expect(resendReceipt.receipt.state).toBe("queued");
  });

  it("marks edited or deleted comments stale before claim and never auto-replays unknown", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const { binding } = await bindTask(app, admin.user.id, task.id);

    const editComment = await createComment(app, task.id, "old text");
    const queuedEdit = await queueComment(app, binding, editComment.id, randomUUID());
    const editReceipt = (await queuedEdit.json()) as {
      receipt: { deliveryId: string };
    };
    const edit = await app.request(`/api/comment/${editComment.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "new text" }),
    });
    expect(edit.status).toBe(200);
    const editClaim = await app.request(
      `/api/agent-session/bindings/${binding.bindingId}/deliveries/claim?sessionId=${binding.sessionId}&generation=${binding.bindingGeneration}&waitMs=0`,
    );
    expect(editClaim.status).toBe(200);
    expect(await editClaim.json()).toEqual({ delivery: null });
    const staleEditStatus = await app.request(
      `/api/agent-session/bindings/${binding.bindingId}/deliveries/${editReceipt.receipt.deliveryId}`,
    );
    expect(await staleEditStatus.json()).toMatchObject({ state: "stale" });

    const deleteComment = await createComment(app, task.id, "delete me");
    const queuedDelete = await queueComment(app, binding, deleteComment.id, randomUUID());
    const deleteReceipt = (await queuedDelete.json()) as {
      receipt: { deliveryId: string };
    };
    const removed = await app.request(`/api/comment/${deleteComment.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const deleteStatus = await app.request(
      `/api/agent-session/bindings/${binding.bindingId}/deliveries/${deleteReceipt.receipt.deliveryId}`,
    );
    expect(await deleteStatus.json()).toMatchObject({ state: "stale" });

    const unknownComment = await createComment(app, task.id, "possibly delivered");
    const unknownKey = randomUUID();
    const queuedUnknown = await queueComment(app, binding, unknownComment.id, unknownKey);
    const unknownReceipt = (await queuedUnknown.json()) as {
      receipt: { deliveryId: string };
    };
    const rawApiKey = await seedApiKey(admin.user.id, { task: ["read", "update"] });
    const claim = await app.request(
      `/api/agent-session/bindings/${binding.bindingId}/deliveries/claim?sessionId=${binding.sessionId}&generation=${binding.bindingGeneration}&waitMs=0`,
      { headers: { authorization: `Bearer ${rawApiKey}` } },
    );
    expect(claim.status).toBe(200);
    const claimPayload = (await claim.json()) as {
      delivery: { deliveryId: string };
    };
    expect(claimPayload.delivery.deliveryId).toBe(unknownReceipt.receipt.deliveryId);
    await db
      .update(schema.agentSessionDeliveryTable)
      .set({ claimedLeaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.agentSessionDeliveryTable.id, claimPayload.delivery.deliveryId));

    const nextClaim = await app.request(
      `/api/agent-session/bindings/${binding.bindingId}/deliveries/claim?sessionId=${binding.sessionId}&generation=${binding.bindingGeneration}&waitMs=0`,
      { headers: { authorization: `Bearer ${rawApiKey}` } },
    );
    expect(await nextClaim.json()).toEqual({ delivery: null });
    const unknownStatus = await app.request(
      `/api/agent-session/bindings/${binding.bindingId}/deliveries/${claimPayload.delivery.deliveryId}`,
    );
    expect(await unknownStatus.json()).toMatchObject({ state: "unknown" });
    const sameAction = await queueComment(app, binding, unknownComment.id, unknownKey);
    expect(await sameAction.json()).toMatchObject({
      duplicate: true,
      receipt: { state: "unknown", deliveryId: claimPayload.delivery.deliveryId },
    });
  });

  it("restores the latest receipt by comment for workspace members after reload", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const task = await seedTask(project.id);
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const { binding } = await bindTask(app, admin.user.id, task.id);
    const comment = await createComment(app, task.id, "restore receipt");

    const queued = await queueComment(app, binding, comment.id, "restore-key-1");
    expect(queued.status).toBe(200);
    const queuedPayload = (await queued.json()) as {
      receipt: { deliveryId: string; state: string };
    };

    const restored = await app.request(
      `/api/agent-session/bindings/${binding.bindingId}/deliveries/by-comment/${comment.id}`,
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({
      delivery: expect.objectContaining({
        deliveryId: queuedPayload.receipt.deliveryId,
        state: "queued",
        commentId: comment.id,
      }),
    });

    // Unknown comment id reports an empty receipt, not an error.
    const missing = await app.request(
      `/api/agent-session/bindings/${binding.bindingId}/deliveries/by-comment/cm-nonexistent0000000000`,
    );
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ delivery: null });
  });

  it("API-key comments and attachment-only browser comments do not self-steer or trigger no-run fallback", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const tasks = await Promise.all(
      Array.from({ length: 4 }, () => seedTask(project.id)),
    );
    for (let index = 0; index < tasks.length; index += 1) {
      await db.insert(schema.taskRunTable).values({
        taskId: tasks[index]!.id,
        manifestVersion: 1,
        protocolVersion: 1,
        repositoryOwner: "owner",
        repositoryName: "repo",
        baseBranch: "main",
        state: "blocked_input",
        hostId: "delivery-host",
        branchName: `blocked-${index}`,
        scope: [],
        requestKey: `blocked-comment-${index}`,
        requestHash: `blocked-hash-${index}`,
        leaseTokenHash: `blocked-token-${index}`,
        leaseActive: false,
        leaseExpiresAt: new Date(Date.now() - 1),
      });
    }
    const rawApiKey = await seedApiKey(admin.user.id, { task: ["read", "update"] });
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();

    await createComment(app, tasks[0]!.id, "agent should not steer", "comment", rawApiKey);
    await createComment(app, tasks[1]!.id, "agent should not steer", "activity", rawApiKey);
    const attachmentOnly = `<kaneo-attachment url="/api/asset/asset-${randomUUID()}" filename="proof.png" mime-type="image/png" size="1" />`;
    await createComment(app, tasks[2]!.id, attachmentOnly, "comment");
    await createComment(app, tasks[3]!.id, attachmentOnly, "activity");

    for (const task of tasks) {
      const [commentCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.activityTable)
        .where(
          and(
            eq(schema.activityTable.taskId, task!.id),
            eq(schema.activityTable.type, "comment"),
          ),
        );
      expect(Number(commentCount?.count), `task ${task!.title} (${task!.id})`).toBe(1);
    }
    const controlRequests = await db.select().from(schema.executionControlRequestTable);
    expect(controlRequests).toHaveLength(0);
  });
});
