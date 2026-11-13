import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskReminderSentTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { assertTaskContentRevision } from "../content-revision";

async function updateTaskDueDate({
  id,
  dueDate,
  currentUserId,
  expectedContentRevision,
}: {
  id: string;
  dueDate: Date | null;
  currentUserId: string;
  expectedContentRevision: number;
}) {
  const updatedTask = await db.transaction(async (tx) => {
    const [lockedTask] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, id))
      .limit(1)
      .for("update");

    if (!lockedTask) {
      throw new HTTPException(404, {
        message: "Task not found",
      });
    }

    await assertTaskContentRevision(tx, id, expectedContentRevision);

    // Clear sent reminders so new due date triggers fresh notifications
    await tx
      .delete(taskReminderSentTable)
      .where(eq(taskReminderSentTable.taskId, id));

    const [row] = await tx
      .update(taskTable)
      .set({ dueDate: dueDate || null, contentRevision: lockedTask.contentRevision + 1 })
      .where(eq(taskTable.id, id))
      .returning();

    if (!row) {
      throw new HTTPException(500, {
        message: "Failed to update task due date",
      });
    }
    return { row, oldDueDate: lockedTask.dueDate };
  });

  await publishEvent("task.due_date_changed", {
    taskId: updatedTask.row.id,
    projectId: updatedTask.row.projectId,
    userId: currentUserId,
    oldDueDate: updatedTask.oldDueDate,
    newDueDate: dueDate,
    title: updatedTask.row.title,
    type: "due_date_changed",
  });

  return updatedTask.row;
}

export default updateTaskDueDate;
