// SPEC-2026-11-28 deadlock regression: parallel binding-scope writes used to
// deadlock on the tuple locks taken by lockBindingScope (SELECT ... FOR UPDATE
// cannot guarantee acquisition order even with ORDER BY). 11 deadlocks in 48h
// on production, all from concurrent agent waves commenting/updating the same
// subtree. The fix serializes same-scope writes behind one advisory xact lock.
// This test fires many concurrent scope writes at one subtree and requires
// every request to succeed (no 500 / 40P01 leakage).
import { beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
  seedSessionPresence,
} from "./helpers/fixtures";

const SESSION_ID = "pi-scope-lock-session";

async function bindCard(
  app: ReturnType<typeof createApp>["app"],
  taskId: string,
  userId: string,
) {
  const [principal] = await db
    .insert(schema.agentPrincipalTable)
    .values({
      userId,
      runtimeId: `pi-scope-lock-${Math.random().toString(36).slice(2, 8)}`,
      hostId: "test-host",
      scopes: ["run:claim"],
      isActive: true,
    })
    .returning();
  if (!principal) throw new Error("Principal fixture failed to create");
  await seedSessionPresence({
    userId,
    sessionId: SESSION_ID,
    agentPrincipalId: principal.id,
  });
  const response = await app.request("/api/agent-session/bindings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId,
      agentPrincipalId: principal.id,
      sessionId: SESSION_ID,
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

async function seedSubtree(projectId: string) {
  const [root] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title: "Scope lock root",
      status: "to-do",
      number: null,
    })
    .returning();
  if (!root) throw new Error("Root fixture failed to create");
  const children = await db
    .insert(schema.taskTable)
    .values(
      Array.from({ length: 5 }, (_, index) => ({
        projectId,
        title: `Scope lock child ${index}`,
        status: "to-do",
        number: null,
      })),
    )
    .returning();
  await db.insert(schema.taskRelationTable).values(
    children.map((child) => ({
      sourceTaskId: root.id,
      targetTaskId: child.id,
      relationType: "subtask",
    })),
  );
  return { root, children };
}

describe("API integration: binding-scope lock under concurrent writes", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("survives a parallel comment burst on one subtree", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const { root, children } = await seedSubtree(project.id);
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const binding = await bindCard(app, root.id, admin.user.id);
    const body = {
      bindingId: binding.bindingId,
      sessionId: SESSION_ID,
      generation: binding.bindingGeneration,
    };

    // 12 concurrent root comments + 5 concurrent subtask comments, all on the
    // same subtree — the exact shape that deadlocked in production.
    const requests = [
      ...Array.from({ length: 12 }, (_, index) =>
        app.request("/api/agent-session/card/comments/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, content: `burst root ${index}` }),
        }),
      ),
      ...children.map((child, index) =>
        app.request(
          `/api/agent-session/card/subtasks/${child.id}/comments/create`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              bindingId: binding.bindingId,
              sessionId: SESSION_ID,
              generation: binding.bindingGeneration,
              content: `burst child ${index}`,
            }),
          },
        ),
      ),
    ];
    const settled = await Promise.all(requests.map((r) => r.then((res) => res.status)));
    const failures = settled.filter((status) => status !== 200);
    expect(failures).toEqual([]);

    const persisted = await db
      .select({ id: schema.activityTable.id })
      .from(schema.activityTable)
      .where(eq(schema.activityTable.taskId, root.id));
    expect(persisted.length).toBe(12);
  });
});
