// SPEC-kaneo-native-telegram-control-v0-1 (T1): monotonic revision counters
// with compare-and-swap semantics. Every mutation that changes execution
// meaning must bump exactly once inside its transaction; a zero-row CAS
// update is always a 409 stale-version error, never a silent overwrite.
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

import type db from "../database";
import {
  executionScheduleTable,
  taskRunTable,
  taskTable,
} from "../database/schema";

export type RevisionTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

function staleRevisionError(field: string) {
  return new HTTPException(409, {
    message: `Stale ${field}: revision changed before this mutation (CAS failed)`,
  });
}

/**
 * Bump `task.task_revision` by one. When `expected` is provided the update
 * is guarded by `WHERE task_revision = expected`; otherwise the bump is
 * unconditional (callers that accept a revision must pass it).
 */
export async function bumpTaskRevision(
  tx: RevisionTransaction,
  {
    taskId,
    expected,
  }: {
    taskId: string;
    expected?: number;
  },
): Promise<number> {
  const [updated] = await tx
    .update(taskTable)
    .set({
      taskRevision: sql`${taskTable.taskRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      expected === undefined
        ? eq(taskTable.id, taskId)
        : and(eq(taskTable.id, taskId), eq(taskTable.taskRevision, expected)),
    )
    .returning({ taskRevision: taskTable.taskRevision });
  if (!updated) {
    throw staleRevisionError("task revision");
  }
  return updated.taskRevision;
}

/** Bump `task_run.run_revision` by one with optional CAS on `expected`. */
export async function bumpRunRevision(
  tx: RevisionTransaction,
  {
    runId,
    expected,
  }: {
    runId: string;
    expected?: number;
  },
): Promise<number> {
  const [updated] = await tx
    .update(taskRunTable)
    .set({
      runRevision: sql`${taskRunTable.runRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      expected === undefined
        ? eq(taskRunTable.id, runId)
        : and(
            eq(taskRunTable.id, runId),
            eq(taskRunTable.runRevision, expected),
          ),
    )
    .returning({ runRevision: taskRunTable.runRevision });
  if (!updated) {
    throw staleRevisionError("run revision");
  }
  return updated.runRevision;
}

/** Bump `execution_schedule.schedule_revision` by one with optional CAS. */
export async function bumpScheduleRevision(
  tx: RevisionTransaction,
  {
    scheduleId,
    expected,
  }: {
    scheduleId: string;
    expected?: number;
  },
): Promise<number> {
  const [updated] = await tx
    .update(executionScheduleTable)
    .set({
      scheduleRevision: sql`${executionScheduleTable.scheduleRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      expected === undefined
        ? eq(executionScheduleTable.id, scheduleId)
        : and(
            eq(executionScheduleTable.id, scheduleId),
            eq(executionScheduleTable.scheduleRevision, expected),
          ),
    )
    .returning({ scheduleRevision: executionScheduleTable.scheduleRevision });
  if (!updated) {
    throw staleRevisionError("schedule revision");
  }
  return updated.scheduleRevision;
}
