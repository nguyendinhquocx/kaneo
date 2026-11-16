import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture, createWorkspaceMember } from "./helpers/fixtures";

async function insertTask(
  projectId: string,
  columnId: string,
  title: string,
  position: number,
  status = "to-do",
) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title,
      number: position + 1,
      status,
      columnId,
      priority: "no-priority",
      position,
    })
    .returning();
  if (!task) throw new Error(`Failed to create task ${title}`);
  return task;
}

async function loadTask(taskId: string) {
  const [task] = await db
    .select()
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, taskId))
    .limit(1);
  if (!task) throw new Error(`Task ${taskId} missing`);
  return task;
}

// SPEC-2026-11-10 R4: one batch request per board drag. The endpoint must
// persist many status/position deltas in a single transaction (pool pressure),
// reject tasks outside the project, bump CAS tokens for written cards, and
// stay write-gated behind workspace permissions.
describe("API integration: batch task reorder", () => {
  it("persists status and position deltas in one request and bumps revisions", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const first = await insertTask(project.id, columns.todo.id, "First", 0);
    const second = await insertTask(project.id, columns.todo.id, "Second", 1);
    const third = await insertTask(project.id, columns.todo.id, "Third", 2);
    const revisionsBefore = new Map(
      await Promise.all(
        [first, second, third].map(async (task) => [
          task.id,
          (await loadTask(task.id)).contentRevision,
        ]),
      ),
    );

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(
      `/api/task/reorder/${project.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tasks: [
            { id: first.id, status: "in-progress", position: 0 },
            { id: second.id, status: "to-do", position: 0 },
            { id: third.id, status: "to-do", position: 1 },
          ],
        }),
      },
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      updated: Array<{ id: string; status: string; position: number; contentRevision: number }>;
    };
    expect(payload.updated).toHaveLength(3);
    const byId = new Map(payload.updated.map((task) => [task.id, task]));
    expect(byId.get(first.id)?.status).toBe("in-progress");
    expect(byId.get(first.id)?.position).toBe(0);
    expect(byId.get(second.id)?.position).toBe(0);
    expect(byId.get(third.id)?.position).toBe(1);

    const storedFirst = await loadTask(first.id);
    expect(storedFirst.status).toBe("in-progress");
    expect(storedFirst.position).toBe(0);
    expect(storedFirst.contentRevision).toBeGreaterThan(
      revisionsBefore.get(first.id) ?? 0,
    );
    const storedSecond = await loadTask(second.id);
    expect(storedSecond.position).toBe(0);
    expect(storedSecond.contentRevision).toBeGreaterThan(
      revisionsBefore.get(second.id) ?? 0,
    );
  });

  it("rejects deltas that reference tasks outside the project", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: otherProject, columns: otherColumns } =
      await createProjectFixture({ workspaceId: member.workspace.id });
    const local = await insertTask(project.id, columns.todo.id, "Local", 0);
    const foreign = await insertTask(
      otherProject.id,
      otherColumns.todo.id,
      "Foreign",
      0,
    );

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(`/api/task/reorder/${project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { id: local.id, status: "to-do", position: 0 },
          { id: foreign.id, status: "to-do", position: 5 },
        ],
      }),
    });
    expect(response.status).toBe(400);
    const stored = await loadTask(local.id);
    expect(stored.position).toBe(0);
  });

  it("rejects statuses that do not belong to the project workflow", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const task = await insertTask(project.id, columns.todo.id, "Solo", 0);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(`/api/task/reorder/${project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [{ id: task.id, status: "not-a-column", position: 0 }],
      }),
    });
    expect(response.status).toBe(400);
  });
});
