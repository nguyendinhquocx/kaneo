// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: field-only marker count
// update. Mirrors update-task-priority: no title/status/priority/position or
// revision/executionState changes, only the marker count map.
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskTable } from "../../database/schema";
import { normalizeWorkMarkerCounts } from "../work-marker-counts";

async function updateWorkMarkers({
  id,
  workMarkerCounts,
}: {
  id: string;
  workMarkerCounts: unknown;
}) {
  const existingTask = await db.query.taskTable.findFirst({
    where: eq(taskTable.id, id),
  });

  if (!existingTask) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  const normalizedCounts = normalizeWorkMarkerCounts(workMarkerCounts);

  const [updatedTask] = await db
    .update(taskTable)
    .set({ workMarkerCounts: normalizedCounts })
    .where(eq(taskTable.id, id))
    .returning();

  if (!updatedTask) {
    throw new HTTPException(500, {
      message: "Failed to update work markers",
    });
  }

  return updatedTask;
}

export default updateWorkMarkers;
