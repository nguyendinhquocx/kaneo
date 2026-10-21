import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("API integration: task creation", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects unauthenticated task creation requests", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAnonymousSession();
    const { app } = createApp();

    const response = await app.request(`/api/task/${project.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Unauthorized task",
        description: "Should not be created",
        priority: "low",
        status: "to-do",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("Unauthorized");
  });

  it("creates a task with the matching column, assignee, and next number", async () => {
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Delivery",
      slug: "delivery",
    });

    await db.insert(schema.taskTable).values({
      projectId: project.id,
      userId: member.user.id,
      title: "Existing task",
      description: "Already there",
      status: "to-do",
      columnId: columns.todo.id,
      priority: "medium",
      number: 1,
      position: 1,
    });
    await db
      .update(schema.projectTable)
      .set({ lastTaskNumber: 1 })
      .where(eq(schema.projectTable.id, project.id));

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(`/api/task/${project.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Ship integration flow",
        description: "Cover the first create-task path",
        priority: "high",
        status: "to-do",
        userId: member.user.id,
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      id: string;
      projectId: string;
      title: string;
      description: string;
      priority: string;
      status: string;
      userId: string | null;
      number: number | null;
      position: number | null;
      assigneeName?: string;
    };

    expect(payload).toMatchObject({
      projectId: project.id,
      title: "Ship integration flow",
      description: "Cover the first create-task path",
      priority: "high",
      status: "to-do",
      userId: member.user.id,
      number: 2,
      position: 2,
      assigneeName: member.user.name,
    });

    const persistedTask = await db.query.taskTable.findFirst({
      where: eq(schema.taskTable.id, payload.id),
    });

    expect(persistedTask).toMatchObject({
      id: payload.id,
      projectId: project.id,
      columnId: columns.todo.id,
      userId: member.user.id,
      title: "Ship integration flow",
      priority: "high",
      status: "to-do",
      number: 2,
      position: 2,
    });
  });

  it("rejects task creation for users outside the project workspace", async () => {
    const member = await createWorkspaceMember();
    const outsiderId = `user-${randomUUID()}`;
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [outsider] = await db
      .insert(schema.userTable)
      .values({
        id: outsiderId,
        email: `${outsiderId}@example.com`,
        emailVerified: true,
        name: "Task Outsider",
      })
      .returning();

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const response = await app.request(`/api/task/${project.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Forbidden task",
        description: "Should not be created",
        priority: "low",
        status: "to-do",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe(
      "You don't have access to this workspace",
    );

    const persistedTask = await db.query.taskTable.findFirst({
      where: and(
        eq(schema.taskTable.projectId, project.id),
        eq(schema.taskTable.title, "Forbidden task"),
      ),
    });

    expect(persistedTask).toBeUndefined();
  });

  it("creates an unassigned task with parsed dates when optional fields are provided", async () => {
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(`/api/task/${project.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Plan release cut",
        description: "Track optional fields too",
        priority: "medium",
        status: "in-progress",
        startDate: "2026-04-01T09:00:00.000Z",
        dueDate: "2026-04-05T17:00:00.000Z",
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      id: string;
      userId: string | null;
      columnId: string | null;
      startDate: string | null;
      dueDate: string | null;
      assigneeName?: string;
    };

    expect(payload).toMatchObject({
      userId: null,
      columnId: columns.inProgress.id,
      startDate: "2026-04-01T09:00:00.000Z",
      dueDate: "2026-04-05T17:00:00.000Z",
    });
    expect(payload.assigneeName).toBeUndefined();

    const persistedTask = await db.query.taskTable.findFirst({
      where: eq(schema.taskTable.id, payload.id),
    });

    expect(persistedTask).toMatchObject({
      id: payload.id,
      userId: null,
      columnId: columns.inProgress.id,
      status: "in-progress",
    });
    expect(persistedTask?.startDate?.toISOString()).toBe(
      "2026-04-01T09:00:00.000Z",
    );
    expect(persistedTask?.dueDate?.toISOString()).toBe(
      "2026-04-05T17:00:00.000Z",
    );
  });

  it("creates tasks without a column when the status has no matching project column", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(`/api/task/${project.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Future status task",
        description: "Status does not map to a seeded column",
        priority: "low",
        status: "planned",
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      id: string;
      status: string;
      columnId: string | null;
      position: number | null;
    };

    expect(payload).toMatchObject({
      status: "planned",
      columnId: null,
      position: 1,
    });

    const persistedTask = await db.query.taskTable.findFirst({
      where: eq(schema.taskTable.id, payload.id),
    });

    expect(persistedTask).toMatchObject({
      id: payload.id,
      status: "planned",
      columnId: null,
      position: 1,
    });
  });
});

describe("API integration: task deletion", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function insertTask(
    projectId: string,
    columnId: string,
    title: string,
    number: number,
  ) {
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId,
        title,
        number,
        status: "to-do",
        columnId,
        priority: "no-priority",
        position: number,
      })
      .returning();
    if (!task) throw new Error(`Failed to create task ${title}`);
    return task;
  }

  async function linkSubtask(sourceTaskId: string, targetTaskId: string) {
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId,
      targetTaskId,
      relationType: "subtask",
      position: 0,
    });
  }

  async function deleteTaskRequest(
    taskId: string,
    user: typeof schema.userTable.$inferSelect,
  ) {
    mockAuthenticatedSession(user);
    const { app } = createApp();
    return app.request(`/api/task/${taskId}`, { method: "DELETE" });
  }

  it("deletes exclusive same-project subtasks recursively with the parent", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const parent = await insertTask(project.id, columns.todo.id, "Parent", 1);
    const child = await insertTask(project.id, columns.todo.id, "Child", 2);
    const grandchild = await insertTask(
      project.id,
      columns.todo.id,
      "Grandchild",
      3,
    );
    const unrelated = await insertTask(
      project.id,
      columns.todo.id,
      "Unrelated task",
      4,
    );
    await linkSubtask(parent.id, child.id);
    await linkSubtask(child.id, grandchild.id);

    const response = await deleteTaskRequest(parent.id, member.user);

    expect(response.status).toBe(200);
    for (const id of [parent.id, child.id, grandchild.id]) {
      await expect(
        db.query.taskTable.findFirst({ where: eq(schema.taskTable.id, id) }),
      ).resolves.toBeUndefined();
    }
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, unrelated.id),
      }),
    ).resolves.toMatchObject({ id: unrelated.id });
  });

  it("refuses the whole cascade when a child is shared by another parent", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const parent = await insertTask(project.id, columns.todo.id, "Parent", 1);
    const otherParent = await insertTask(
      project.id,
      columns.todo.id,
      "Other parent",
      2,
    );
    const child = await insertTask(project.id, columns.todo.id, "Child", 3);
    await linkSubtask(parent.id, child.id);
    await linkSubtask(otherParent.id, child.id);

    const response = await deleteTaskRequest(parent.id, member.user);

    expect(response.status).toBe(409);
    for (const id of [parent.id, otherParent.id, child.id]) {
      await expect(
        db.query.taskTable.findFirst({ where: eq(schema.taskTable.id, id) }),
      ).resolves.toMatchObject({ id });
    }
  });

  it("refuses to cascade into another project", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const otherProject = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Another project",
    });
    const parent = await insertTask(project.id, columns.todo.id, "Parent", 1);
    const child = await insertTask(
      otherProject.project.id,
      otherProject.columns.todo.id,
      "Cross-project child",
      1,
    );
    await linkSubtask(parent.id, child.id);

    const response = await deleteTaskRequest(parent.id, member.user);

    expect(response.status).toBe(409);
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, parent.id),
      }),
    ).resolves.toMatchObject({ id: parent.id });
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, child.id),
      }),
    ).resolves.toMatchObject({ id: child.id });
  });

  it("refuses to delete a tree with execution history", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const parent = await insertTask(project.id, columns.todo.id, "Parent", 1);
    const child = await insertTask(project.id, columns.todo.id, "Child", 2);
    await linkSubtask(parent.id, child.id);
    await db.insert(schema.taskRunTable).values({
      taskId: child.id,
      manifestVersion: 1,
      protocolVersion: 1,
      repositoryOwner: "owner",
      repositoryName: "repo",
      baseBranch: "main",
      hostId: "pi-prodesk",
      branchName: "test-child",
      scope: ["apps/web/**"],
      requestKey: `request-${randomUUID()}`,
      requestHash: "a".repeat(64),
      leaseTokenHash: "b".repeat(64),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const response = await deleteTaskRequest(parent.id, member.user);

    expect(response.status).toBe(409);
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, parent.id),
      }),
    ).resolves.toMatchObject({ id: parent.id });
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, child.id),
      }),
    ).resolves.toMatchObject({ id: child.id });
  });

  it("refuses to delete a cyclic subtask relation graph", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const parent = await insertTask(project.id, columns.todo.id, "Parent", 1);
    const child = await insertTask(project.id, columns.todo.id, "Child", 2);
    await linkSubtask(parent.id, child.id);
    await linkSubtask(child.id, parent.id);

    const response = await deleteTaskRequest(parent.id, member.user);

    expect(response.status).toBe(409);
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, parent.id),
      }),
    ).resolves.toMatchObject({ id: parent.id });
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, child.id),
      }),
    ).resolves.toMatchObject({ id: child.id });
  });
});
