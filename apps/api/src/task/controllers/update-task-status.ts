import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { assertFinalTaskStatusGate } from "../../execution/finalization-gate";
import { assertValidTaskStatus } from "../validate-task-fields";

async function updateTaskStatus({
  id,
  status,
  currentUserId,
}: {
  id: string;
  status: string;
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
      throw new HTTPException(404, {
        message: "Task not found",
      });
    }

    // Keep status validation in the same transaction as the locked task read.
    // The final-column flag can change concurrently with a status request.
    const [column] = await tx
      .select({ id: columnTable.id, isFinal: columnTable.isFinal })
      .from(columnTable)
      .where(
        and(
          eq(columnTable.projectId, existingTask.projectId),
          eq(columnTable.slug, status),
        ),
      )
      .limit(1);

    await assertValidTaskStatus(status, existingTask.projectId);

    await assertFinalTaskStatusGate(tx, {
      taskId: id,
      status,
      isFinalColumn: column?.isFinal === true,
    });

    const [updatedTask] = await tx
      .update(taskTable)
      .set({ status, columnId: column?.id ?? null })
      .where(eq(taskTable.id, id))
      .returning();

    if (!updatedTask) {
      throw new HTTPException(500, {
        message: "Failed to update task status",
      });
    }

    return { existingTask, updatedTask };
  });
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

  return updatedTask;
}

export default updateTaskStatus;
