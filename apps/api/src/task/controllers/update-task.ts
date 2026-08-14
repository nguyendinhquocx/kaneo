import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { assertFinalTaskStatusGate } from "../../execution/finalization-gate";
import { deleteOrphanedAssets } from "../../storage/cleanup-assets";
import { assertTaskAssigneeInWorkspace } from "../validate-task-assignee";
import { assertValidTaskStatus } from "../validate-task-fields";

async function updateTask(
  id: string,
  title: string,
  status: string,
  startDate: Date | undefined,
  dueDate: Date | undefined,
  projectId: string,
  workspaceId: string,
  description: string,
  priority: string,
  position: number,
  userId?: string,
  currentUserId?: string,
) {
  const { existingTask, updatedTask } = await db.transaction(async (tx) => {
    const [lockedTask] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, id))
      .limit(1)
      .for("update");

    if (!lockedTask) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    if (projectId !== lockedTask.projectId) {
      throw new HTTPException(400, {
        message: "Use the task move endpoint to move tasks between projects",
      });
    }

    await assertValidTaskStatus(status, projectId);
    await assertTaskAssigneeInWorkspace(tx, userId, workspaceId);

    const [column] = await tx
      .select({ id: columnTable.id, isFinal: columnTable.isFinal })
      .from(columnTable)
      .where(
        and(eq(columnTable.projectId, projectId), eq(columnTable.slug, status)),
      )
      .limit(1);

    await assertFinalTaskStatusGate(tx, {
      taskId: id,
      status,
      isFinalColumn: column?.isFinal === true,
    });

    const [updatedTask] = await tx
      .update(taskTable)
      .set({
        title,
        status,
        columnId: column?.id ?? null,
        startDate: startDate || null,
        dueDate: dueDate || null,
        projectId,
        description,
        priority,
        position,
        userId: userId || null,
      })
      .where(eq(taskTable.id, id))
      .returning();

    if (!updatedTask) {
      throw new HTTPException(500, {
        message: "Failed to update task",
      });
    }

    return { existingTask: lockedTask, updatedTask };
  });
  if (existingTask.status !== status) {
    await publishEvent("task.status_changed", {
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      userId: currentUserId,
      oldStatus: existingTask.status,
      newStatus: status,
      title: updatedTask.title,
      assigneeId: updatedTask.userId,
      type: "status_changed",
    });

    await publishEvent("task-relation.refresh", {
      projectId: updatedTask.projectId,
      userId: currentUserId,
    });
  }

  await publishEvent("task.updated", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    title: updatedTask.title,
    status: updatedTask.status,
    userId: currentUserId,
  });

  if (existingTask.description !== description) {
    deleteOrphanedAssets(existingTask.description, description, {
      taskId: id,
    }).catch(() => {});
  }

  return updatedTask;
}

export default updateTask;
