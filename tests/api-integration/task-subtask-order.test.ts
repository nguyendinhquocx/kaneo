import { randomUUID } from "node:crypto";
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

async function insertSubtaskRelation(
  sourceTaskId: string,
  targetTaskId: string,
  position: number,
) {
  await db.insert(schema.taskRelationTable).values({
    sourceTaskId,
    targetTaskId,
    relationType: "subtask",
    position,
  });
}

function todoColumnTasks(payload: {
  data: { columns: Array<{ slug: string; tasks: Array<Record<string, unknown>> }> };
}) {
  const todo = payload.data.columns.find((column) => column.slug === "to-do");
  if (!todo) throw new Error("to-do column missing from task list payload");
  return todo.tasks;
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

describe("API integration: work markers, project default and subtask projection", () => {
  it("defaults new project rows to hidden subtask cards and exposes the flag per task row", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    expect(project.showSubtaskCardsByDefault).toBe(false);

    const parent = await insertTask(project.id, columns.todo.id, "Parent", 0);
    const child = await insertTask(project.id, columns.todo.id, "Child", 1);
    await insertSubtaskRelation(parent.id, child.id, 0);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(`/api/task/tasks/${project.id}`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: {
        showSubtaskCardsByDefault: boolean;
        columns: Array<{ slug: string; tasks: Array<Record<string, unknown>> }>;
      };
    };
    expect(payload.data.showSubtaskCardsByDefault).toBe(false);

    const tasks = todoColumnTasks(payload);
    const parentTask = tasks.find((task) => task.id === parent.id);
    const childTask = tasks.find((task) => task.id === child.id);
    expect(parentTask).toBeDefined();
    expect(childTask).toBeDefined();
    expect(parentTask?.isSubtask).toBe(false);
    expect(parentTask?.nextSubtaskPreview).toEqual({
      id: child.id,
      title: "Child",
      workMarkerCounts: {
        redCross: 0,
        boxedRedCross: 0,
        redCircle: 0,
        greenCheck: 0,
      },
    });
    expect(childTask?.isSubtask).toBe(true);
    expect(childTask?.nextSubtaskPreview).toBeNull();
    expect(childTask?.workMarkerCounts).toEqual({
      redCross: 0,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    });
  });

  it("returns the project flag true for a legacy row kept visible after upgrade", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    // Simulates the migration backfill value for pre-upgrade projects.
    await db
      .update(schema.projectTable)
      .set({ showSubtaskCardsByDefault: true })
      .where(eq(schema.projectTable.id, project.id));

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(`/api/task/tasks/${project.id}`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: { showSubtaskCardsByDefault: boolean };
    };
    expect(payload.data.showSubtaskCardsByDefault).toBe(true);
  });

  it("round-trips the full work marker map through PUT /work-markers and GET /task/:id", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const task = await insertTask(project.id, columns.todo.id, "Marked", 0);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const counts = {
      redCross: 2,
      boxedRedCross: 0,
      redCircle: 99,
      greenCheck: 3,
    };
    const put = await app.request(`/api/task/work-markers/${task.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workMarkerCounts: counts }),
    });
    expect(put.status).toBe(200);
    const updated = (await put.json()) as {
      workMarkerCounts: typeof counts;
      title: string;
      status: string;
    };
    expect(updated.workMarkerCounts).toEqual(counts);
    expect(updated.title).toBe("Marked");
    expect(updated.status).toBe("to-do");

    const detail = await app.request(`/api/task/${task.id}`);
    expect(detail.status).toBe(200);
    const detailPayload = (await detail.json()) as {
      workMarkerCounts: typeof counts;
    };
    expect(detailPayload.workMarkerCounts).toEqual(counts);
  });

  it("rejects marker payloads missing keys, out of range, decimal or unknown", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const task = await insertTask(project.id, columns.todo.id, "Guarded", 0);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const invalidPayloads: unknown[] = [
      { redCross: 1, boxedRedCross: 0, redCircle: 0 },
      { redCross: 1, boxedRedCross: 0, redCircle: 0, greenCheck: 100 },
      { redCross: -1, boxedRedCross: 0, redCircle: 0, greenCheck: 0 },
      { redCross: 1.5, boxedRedCross: 0, redCircle: 0, greenCheck: 0 },
      {
        redCross: 1,
        boxedRedCross: 0,
        redCircle: 0,
        greenCheck: 0,
        unknownKey: 2,
      },
      "not-an-object",
    ];

    for (const workMarkerCounts of invalidPayloads) {
      const response = await app.request(`/api/task/work-markers/${task.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workMarkerCounts }),
      });
      expect(response.status).toBe(400);
    }

    const detail = await app.request(`/api/task/${task.id}`);
    const payload = (await detail.json()) as {
      workMarkerCounts: { redCross: number };
    };
    expect(payload.workMarkerCounts.redCross).toBe(0);
  });

  it("refuses marker writes from users outside the task workspace", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const outsider = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const task = await insertTask(project.id, columns.todo.id, "Private", 0);

    mockAuthenticatedSession(outsider.user);
    const { app } = createApp();
    const response = await app.request(`/api/task/work-markers/${task.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workMarkerCounts: {
          redCross: 1,
          boxedRedCross: 0,
          redCircle: 0,
          greenCheck: 0,
        },
      }),
    });
    expect(response.status).toBe(403);
  });

  it("picks the first board-visible non-final child in relation order as preview", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const parent = await insertTask(project.id, columns.todo.id, "Parent", 0);
    const first = await insertTask(project.id, columns.todo.id, "First", 1);
    const second = await insertTask(project.id, columns.todo.id, "Second", 2);
    const doneChild = await insertTask(
      project.id,
      columns.done.id,
      "Finished",
      3,
      "done",
    );

    await insertSubtaskRelation(parent.id, first.id, 1);
    await insertSubtaskRelation(parent.id, second.id, 0);
    await insertSubtaskRelation(parent.id, doneChild.id, 2);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const readPreview = async () => {
      const response = await app.request(`/api/task/tasks/${project.id}`);
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        data: {
          columns: Array<{
            slug: string;
            tasks: Array<Record<string, unknown>>;
          }>;
        };
      };
      const parentTask = todoColumnTasks(payload).find(
        (task) => task.id === parent.id,
      );
      return parentTask?.nextSubtaskPreview as
        | { id: string; title: string }
        | null;
    };

    expect(await readPreview()).toEqual({
      id: second.id,
      title: "Second",
      workMarkerCounts: {
        redCross: 0,
        boxedRedCross: 0,
        redCircle: 0,
        greenCheck: 0,
      },
    });

    // Completing the current next-up child advances the preview in relation
    // order; the final-column child is never selected.
    await db
      .update(schema.taskTable)
      .set({ status: "done" })
      .where(eq(schema.taskTable.id, second.id));
    expect(await readPreview()).toEqual({
      id: first.id,
      title: "First",
      workMarkerCounts: {
        redCross: 0,
        boxedRedCross: 0,
        redCircle: 0,
        greenCheck: 0,
      },
    });

    // Completing every non-final child removes the preview row.
    await db
      .update(schema.taskTable)
      .set({ status: "done" })
      .where(eq(schema.taskTable.id, first.id));
    expect(await readPreview()).toBeNull();
  });

  it("keeps children of planned parents visible and excludes virtual children from preview", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const plannedParent = await insertTask(
      project.id,
      columns.todo.id,
      "Planned parent",
      0,
      "planned",
    );
    const boardChild = await insertTask(
      project.id,
      columns.todo.id,
      "Board child",
      1,
    );
    const plannedChild = await insertTask(
      project.id,
      columns.todo.id,
      "Planned child",
      2,
      "planned",
    );
    await insertSubtaskRelation(plannedParent.id, boardChild.id, 0);
    await insertSubtaskRelation(plannedParent.id, plannedChild.id, 1);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(`/api/task/tasks/${project.id}`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: {
        columns: Array<{ slug: string; tasks: Array<Record<string, unknown>> }>;
        plannedTasks: Array<Record<string, unknown>>;
      };
    };

    const todoTasks = todoColumnTasks(payload);
    const boardChildRow = todoTasks.find((task) => task.id === boardChild.id);
    expect(boardChildRow).toBeDefined();
    // The planned parent is not board-visible, so its children are not
    // treated as hidden subtask cards.
    expect(boardChildRow?.isSubtask).toBe(false);

    const plannedChildRow = payload.data.plannedTasks.find(
      (task) => task.id === plannedChild.id,
    );
    expect(plannedChildRow?.nextSubtaskPreview).toBeNull();
  });

  it("never marks cross-project children as hidden subtasks or previews", async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    const projectA = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project A",
      slug: `project-a-${randomUUID()}`,
    });
    const projectB = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Project B",
      slug: `project-b-${randomUUID()}`,
    });
    const parentA = await insertTask(
      projectA.project.id,
      projectA.columns.todo.id,
      "Parent A",
      0,
    );
    const childB = await insertTask(
      projectB.project.id,
      projectB.columns.todo.id,
      "Child B",
      0,
    );
    await insertSubtaskRelation(parentA.id, childB.id, 0);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const responseB = await app.request(
      `/api/task/tasks/${projectB.project.id}`,
    );
    expect(responseB.status).toBe(200);
    const payloadB = (await responseB.json()) as {
      data: { columns: Array<{ slug: string; tasks: Array<Record<string, unknown>> }> };
    };
    const childBRow = todoColumnTasks(payloadB).find(
      (task) => task.id === childB.id,
    );
    expect(childBRow).toBeDefined();
    expect(childBRow?.isSubtask).toBe(false);

    const responseA = await app.request(
      `/api/task/tasks/${projectA.project.id}`,
    );
    expect(responseA.status).toBe(200);
    const payloadA = (await responseA.json()) as {
      data: { columns: Array<{ slug: string; tasks: Array<Record<string, unknown>> }> };
    };
    const parentARow = todoColumnTasks(payloadA).find(
      (task) => task.id === parentA.id,
    );
    expect(parentARow?.nextSubtaskPreview).toBeNull();
  });
});

