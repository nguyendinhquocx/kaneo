import { and, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { assertFinalTaskStatusGate } from "../../execution/finalization-gate";
import { lockProjectTaskLanes } from "../lock-project-task-lanes";
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
  const [snapshot] = await db
    .select({ projectId: taskTable.projectId })
    .from(taskTable)
    .where(eq(taskTable.id, id))
    .limit(1);
  if (!snapshot) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  const { existingTask, updatedTask } = await db.transaction(async (tx) => {
    await lockProjectTaskLanes(tx, [snapshot.projectId]);
    const [existingTask] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, id))
      .limit(1)
      .for("update");

    if (!existingTask || existingTask.projectId !== snapshot.projectId) {
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

    const [maxPositionResult] =
      existingTask.status !== status
        ? await tx
            .select({ maxPosition: max(taskTable.position) })
            .from(taskTable)
            .where(
              and(
                eq(taskTable.projectId, existingTask.projectId),
                column?.id
                  ? eq(taskTable.columnId, column.id)
                  : eq(taskTable.status, status),
              ),
            )
        : [{ maxPosition: existingTask.position }];
    const nextPosition =
      existingTask.status === status
        ? existingTask.position
        : (maxPositionResult?.maxPosition ?? 0) + 1;

    const [updatedTask] = await tx
      .update(taskTable)
      .set({ status, columnId: column?.id ?? null, position: nextPosition })
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
