import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { assertTaskContentRevision } from "../content-revision";

async function updateTaskPriority({
  id,
  priority,
  currentUserId,
  expectedContentRevision,
}: {
  id: string;
  priority: string;
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

    const [row] = await tx
      .update(taskTable)
      .set({ priority, contentRevision: lockedTask.contentRevision + 1 })
      .where(eq(taskTable.id, id))
      .returning();

    if (!row) {
      throw new HTTPException(500, {
        message: "Failed to update task priority",
      });
    }
    return { row, oldPriority: lockedTask.priority };
  });

  await publishEvent("task.priority_changed", {
    taskId: updatedTask.row.id,
    projectId: updatedTask.row.projectId,
    userId: currentUserId,
    oldPriority: updatedTask.oldPriority,
    newPriority: priority,
    title: updatedTask.row.title,
    type: "priority_changed",
  });

  return updatedTask.row;
}

export default updateTaskPriority;
