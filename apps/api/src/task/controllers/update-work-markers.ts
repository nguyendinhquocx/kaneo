// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: field-only marker count
// update. Mirrors update-task-priority: no title/status/priority/position or
// revision/executionState changes, only the marker count map.
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskTable } from "../../database/schema";
import { assertTaskContentRevision } from "../content-revision";
import { normalizeWorkMarkerCounts } from "../work-marker-counts";

async function updateWorkMarkers({
  id,
  workMarkerCounts,
  expectedContentRevision,
}: {
  id: string;
  workMarkerCounts: unknown;
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

    // The full map write is guarded by the content CAS: a stale JSONB map
    // must fail with 409 + current token instead of overwriting newer counts.
    await assertTaskContentRevision(tx, id, expectedContentRevision);

    const normalizedCounts = normalizeWorkMarkerCounts(workMarkerCounts);

    const [row] = await tx
      .update(taskTable)
      .set({
        workMarkerCounts: normalizedCounts,
        contentRevision: lockedTask.contentRevision + 1,
      })
      .where(eq(taskTable.id, id))
      .returning();

    if (!row) {
      throw new HTTPException(500, {
        message: "Failed to update work markers",
      });
    }
    return row;
  });

  return updatedTask;
}

export default updateWorkMarkers;
