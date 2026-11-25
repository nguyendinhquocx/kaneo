import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { subscribeToEvent } from "../../apps/api/src/events";
import { createApp } from "../../apps/api/src/index";
import {
  mockAnonymousSession,
  mockAuthenticatedSession,
  mockAuthenticatedSessions,
} from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
  seedSessionPresence,
} from "./helpers/fixtures";

// SPEC-2026-11-10-kaneo-card-agent-collaboration T4: session binding +
// card-scoped tool contract.

async function seedPrincipal(userId: string) {
  const [principal] = await db
    .insert(schema.agentPrincipalTable)
    .values({
      userId,
      runtimeId: `pi-coding-agent-${userId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
      hostId: "test-host",
      scopes: ["run:claim"],
      isActive: true,
    })
    .returning();
  return principal;
}

async function bindCard(
  app: ReturnType<typeof createApp>["app"],
  taskId: string,
  userId: string,
) {
  const principal = await seedPrincipal(userId);
  // SPEC-2026-11-25 D3: the session must have presence before a web bind.
  await seedSessionPresence({
    userId,
    sessionId: "pi-session-a",
    agentPrincipalId: principal.id,
  });
  const response = await app.request("/api/agent-session/bindings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId,
      agentPrincipalId: principal.id,
      sessionId: "pi-session-a",
      // The server must ignore client host metadata and derive it from the
      // active owned principal row.
      hostId: "attacker-controlled-host",
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
    hostId: string;
  };
}

describe("API integration: agent session card binding (SPEC T4)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("requires effective task:update permission, not membership alone", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Permission-gated card",
        status: "to-do",
        number: null,
      })
      .returning();
    const viewer = await createWorkspaceMember({ role: "viewer" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: admin.workspace.id,
      userId: viewer.user.id,
      role: "viewer",
      joinedAt: new Date(),
    });
    const principal = await seedPrincipal(viewer.user.id);

    mockAuthenticatedSession(viewer.user);
    const { app } = createApp();
    const response = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: task.id,
        agentPrincipalId: principal.id,
        sessionId: "pi-viewer-session",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("binds, shows, heartbeats, and unbinds one session to one card", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Bound card",
        status: "to-do",
        number: null,
      })
      .returning();

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const bound = await bindCard(app, task.id, admin.user.id);
    expect(bound.hostId).toBe("test-host");
    expect(bound.bindingGeneration).toBe(1);

    const show = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}?sessionId=pi-session-a&generation=1`,
    );
    expect(show.status).toBe(200);

    const inbox = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}/inbox?sessionId=pi-session-a&generation=1`,
    );
    expect(inbox.status).toBe(200);
    const otherSessionInbox = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}/inbox?sessionId=pi-session-b&generation=1`,
    );
    expect(otherSessionInbox.status).toBe(409);

    const heartbeat = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "pi-session-a", generation: 1 }),
      },
    );
    if (heartbeat.status !== 200) {
      throw new Error(
        `heartbeat ${heartbeat.status}: ${await heartbeat.text()}`,
      );
    }

    const ownerStatus = await app.request(
      `/api/agent-session/tasks/${task.id}/binding-status`,
    );
    expect(ownerStatus.status).toBe(200);
    const ownerStatusPayload = (await ownerStatus.json()) as Record<
      string,
      unknown
    >;
    expect(ownerStatusPayload).toEqual({
      bound: true,
      online: true,
      hostId: "test-host",
      bindingId: bound.bindingId,
      rootTaskId: task.id,
      sessionId: "pi-session-a",
      bindingGeneration: 1,
    });

    mockAnonymousSession();
    const { app: guestApp } = createApp();
    const guestStatus = await guestApp.request(
      `/api/agent-session/tasks/${task.id}/binding-status`,
    );
    expect(guestStatus.status).toBe(401);
    mockAuthenticatedSession(admin.user);

    const unbind = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}?sessionId=pi-session-a&generation=1`,
      { method: "DELETE" },
    );
    expect(unbind.status).toBe(200);

    const stale = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}?sessionId=pi-session-a&generation=1`,
    );
    expect(stale.status).toBe(409);
  });

  it("rebind stales the prior session: wrong sessionId/generation is a typed stale binding", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Rebound card",
        status: "to-do",
        number: null,
      })
      .returning();

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const first = await bindCard(app, task.id, admin.user.id);

    // A different Pi session on the same API key cannot act on the binding.
    const wrongSession = await app.request(
      `/api/agent-session/bindings/${first.bindingId}?sessionId=pi-session-b&generation=1`,
    );
    expect(wrongSession.status).toBe(409);

    const rebound = await bindCard(app, task.id, admin.user.id);
    expect(rebound.bindingId).not.toBe(first.bindingId);
    expect(rebound.bindingGeneration).toBe(2);

    const oldSession = await app.request(
      `/api/agent-session/bindings/${first.bindingId}?sessionId=pi-session-a&generation=1`,
    );
    if (oldSession.status !== 409) {
      throw new Error(
        `old session ${oldSession.status}: ${await oldSession.text()}`,
      );
    }
  });

  it("task deletion turns every later scoped call into typed stale-binding", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Deleted bound card",
        status: "to-do",
        number: null,
      })
      .returning();

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const binding = await bindCard(app, task.id, admin.user.id);
    await db.delete(schema.taskTable).where(eq(schema.taskTable.id, task.id));

    const response = await app.request("/api/agent-session/card/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bindingId: binding.bindingId,
        sessionId: "pi-session-a",
        generation: binding.bindingGeneration,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stale_binding" });
  });

  it("one exact Pi session cannot remain bound to two cards", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [firstTask, secondTask] = await db
      .insert(schema.taskTable)
      .values([
        {
          projectId: project.id,
          title: "First bound card",
          status: "to-do",
          number: null,
        },
        {
          projectId: project.id,
          title: "Second bound card",
          status: "to-do",
          number: null,
        },
      ])
      .returning();

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const first = await bindCard(app, firstTask.id, admin.user.id);
    const secondPrincipal = await seedPrincipal(admin.user.id);
    const response = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: secondTask.id,
        agentPrincipalId: secondPrincipal.id,
        sessionId: "pi-session-a",
      }),
    });
    expect(response.status).toBe(200);
    const second = (await response.json()) as { bindingId: string };
    expect(second.bindingId).not.toBe(first.bindingId);

    const oldBinding = await app.request(
      `/api/agent-session/bindings/${first.bindingId}?sessionId=pi-session-a&generation=1`,
    );
    expect(oldBinding.status).toBe(409);
    const activeBindings = await db
      .select()
      .from(schema.agentSessionBindingTable)
      .where(eq(schema.agentSessionBindingTable.status, "active"));
    expect(activeBindings).toHaveLength(1);
    expect(activeBindings[0]?.taskId).toBe(secondTask.id);
    expect(activeBindings[0]?.sessionId).toBe("pi-session-a");
  });

  it("card reads are root-only and updates CAS on contentRevision", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Root",
        status: "to-do",
        number: null,
      })
      .returning();

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const bound = await bindCard(app, task.id, admin.user.id);
    const ctx = {
      bindingId: bound.bindingId,
      sessionId: "pi-session-a",
      generation: 1,
    };

    const got = await app.request("/api/agent-session/card/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ctx),
    });
    expect(got.status).toBe(200);
    const payload = (await got.json()) as {
      card: { title: string; contentRevision: number };
    };
    expect(payload.card.title).toBe("Root");
    expect(payload.card.contentRevision).toBe(1);

    const staleWrite = await app.request("/api/agent-session/card/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...ctx,
        patch: { title: "Stale" },
        expectedContentRevision: 99,
      }),
    });
    expect(staleWrite.status).toBe(409);

    const okWrite = await app.request("/api/agent-session/card/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...ctx,
        patch: { title: "Fresh title" },
        expectedContentRevision: 1,
      }),
    });
    expect(okWrite.status).toBe(200);
    const written = (await okWrite.json()) as { contentRevision: number };
    expect(written.contentRevision).toBe(2);
  });

  it("card tools create/update descendants, comments, markers, and preserve content CAS", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [root] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Tool matrix root",
        status: "to-do",
        number: null,
      })
      .returning();

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const binding = await bindCard(app, root.id, admin.user.id);
    const ctx = {
      bindingId: binding.bindingId,
      sessionId: "pi-session-a",
      generation: binding.bindingGeneration,
    };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for (const type of [
      "task.updated",
      "task.created",
      "task-relation.created",
      "comment.created",
    ]) {
      await subscribeToEvent(type, async (data) => {
        events.push({ type, data: data as Record<string, unknown> });
      });
    }

    const rootUpdate = await app.request("/api/agent-session/card/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...ctx,
        patch: { title: "Updated by bound agent" },
        expectedContentRevision: 1,
      }),
    });
    expect(rootUpdate.status).toBe(200);
    expect(events).toContainEqual({
      type: "task.updated",
      data: expect.objectContaining({ taskId: root.id, projectId: project.id }),
    });

    const created = await app.request("/api/agent-session/card/subtasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...ctx,
        title: "Created through card tool",
        expectedParentContentRevision: 2,
      }),
    });
    expect(created.status).toBe(200);
    const createBody = (await created.json()) as {
      subtask: { id: string; contentRevision: number };
      parentContentRevision: number;
    };
    expect(createBody.subtask.contentRevision).toBe(1);
    expect(createBody.parentContentRevision).toBe(3);
    expect(events).toContainEqual({
      type: "task.created",
      data: expect.objectContaining({
        taskId: createBody.subtask.id,
        projectId: project.id,
      }),
    });
    expect(events).toContainEqual({
      type: "task-relation.created",
      data: expect.objectContaining({
        taskId: root.id,
        sourceTaskId: root.id,
        targetTaskId: createBody.subtask.id,
        projectId: project.id,
      }),
    });

    const updated = await app.request(
      `/api/agent-session/card/subtasks/${createBody.subtask.id}/update`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...ctx,
          patch: { title: "Updated through card tool" },
          expectedContentRevision: 1,
        }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      title: "Updated through card tool",
      contentRevision: 2,
    });
    expect(events).toContainEqual({
      type: "task.updated",
      data: expect.objectContaining({
        taskId: createBody.subtask.id,
        projectId: project.id,
      }),
    });

    const comment = await app.request(
      "/api/agent-session/card/comments/create",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...ctx, content: "Bound-session comment" }),
      },
    );
    expect(comment.status).toBe(200);
    const commentBody = (await comment.json()) as { id: string };
    expect(events).toContainEqual({
      type: "comment.created",
      data: expect.objectContaining({ taskId: root.id, projectId: project.id }),
    });

    const comments = await app.request("/api/agent-session/card/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ctx, limit: 10 }),
    });
    expect(comments.status).toBe(200);
    expect(await comments.json()).toMatchObject({
      items: [
        expect.objectContaining({
          id: commentBody.id,
          content: "Bound-session comment",
        }),
      ],
      nextCursor: null,
    });

    const markers = await app.request("/api/agent-session/card/work-markers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...ctx,
        workMarkerCounts: {
          redCross: 1,
          boxedRedCross: 0,
          redCircle: 0,
          greenCheck: 0,
        },
        expectedContentRevision: 3,
      }),
    });
    expect(markers.status).toBe(200);
    expect(await markers.json()).toMatchObject({
      workMarkerCounts: {
        redCross: 1,
        boxedRedCross: 0,
        redCircle: 0,
        greenCheck: 0,
      },
      contentRevision: 4,
    });
    expect(events).toContainEqual({
      type: "task.updated",
      data: expect.objectContaining({ taskId: root.id, projectId: project.id }),
    });
  });

  it("subtask delete only accepts descendants of the bound root", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const { project: otherProject } = await createProjectFixture({
      workspaceId: admin.workspace.id,
      name: "Other project",
    });
    const [root] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Parent",
        status: "to-do",
        number: null,
      })
      .returning();
    const [child] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Child",
        status: "to-do",
        number: null,
      })
      .returning();
    const [foreign] = await db
      .insert(schema.taskTable)
      .values({
        projectId: otherProject.id,
        title: "Out of tree",
        status: "to-do",
        number: null,
      })
      .returning();
    const [related] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Related outside the subtask tree",
        status: "to-do",
        number: null,
      })
      .returning();
    await db.insert(schema.taskRelationTable).values([
      {
        sourceTaskId: root.id,
        targetTaskId: child.id,
        relationType: "subtask",
        position: 0,
      },
      {
        sourceTaskId: child.id,
        targetTaskId: related.id,
        relationType: "blocks",
        position: 0,
      },
    ]);

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const bound = await bindCard(app, root.id, admin.user.id);
    const ctx = {
      bindingId: bound.bindingId,
      sessionId: "pi-session-a",
      generation: 1,
    };
    const deleteEvents: Array<{ type: string; data: Record<string, unknown> }> =
      [];
    for (const type of ["task.deleted", "task-relation.deleted"]) {
      await subscribeToEvent(type, async (data) => {
        deleteEvents.push({ type, data: data as Record<string, unknown> });
      });
    }

    // The root binding owns its whole live subtree; no second session may
    // bind directly to a descendant and race the root writer.
    const overlappingPrincipal = await seedPrincipal(admin.user.id);
    await seedSessionPresence({
      userId: admin.user.id,
      sessionId: "pi-session-child",
      agentPrincipalId: overlappingPrincipal.id,
    });
    const overlappingBind = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: child.id,
        agentPrincipalId: overlappingPrincipal.id,
        sessionId: "pi-session-child",
      }),
    });
    expect(overlappingBind.status).toBe(409);

    // Out-of-tree id fails closed with the generic 404 shape.
    const foreignDelete = await app.request(
      `/api/agent-session/card/subtasks/${foreign.id}/delete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...ctx,
          expectedParentContentRevision: 1,
        }),
      },
    );
    expect(foreignDelete.status).toBe(404);

    // The root itself cannot be deleted through the binding.
    const rootDelete = await app.request(
      `/api/agent-session/card/subtasks/${root.id}/delete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...ctx,
          expectedParentContentRevision: 1,
        }),
      },
    );
    expect(rootDelete.status).toBe(400);

    // Descendant delete advances the parent contentRevision.
    const deleteChild = await app.request(
      `/api/agent-session/card/subtasks/${child.id}/delete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...ctx,
          expectedParentContentRevision: 1,
        }),
      },
    );
    expect(deleteChild.status).toBe(200);
    const result = (await deleteChild.json()) as {
      parentContentRevision: number;
    };
    expect(result.parentContentRevision).toBe(2);
    expect(deleteEvents).toContainEqual({
      type: "task.deleted",
      data: expect.objectContaining({
        taskId: child.id,
        projectId: project.id,
      }),
    });
    expect(deleteEvents).toContainEqual({
      type: "task-relation.deleted",
      data: expect.objectContaining({
        taskId: root.id,
        sourceTaskId: root.id,
        targetTaskId: child.id,
        relationType: "subtask",
        projectId: project.id,
      }),
    });
    expect(deleteEvents).toContainEqual({
      type: "task-relation.deleted",
      data: expect.objectContaining({
        sourceTaskId: child.id,
        targetTaskId: related.id,
        relationType: "blocks",
        projectId: project.id,
      }),
    });
    const [gone] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, child.id));
    expect(gone).toBeUndefined();
  });

  it("a live formal run rejects a new bind, and claiming the run fences the active binding", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Run card",
        status: "to-do",
        number: null,
      })
      .returning();

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const bound = await bindCard(app, task.id, admin.user.id);

    // A queued formal run is "live" for new binds.
    const principalAdmin = await seedPrincipal(admin.user.id);
    const liveRun = await db
      .insert(schema.taskRunTable)
      .values({
        taskId: task.id,
        manifestVersion: 1,
        protocolVersion: 1,
        repositoryOwner: "owner",
        repositoryName: "repo",
        baseBranch: "main",
        state: "queued",
        hostId: "test-host",
        branchName: "test-branch",
        scope: [],
        requestKey: "live-run-key",
        requestHash: "live-run-hash",
        leaseTokenHash: "live-lease-hash",
        leaseExpiresAt: new Date(Date.now() + 3_600_000),
        agentPrincipalId: principalAdmin.id,
      })
      .returning({ id: schema.taskRunTable.id });
    const livePrincipal = await seedPrincipal(admin.user.id);
    await seedSessionPresence({
      userId: admin.user.id,
      sessionId: "pi-session-z",
      agentPrincipalId: livePrincipal.id,
    });
    const bindDuringRun = await app.request("/api/agent-session/bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: task.id,
        agentPrincipalId: livePrincipal.id,
        sessionId: "pi-session-z",
      }),
    });
    expect(bindDuringRun.status).toBe(409);

    // Remove the synthetic queued row, then use the REAL formal-run claim
    // endpoint. Its transaction must revoke the active ad-hoc binding.
    await db
      .delete(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, liveRun[0]!.id));
    await db.insert(schema.executionManifestTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      verificationProfile: "binding-claim-test",
      allowedAgentIds: [principalAdmin.id],
    });
    await db.insert(schema.githubIntegrationTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      isActive: true,
    });

    mockAuthenticatedSessions(admin.user, {
      "claim-binding-token": admin.user,
    });
    const claim = await app.request(
      `/api/execution/task/${task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer claim-binding-token",
          "content-type": "application/json",
          "idempotency-key": "claim-fence-1",
        },
        body: JSON.stringify({
          agentPrincipalId: principalAdmin.id,
          scope: ["README.md"],
        }),
      },
    );
    if (claim.status !== 201) {
      throw new Error(`formal claim ${claim.status}: ${await claim.text()}`);
    }
    const stale = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}?sessionId=pi-session-a&generation=1`,
    );
    expect(stale.status).toBe(409);
  });

  it("claiming a descendant fences the binding rooted at an ancestor", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const [parent] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Parent card",
        status: "to-do",
        number: null,
      })
      .returning();
    const [child] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Child card",
        status: "to-do",
        number: null,
      })
      .returning();
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: parent.id,
      targetTaskId: child.id,
      relationType: "subtask",
    });

    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const bound = await bindCard(app, parent.id, admin.user.id);

    const principalAdmin = await seedPrincipal(admin.user.id);
    await db.insert(schema.executionManifestTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      verificationProfile: "descendant-claim-test",
      allowedAgentIds: [principalAdmin.id],
    });
    await db.insert(schema.githubIntegrationTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repo",
      isActive: true,
    });

    mockAuthenticatedSessions(admin.user, {
      "claim-descendant-token": admin.user,
    });
    const claim = await app.request(
      `/api/execution/task/${child.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer claim-descendant-token",
          "content-type": "application/json",
          "idempotency-key": "claim-fence-descendant-1",
        },
        body: JSON.stringify({
          agentPrincipalId: principalAdmin.id,
          scope: ["README.md"],
        }),
      },
    );
    if (claim.status !== 201) {
      throw new Error(`formal claim ${claim.status}: ${await claim.text()}`);
    }

    // The binding lives on the ancestor, not the claimed task; the fence
    // must still revoke it, or a zombie binding stays bound/online while
    // blocking every later rebind through the overlap guard.
    const [binding] = await db
      .select()
      .from(schema.agentSessionBindingTable)
      .where(eq(schema.agentSessionBindingTable.id, bound.bindingId));
    expect(binding.status).toBe("revoked");
    expect(binding.revokedReason).toBe("formal_run_claim");
    expect(binding.bindingGeneration).toBe(bound.bindingGeneration + 1);
    const stale = await app.request(
      `/api/agent-session/bindings/${bound.bindingId}?sessionId=pi-session-a&generation=${bound.bindingGeneration}`,
    );
    expect(stale.status).toBe(409);
  });
});
