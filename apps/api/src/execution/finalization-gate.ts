import { and, desc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type db from "../database";
import { columnTable, taskRunTable, taskTable } from "../database/schema";

type StatusGateExecutor = Pick<typeof db, "select">;

export type LatestTaskRunGate = Pick<
  typeof taskRunTable.$inferSelect,
  "id" | "state" | "leaseActive"
>;

/**
 * The task row is the serialization boundary. Callers must lock it before
 * using these helpers; the latest run is locked as well where a status/move
 * decision can race a parent review or a lease takeover.
 */
export async function getLatestTaskRunForGate(
  tx: StatusGateExecutor,
  taskId: string,
  lock = false,
): Promise<LatestTaskRunGate | null> {
  const query = tx
    .select({
      id: taskRunTable.id,
      state: taskRunTable.state,
      leaseActive: taskRunTable.leaseActive,
    })
    .from(taskRunTable)
    .where(eq(taskRunTable.taskId, taskId))
    .orderBy(desc(taskRunTable.leaseEpoch), desc(taskRunTable.createdAt))
    .limit(1);

  const [latestRun] = lock ? await query.for("update") : await query;
  return latestRun ?? null;
}

/**
 * Final task columns are a shared trust boundary. Every status writer must
 * check the same latest execution run while holding the task row lock; a
 * worker report, webhook, or bulk update must not turn an unreviewed run into
 * a final task.
 */
export async function assertFinalTaskStatusGate(
  tx: StatusGateExecutor,
  {
    taskId,
    status,
    isFinalColumn,
  }: {
    taskId: string;
    status: string;
    isFinalColumn: boolean;
  },
): Promise<void> {
  if (status !== "done" && !isFinalColumn) return;

  const latestRun = await getLatestTaskRunForGate(tx, taskId, true);
  if (latestRun && latestRun.state !== "done") {
    throw new HTTPException(409, {
      message: "Task completion is owned by the parent review/merge gate",
    });
  }
}

/**
 * Moving a task changes the project context used by its execution run. Keep
 * active or parent-pending runs anchored to their original project.
 */
export async function assertTaskMoveExecutionGate(
  tx: StatusGateExecutor,
  taskId: string,
): Promise<void> {
  const latestRun = await getLatestTaskRunForGate(tx, taskId, true);

  if (
    latestRun?.leaseActive ||
    latestRun?.state === "in_progress" ||
    latestRun?.state === "in_review"
  ) {
    throw new HTTPException(409, {
      message:
        "Task cannot move while an execution lease or parent review is pending",
    });
  }
}

/**
 * A new worker run must not be created for a task already in a final workflow
 * column, the virtual archived state, or the conventional done state.
 */
export async function assertTaskClaimable(
  tx: StatusGateExecutor,
  {
    projectId,
    status,
  }: {
    projectId: string;
    status: string;
  },
): Promise<void> {
  if (status === "done" || status === "archived") {
    throw new HTTPException(409, {
      message: "Cannot claim a task that is already in a terminal state",
    });
  }

  const [finalColumn] = await tx
    .select({ id: columnTable.id })
    .from(columnTable)
    .where(
      and(
        eq(columnTable.projectId, projectId),
        eq(columnTable.slug, status),
        eq(columnTable.isFinal, true),
      ),
    )
    .limit(1);

  if (finalColumn) {
    throw new HTTPException(409, {
      message: "Cannot claim a task that is already in a terminal state",
    });
  }
}

/**
 * Lock every task in a bulk status mutation in deterministic order. This
 * avoids a check-then-write race and gives concurrent bulk requests a stable
 * lock order instead of a deadlock-prone order from the request body.
 */
export async function lockTasksForStatusMutation(
  tx: StatusGateExecutor,
  taskIds: string[],
) {
  const uniqueIds = [...new Set(taskIds)];
  return tx
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      status: taskTable.status,
    })
    .from(taskTable)
    .where(inArray(taskTable.id, uniqueIds))
    .orderBy(taskTable.id)
    .for("update");
}
