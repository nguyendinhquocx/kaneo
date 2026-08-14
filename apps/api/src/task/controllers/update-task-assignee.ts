import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable, taskTable, userTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { assertTaskAssigneeInWorkspace } from "../validate-task-assignee";

async function updateTaskAssignee({
  id,
  userId,
  currentUserId,
}: {
  id: string;
  userId: string | null;
  currentUserId: string;
}) {
  const { existingTask, updatedTask } = await db.transaction(async (tx) => {
    const [existingTask] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, id))
      .limit(1)
      .for("update");

    if (!existingTask) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    const [project] = await tx
      .select({ workspaceId: projectTable.workspaceId })
      .from(projectTable)
      .where(eq(projectTable.id, existingTask.projectId))
      .limit(1);

    if (!project) {
      throw new HTTPException(404, { message: "Task project not found" });
    }

    const nextAssigneeId = userId || null;
    await assertTaskAssigneeInWorkspace(
      tx,
      nextAssigneeId,
      project.workspaceId,
    );

    if (existingTask.userId === nextAssigneeId) {
      return { existingTask, updatedTask: existingTask };
    }

    const [updatedTask] = await tx
      .update(taskTable)
      .set({ userId: nextAssigneeId })
      .where(eq(taskTable.id, id))
      .returning();

    if (!updatedTask) {
      throw new HTTPException(500, {
        message: "Failed to update task assignee",
      });
    }

    return { existingTask, updatedTask };
  });

  const newAssigneeName = userId
    ? (
        await db
          .select({ name: userTable.name })
          .from(userTable)
          .where(eq(userTable.id, userId))
          .limit(1)
      )[0]?.name
    : undefined;

  if (!userId) {
    await publishEvent("task.unassigned", {
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      userId: currentUserId,
      title: updatedTask.title,
      type: "unassigned",
    });

    return updatedTask;
  }

  await publishEvent("task.assignee_changed", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    userId: currentUserId,
    oldAssignee: existingTask.userId,
    newAssignee: newAssigneeName,
    newAssigneeId: userId,
    title: updatedTask.title,
    type: "assignee_changed",
  });

  return updatedTask;
}

export default updateTaskAssignee;
