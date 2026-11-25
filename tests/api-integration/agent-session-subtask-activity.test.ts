import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
  seedSessionPresence,
} from "./helpers/fixtures";

type BindingContext = {
  bindingId: string;
  sessionId: string;
  generation: number;
};

type TaskRow = typeof schema.taskTable.$inferSelect;

type BoundSubtaskFixture = {
  app: ReturnType<typeof createApp>["app"];
  admin: Awaited<ReturnType<typeof createWorkspaceMember>>;
  project: Awaited<ReturnType<typeof createProjectFixture>>["project"];
  root: TaskRow;
  child: { id: string; contentRevision: number };
  relationId: string;
  context: BindingContext;
};

async function seedTask(
  projectId: string,
  title: string,
  description?: string,
) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title,
      description,
      status: "to-do",
      priority: "medium",
      number: null,
    })
    .returning();
  if (!task) throw new Error("Task fixture failed to create");
  return task;
}

async function seedApiKey(userId: string) {
  const rawKey = `subtask-activity-${randomUUID()}`;
  const key = createHash("sha256")
    .update(rawKey)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const now = new Date();
  await db.insert(schema.apikeyTable).values({
    referenceId: userId,
    userId,
    key,
    name: "Subtask activity integration test",
    start: rawKey.slice(0, 12),
    prefix: "kaneo",
    createdAt: now,
    updatedAt: now,
    permissions: JSON.stringify({
      task: ["read", "update"],
      execution: ["run:claim"],
    }),
  });
  return rawKey;
}

async function setupBoundSubtask(
  childDescription = "Child description",
): Promise<BoundSubtaskFixture> {
  const admin = await createWorkspaceMember({ role: "admin" });
  const { project } = await createProjectFixture({
    workspaceId: admin.workspace.id,
  });
  const root = await seedTask(project.id, "Bound parent");
  mockAuthenticatedSession(admin.user);
  const { app } = createApp();

  const principalRuntimeId = `pi-child-activity-${randomUUID()}`;
  const [principal] = await db
    .insert(schema.agentPrincipalTable)
    .values({
      userId: admin.user.id,
      runtimeId: principalRuntimeId,
      hostId: "test-host",
      scopes: ["run:claim"],
      isActive: true,
    })
    .returning();
  if (!principal) throw new Error("Principal fixture failed to create");

  const sessionId = `pi-child-activity-session-${randomUUID()}`;
  // SPEC-2026-11-25 D3: presence required before a web bind.
  await seedSessionPresence({
    userId: admin.user.id,
    sessionId,
    agentPrincipalId: principal.id,
  });
  const bind = await app.request("/api/agent-session/bindings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId: root.id,
      agentPrincipalId: principal.id,
      sessionId,
    }),
  });
  expect(bind.status).toBe(200);
  const binding = (await bind.json()) as {
    bindingId: string;
    bindingGeneration: number;
  };
  const context = {
    bindingId: binding.bindingId,
    sessionId,
    generation: binding.bindingGeneration,
  };

  const create = await app.request("/api/agent-session/card/subtasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...context,
      title: "Bound child",
      description: childDescription,
      expectedParentContentRevision: root.contentRevision,
    }),
  });
  expect(create.status).toBe(200);
  const created = (await create.json()) as {
    subtask: { id: string; contentRevision: number };
    relationId: string;
  };

  return {
    app,
    admin,
    project,
    root,
    child: created.subtask,
    relationId: created.relationId,
    context,
  };
}

async function createCommentRow(
  taskId: string,
  userId: string,
  content: string,
  externalSource: string | null = null,
) {
  const [comment] = await db
    .insert(schema.activityTable)
    .values({
      taskId,
      type: "comment",
      userId,
      content,
      externalSource,
    })
    .returning();
  if (!comment) throw new Error("Comment fixture failed to create");
  return comment;
}

async function queueComment(fixture: BoundSubtaskFixture, commentId: string) {
  return fixture.app.request(
    `/api/agent-session/bindings/${fixture.context.bindingId}/deliveries`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: fixture.context.sessionId,
        generation: fixture.context.generation,
        commentId,
        clientActionKey: randomUUID(),
      }),
    },
  );
}

async function claimNext(fixture: BoundSubtaskFixture) {
  const key = await seedApiKey(fixture.admin.user.id);
  const { context } = fixture;
  return fixture.app.request(
    `/api/agent-session/bindings/${context.bindingId}/deliveries/claim` +
      `?sessionId=${encodeURIComponent(context.sessionId)}` +
      `&generation=${context.generation}&waitMs=0`,
    { headers: { authorization: `Bearer ${key}` } },
  );
}

function postSubtaskTool(
  fixture: BoundSubtaskFixture,
  subtaskId: string,
  action: "get" | "comments" | "comments/create",
  payload: Record<string, unknown> = {},
  context = fixture.context,
) {
  return fixture.app.request(
    `/api/agent-session/card/subtasks/${subtaskId}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...context, ...payload }),
    },
  );
}

describe("API integration: bound child Activity and comment delivery", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("reads only the bound child's detail and its direct-child summary", async () => {
    const fixture = await setupBoundSubtask();
    const grandchild = await seedTask(
      fixture.project.id,
      "Grandchild summary",
      "Do not return this description at the child-summary level",
    );
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: fixture.child.id,
      targetTaskId: grandchild.id,
      relationType: "subtask",
      position: 0,
    });

    const response = await postSubtaskTool(fixture, fixture.child.id, "get");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subtask: {
        id: fixture.child.id,
        title: "Bound child",
        description: "Child description",
        status: "to-do",
        contentRevision: fixture.child.contentRevision,
      },
      subtasks: [
        {
          id: grandchild.id,
          title: "Grandchild summary",
          status: "to-do",
        },
      ],
      subtaskCount: 1,
    });
  });

  it("lists only child comments and clamps pagination without crashing on a bad cursor", async () => {
    const fixture = await setupBoundSubtask();
    await db.insert(schema.activityTable).values([
      ...Array.from({ length: 53 }, (_, index) => ({
        taskId: fixture.child.id,
        type: "comment",
        userId: fixture.admin.user.id,
        content: `child comment ${index}`,
      })),
      {
        taskId: fixture.child.id,
        type: "status-changed",
        userId: fixture.admin.user.id,
        content: "system event is not a comment",
      },
      {
        taskId: fixture.root.id,
        type: "comment",
        userId: fixture.admin.user.id,
        content: "parent comment must not leak into child list",
      },
    ]);

    const maximum = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "comments",
      { limit: 100 },
    );
    expect(maximum.status).toBe(200);
    const firstPage = (await maximum.json()) as {
      items: Array<{ id: string; content: string }>;
      nextCursor: string | null;
    };
    expect(firstPage.items).toHaveLength(50);
    const nextCursor = firstPage.nextCursor;
    expect(nextCursor).toBeTruthy();
    if (!nextCursor) throw new Error("Expected a next-page cursor");
    expect(
      firstPage.items.every((item) =>
        item.content.startsWith("child comment "),
      ),
    ).toBe(true);

    const second = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "comments",
      { limit: 50, cursor: nextCursor },
    );
    expect(second.status).toBe(200);
    const secondPage = (await second.json()) as {
      items: Array<{ id: string; content: string }>;
      nextCursor: string | null;
    };
    expect(secondPage.items).toHaveLength(3);
    expect(
      secondPage.items.some((item) =>
        firstPage.items.some((first) => first.id === item.id),
      ),
    ).toBe(false);
    expect(
      secondPage.items.every((item) =>
        item.content.startsWith("child comment "),
      ),
    ).toBe(true);

    const zero = await postSubtaskTool(fixture, fixture.child.id, "comments", {
      limit: 0,
    });
    expect(zero.status).toBe(200);
    expect((await zero.json()).items).toHaveLength(1);

    const negative = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "comments",
      { limit: -5 },
    );
    expect(negative.status).toBe(200);
    expect((await negative.json()).items).toHaveLength(1);

    const invalidCursor = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "comments",
      { limit: 3, cursor: "not-a-valid-cursor" },
    );
    expect(invalidCursor.status).toBe(200);
    expect((await invalidCursor.json()).items).toHaveLength(3);

    const outOfRangeCursor = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "comments",
      { limit: 3, cursor: "9223372036854775808|out-of-range" },
    );
    expect(outOfRangeCursor.status).toBe(200);
    expect((await outOfRangeCursor.json()).items).toHaveLength(3);

    const legacyCreatedAt = new Date("2025-01-01T00:00:00.000Z");
    const legacyComments = await db
      .insert(schema.activityTable)
      .values([
        {
          taskId: fixture.child.id,
          type: "comment",
          userId: fixture.admin.user.id,
          content: "legacy cursor first",
          createdAt: legacyCreatedAt,
        },
        {
          taskId: fixture.child.id,
          type: "comment",
          userId: fixture.admin.user.id,
          content: "legacy cursor next",
          createdAt: legacyCreatedAt,
        },
      ])
      .returning({ id: schema.activityTable.id });
    const legacyOrdered = [...legacyComments].sort((a, b) =>
      b.id.localeCompare(a.id),
    );
    const legacyCursorRow = legacyOrdered[0];
    const legacyNextRow = legacyOrdered[1];
    if (!legacyCursorRow || !legacyNextRow) {
      throw new Error("Legacy cursor fixtures failed to create");
    }
    const legacyPage = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "comments",
      {
        limit: 10,
        cursor: `${legacyCreatedAt.toISOString()}|${legacyCursorRow.id}`,
      },
    );
    expect(legacyPage.status).toBe(200);
    const legacyPayload = (await legacyPage.json()) as {
      items: Array<{ id: string }>;
    };
    expect(legacyPayload.items.map((item) => item.id)).toEqual([
      legacyNextRow.id,
    ]);
  });

  it("rejects root, out-of-tree, and cross-project IDs on all child endpoints", async () => {
    const fixture = await setupBoundSubtask();
    const outOfTree = await seedTask(
      fixture.project.id,
      "Outside this binding",
    );
    const otherProject = await createProjectFixture({
      workspaceId: fixture.admin.workspace.id,
    });
    const crossProject = await seedTask(
      otherProject.project.id,
      "Other project task",
    );
    const targets = [
      { id: fixture.root.id, expectedStatus: 400 },
      { id: outOfTree.id, expectedStatus: 404 },
      { id: crossProject.id, expectedStatus: 404 },
    ];

    for (const target of targets) {
      const read = await postSubtaskTool(fixture, target.id, "get");
      const list = await postSubtaskTool(fixture, target.id, "comments");
      const create = await postSubtaskTool(
        fixture,
        target.id,
        "comments/create",
        { content: "Must not write outside a child" },
      );
      expect(read.status).toBe(target.expectedStatus);
      expect(list.status).toBe(target.expectedStatus);
      expect(create.status).toBe(target.expectedStatus);
    }
  });

  it("rejects stale generations on each new child tool", async () => {
    const fixture = await setupBoundSubtask();
    const staleContext = {
      ...fixture.context,
      generation: fixture.context.generation + 1,
    };

    const read = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "get",
      {},
      staleContext,
    );
    const list = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "comments",
      {},
      staleContext,
    );
    const create = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "comments/create",
      { content: "Stale generation must not write" },
      staleContext,
    );

    expect([read.status, list.status, create.status]).toEqual([409, 409, 409]);
  });

  it("writes agent comments to the exact child and rejects sending them back to Pi", async () => {
    const fixture = await setupBoundSubtask();
    const response = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "comments/create",
      { content: "Agent note stored on the child" },
    );

    expect(response.status).toBe(200);
    const created = (await response.json()) as { id: string; content: string };
    expect(created.content).toBe("Agent note stored on the child");
    const [comment] = await db
      .select()
      .from(schema.activityTable)
      .where(eq(schema.activityTable.id, created.id));
    expect(comment).toMatchObject({
      taskId: fixture.child.id,
      type: "comment",
      externalSource: "agent-binding",
    });

    const queued = await queueComment(fixture, created.id);
    expect(queued.status).toBe(404);
  });

  it("resolves current parent/comment-task titles at claim time and filters out-of-scope attachments", async () => {
    const fixture = await setupBoundSubtask();
    const outside = await seedTask(fixture.project.id, "Unbound task");
    const [inScopeAsset] = await db
      .insert(schema.assetTable)
      .values({
        workspaceId: fixture.admin.workspace.id,
        projectId: fixture.project.id,
        taskId: fixture.child.id,
        objectKey: `workspace/${fixture.admin.workspace.id}/content/task_comment/${fixture.child.id}/in-scope-${randomUUID()}.png`,
        filename: "in-scope.png",
        mimeType: "image/png",
        size: 10,
        kind: "image",
        surface: "comment",
      })
      .returning();
    const [outsideAsset] = await db
      .insert(schema.assetTable)
      .values({
        workspaceId: fixture.admin.workspace.id,
        projectId: fixture.project.id,
        taskId: outside.id,
        objectKey: `workspace/${fixture.admin.workspace.id}/content/task_comment/${outside.id}/outside-${randomUUID()}.png`,
        filename: "outside.png",
        mimeType: "image/png",
        size: 10,
        kind: "image",
        surface: "comment",
      })
      .returning();
    if (!inScopeAsset || !outsideAsset) throw new Error("Asset fixture failed");

    const content = [inScopeAsset, outsideAsset]
      .map(
        (asset) =>
          `<kaneo-attachment url="/api/asset/${asset.id}" filename="${asset.filename}" mime-type="image/png" size="10" />`,
      )
      .join("\n");
    const comment = await createCommentRow(
      fixture.child.id,
      fixture.admin.user.id,
      `Review child files.\n${content}`,
    );
    const queued = await queueComment(fixture, comment.id);
    expect(queued.status).toBe(200);

    await db
      .update(schema.taskTable)
      .set({ title: "Parent renamed after queue" })
      .where(eq(schema.taskTable.id, fixture.root.id));
    await db
      .update(schema.taskTable)
      .set({ title: "Child renamed after queue" })
      .where(eq(schema.taskTable.id, fixture.child.id));

    const claim = await claimNext(fixture);
    expect(claim.status).toBe(200);
    const result = (await claim.json()) as {
      delivery: {
        content: string;
        attachmentAssetIds: string[];
        parentTask: { id: string; title: string };
        commentTask: { id: string; title: string };
      };
    };
    expect(result.delivery).toMatchObject({
      content: expect.stringContaining("Review child files."),
      parentTask: { id: fixture.root.id, title: "Parent renamed after queue" },
      commentTask: { id: fixture.child.id, title: "Child renamed after queue" },
    });
    expect(result.delivery.attachmentAssetIds).toEqual([inScopeAsset.id]);
    expect(result.delivery.attachmentAssetIds).not.toContain(outsideAsset.id);
  });

  it("reports a root comment as the same parent task, not as a child", async () => {
    const fixture = await setupBoundSubtask();
    const comment = await createCommentRow(
      fixture.root.id,
      fixture.admin.user.id,
      "A note directly on the bound parent",
    );
    const queued = await queueComment(fixture, comment.id);
    expect(queued.status).toBe(200);

    const claim = await claimNext(fixture);
    expect(claim.status).toBe(200);
    const result = (await claim.json()) as {
      delivery: {
        parentTask: { id: string; title: string };
        commentTask: { id: string; title: string };
      };
    };
    expect(result.delivery.parentTask).toEqual({
      id: fixture.root.id,
      title: "Bound parent",
    });
    expect(result.delivery.commentTask).toEqual(result.delivery.parentTask);
  });

  it("stales a queued child delivery when the child is deleted before claim", async () => {
    const fixture = await setupBoundSubtask();
    const comment = await createCommentRow(
      fixture.child.id,
      fixture.admin.user.id,
      "Deleted child content must not reach Pi",
    );
    const queued = await queueComment(fixture, comment.id);
    expect(queued.status).toBe(200);
    const receipt = (await queued.json()) as {
      receipt: { deliveryId: string };
    };
    const [parent] = await db
      .select({ contentRevision: schema.taskTable.contentRevision })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, fixture.root.id));
    if (!parent) throw new Error("Bound parent fixture disappeared");

    const deleted = await fixture.app.request(
      `/api/agent-session/card/subtasks/${fixture.child.id}/delete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...fixture.context,
          expectedParentContentRevision: parent.contentRevision,
        }),
      },
    );
    expect(deleted.status).toBe(200);

    const read = await postSubtaskTool(fixture, fixture.child.id, "get");
    const list = await postSubtaskTool(fixture, fixture.child.id, "comments");
    const create = await postSubtaskTool(
      fixture,
      fixture.child.id,
      "comments/create",
      { content: "Cannot recreate into a deleted child" },
    );
    expect([read.status, list.status, create.status]).toEqual([404, 404, 404]);

    const claim = await claimNext(fixture);
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual({ delivery: null });
    const status = await fixture.app.request(
      `/api/agent-session/bindings/${fixture.context.bindingId}/deliveries/${receipt.receipt.deliveryId}`,
    );
    expect(await status.json()).toMatchObject({ state: "stale" });
  });

  it("stales a queued child delivery moved outside the binding tree before claim", async () => {
    const fixture = await setupBoundSubtask();
    const newParent = await seedTask(fixture.project.id, "New parent");
    const comment = await createCommentRow(
      fixture.child.id,
      fixture.admin.user.id,
      "This must not reach Pi after the child leaves the tree",
    );
    const queued = await queueComment(fixture, comment.id);
    expect(queued.status).toBe(200);
    const receipt = (await queued.json()) as {
      receipt: { deliveryId: string };
    };

    await db
      .update(schema.taskRelationTable)
      .set({ sourceTaskId: newParent.id, position: 0 })
      .where(eq(schema.taskRelationTable.id, fixture.relationId));

    const claim = await claimNext(fixture);
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual({ delivery: null });

    const status = await fixture.app.request(
      `/api/agent-session/bindings/${fixture.context.bindingId}/deliveries/${receipt.receipt.deliveryId}`,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ state: "stale" });
  });
});
