import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function insertTask(
  projectId: string,
  columnId: string,
  title: string,
  position: number,
) {
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title,
      number: position + 1,
      status: "to-do",
      columnId,
      priority: "no-priority",
      position,
    })
    .returning();
  if (!task) throw new Error(`Failed to create task ${title}`);
  return task;
}

describe("API integration: subtask order", () => {
  it("persists relation order and synchronizes sibling card order in the lane", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const parent = await insertTask(project.id, columns.todo.id, "Parent", 0);
    const first = await insertTask(project.id, columns.todo.id, "First", 1);
    const second = await insertTask(project.id, columns.todo.id, "Second", 2);
    const third = await insertTask(project.id, columns.todo.id, "Third", 3);

    await db.insert(schema.taskRelationTable).values([
      {
        sourceTaskId: parent.id,
        targetTaskId: first.id,
        relationType: "subtask",
        position: 0,
      },
      {
        sourceTaskId: parent.id,
        targetTaskId: second.id,
        relationType: "subtask",
        position: 1,
      },
      {
        sourceTaskId: parent.id,
        targetTaskId: third.id,
        relationType: "subtask",
        position: 2,
      },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(
      `/api/task-relation/subtasks/${parent.id}/order`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderedTargetTaskIds: [second.id, first.id, third.id],
        }),
      },
    );
    expect(response.status).toBe(200);
    const relations = (await response.json()) as Array<{
      targetTaskId: string;
      position: number;
    }>;
    expect(
      relations
        .filter((relation) => relation.targetTaskId !== parent.id)
        .map((relation) => [relation.targetTaskId, relation.position]),
    ).toEqual([
      [second.id, 0],
      [first.id, 1],
      [third.id, 2],
    ]);

    const cards = await db
      .select({ id: schema.taskTable.id, position: schema.taskTable.position })
      .from(schema.taskTable)
      .where(
        and(
          eq(schema.taskTable.projectId, project.id),
          eq(schema.taskTable.columnId, columns.todo.id),
        ),
      )
      .orderBy(asc(schema.taskTable.position));
    const cardIds = cards.map((task) => task.id);
    expect(cardIds.indexOf(second.id)).toBeLessThan(cardIds.indexOf(first.id));
    expect(cardIds.indexOf(first.id)).toBeLessThan(cardIds.indexOf(third.id));
  });

  it("rejects stale child lists and duplicate target IDs", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const parent = await insertTask(project.id, columns.todo.id, "Parent", 0);
    const child = await insertTask(project.id, columns.todo.id, "Child", 1);
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: parent.id,
      targetTaskId: child.id,
      relationType: "subtask",
      position: 0,
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const duplicate = await app.request(
      `/api/task-relation/subtasks/${parent.id}/order`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderedTargetTaskIds: [child.id, child.id] }),
      },
    );
    expect(duplicate.status).toBe(400);

    const stale = await app.request(
      `/api/task-relation/subtasks/${parent.id}/order`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderedTargetTaskIds: ["not-a-child"] }),
      },
    );
    expect(stale.status).toBe(409);
  });
});
