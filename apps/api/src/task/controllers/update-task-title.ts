import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { assertTaskContentRevision } from "../content-revision";

async function updateTaskTitle({
  id,
  title,
  currentUserId,
  expectedContentRevision,
}: {
  id: string;
  title: string;
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
      .set({ title, contentRevision: lockedTask.contentRevision + 1 })
      .where(eq(taskTable.id, id))
      .returning();

    if (!row) {
      throw new HTTPException(500, {
        message: "Failed to update task title",
      });
    }
    return { row, oldTitle: lockedTask.title };
  });

  await publishEvent("task.title_changed", {
    taskId: updatedTask.row.id,
    projectId: updatedTask.row.projectId,
    userId: currentUserId,
    oldTitle: updatedTask.oldTitle,
    newTitle: title,
    type: "title_changed",
  });

  return updatedTask.row;
}

export default updateTaskTitle;
