import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  assertFinalTaskStatusGate,
} from "../../execution/finalization-gate";
import { lockProjectTaskLanes } from "../lock-project-task-lanes";
import { assertValidTaskStatus } from "../validate-task-fields";

export type ReorderTaskDelta = {
  id: string;
  status: string;
  position: number;
};

/**
 * Batch lane reorder for the owner board drag (SPEC-2026-11-10 R4).
 *
 * The old lane persisted one full PATCH per changed task, so dragging a card
 * through a populated lane fired N concurrent-ish requests, each opening its
 * own Postgres connection and its own activity/notification fan-out. One
 * transaction with N row updates keeps the same result (status + position per
 * card, CAS token advanced, final-column gate enforced) in a single request.
 */
async function reorderProjectTasks(
  projectId: string,
  deltas: ReorderTaskDelta[],
  currentUserId: string | undefined,
) {
  if (deltas.length === 0) {
    throw new HTTPException(400, { message: "No task deltas provided" });
  }

  const uniqueStatuses = [...new Set(deltas.map((delta) => delta.status))];
  const [columns, tasks] = await Promise.all([
    db
      .select({
        id: columnTable.id,
        slug: columnTable.slug,
        isFinal: columnTable.isFinal,
      })
      .from(columnTable)
      .where(eq(columnTable.projectId, projectId))
      .orderBy(columnTable.position),
    db
      .select()
      .from(taskTable)
      .where(
        and(
          eq(taskTable.projectId, projectId),
          inArray(
            taskTable.id,
            deltas.map((delta) => delta.id),
          ),
        ),
      ),
  ]);

  if (columns.length === 0) {
    throw new HTTPException(400, { message: "Project does not have a workflow" });
  }
  const columnBySlug = new Map(columns.map((column) => [column.slug, column]));
  const uniqueStatusSlugs = [...new Set(uniqueStatuses)];
  for (const slug of uniqueStatusSlugs) {
    if (!columnBySlug.has(slug)) {
      throw new HTTPException(400, {
        message: `Selected status is not valid for this project: ${slug}`,
      });
    }
    await assertValidTaskStatus(slug, projectId);
  }
  if (tasks.length !== deltas.length) {
    throw new HTTPException(400, {
      message: "Some tasks do not belong to this project",
    });
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const updated = await db.transaction(async (tx) => {
    await lockProjectTaskLanes(tx, [projectId]);

    const results: Array<{
      existingStatus: string;
      task: typeof taskTable.$inferSelect;
    }> = [];
    for (const delta of deltas) {
      const existing = taskById.get(delta.id);
      if (!existing) {
        throw new HTTPException(404, {
          message: "Task not found in this project",
        });
      }
      const column = columnBySlug.get(delta.status);
      const statusChanged = existing.status !== delta.status;
      const laneOrderChanged =
        statusChanged || existing.position !== delta.position;
      if (!laneOrderChanged) {
        // Nothing to write for this card; keep the lock scope but skip the row.
        continue;
      }

      await assertFinalTaskStatusGate(tx, {
        taskId: delta.id,
        status: delta.status,
        isFinalColumn: column?.isFinal === true,
      });

      const [updatedTask] = await tx
        .update(taskTable)
        .set({
          status: delta.status,
          columnId: column?.id ?? null,
          position: delta.position,
          // Matches the ordinary PATCH lane: a lane write advances the CAS
          // token so share/full clients refetch instead of writing stale.
          contentRevision: existing.contentRevision + 1,
        })
        .where(
          and(
            eq(taskTable.id, delta.id),
            eq(taskTable.contentRevision, existing.contentRevision),
          ),
        )
        .returning();
      if (!updatedTask) {
        throw new HTTPException(409, {
          message: "Task lane changed; refresh and retry the reorder",
        });
      }
      results.push({ existingStatus: existing.status, task: updatedTask });
    }
    return results;
  });

  let relationRefreshed = false;
  for (const { existingStatus, task } of updated) {
    if (existingStatus !== task.status) {
      await publishEvent("task.status_changed", {
        taskId: task.id,
        projectId: task.projectId,
        userId: currentUserId,
        oldStatus: existingStatus,
        newStatus: task.status,
        title: task.title,
        assigneeId: task.userId,
        type: "status_changed",
      });
      if (!relationRefreshed) {
        await publishEvent("task-relation.refresh", {
          projectId: task.projectId,
          userId: currentUserId,
        });
        relationRefreshed = true;
      }
    }
    await publishEvent("task.updated", {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
      userId: currentUserId,
    });
  }

  return {
    updated: updated.map(({ task }) => ({
      id: task.id,
      status: task.status,
      // Server column allows null; the wire contract is a number.
      position: task.position ?? 0,
      contentRevision: task.contentRevision,
    })),
  };
}

export default reorderProjectTasks;
