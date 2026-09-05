import { and, desc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type db from "../database";
import {
  columnTable,
  executionPhaseCardTable,
  executionPhaseProgressTable,
  taskRunCheckpointTable,
  taskRunTable,
  taskTable,
} from "../database/schema";
import { repairProjectionsForFinalization } from "./phase-projection";

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

// --- SPEC-kaneo-phase-cards-full-run-server-v0-1 (T1): FULL finalization ---

/**
 * FULL-run finalization gate. Locks the FULL task, the mapping and the whole
 * ledger by ordinal, then requires: exact required set, every phase done
 * (no active/blocked/missing), per-phase checkpoint proof bound to the right
 * phase/spec/source-map/branch lineage, and an unchanged map hash. Stale card
 * projections are repaired in-transaction. Any gap is a 409
 * phase_progress_incomplete — comments, Kanban status or verifyResult can
 * never bypass it. Non-FULL tasks pass through untouched.
 */
export async function assertFullRunFinalizationGate(
  tx: StatusGateExecutor,
  { taskId }: { taskId: string },
): Promise<void> {
  const cards = await tx
    .select()
    .from(executionPhaseCardTable)
    .where(eq(executionPhaseCardTable.fullTaskId, taskId))
    .orderBy(executionPhaseCardTable.ordinal)
    .for("update");
  if (cards.length === 0) return; // not a FULL run — nothing to gate

  const ledger = await tx
    .select()
    .from(executionPhaseProgressTable)
    .where(eq(executionPhaseProgressTable.fullTaskId, taskId))
    .orderBy(executionPhaseProgressTable.ordinal)
    .for("update");

  const incomplete = (detail: string) =>
    new HTTPException(409, {
      message: `phase_progress_incomplete: ${detail}`,
    });

  // Exact required set: every required card has exactly one ledger row, and
  // the ledger never drifts beyond the mapping.
  const cardIds = new Set(cards.map((card) => card.phaseId));
  const ledgerIds = new Set(ledger.map((row) => row.phaseId));
  for (const card of cards) {
    if (card.required && !ledgerIds.has(card.phaseId)) {
      throw incomplete(`missing ledger row for required phase ${card.phaseId}`);
    }
  }
  for (const row of ledger) {
    if (!cardIds.has(row.phaseId)) {
      throw incomplete(`ledger row ${row.phaseId} is not in the phase map`);
    }
  }

  // Map hash consistency: all cards share one spec/source-map/graph hash.
  const first = cards[0];
  if (!first) {
    throw incomplete("phase map is empty");
  }
  for (const card of cards) {
    if (
      card.specSha256 !== first.specSha256 ||
      card.sourcePhaseMapSha256 !== first.sourcePhaseMapSha256 ||
      card.graphMapSha256 !== first.graphMapSha256
    ) {
      throw incomplete("phase map hash changed after publish");
    }
  }

  for (const card of cards) {
    const row = ledger.find((entry) => entry.phaseId === card.phaseId);
    if (!row) {
      if (card.required) {
        throw incomplete(`required phase ${card.phaseId} has no progress row`);
      }
      continue;
    }
    if (!card.required && row.state === "pending") continue;
    if (row.state !== "done") {
      throw incomplete(`phase ${card.phaseId} is ${row.state}, expected done`);
    }
    // Checkpoint proof: bound to phase, spec, source map and branch lineage.
    if (!row.checkpointId || !row.commitSha || !row.branchName) {
      throw incomplete(
        `phase ${card.phaseId} has no complete checkpoint proof`,
      );
    }
    const [checkpoint] = await tx
      .select()
      .from(taskRunCheckpointTable)
      .where(eq(taskRunCheckpointTable.id, row.checkpointId))
      .limit(1);
    if (!checkpoint) {
      throw incomplete(
        `phase ${card.phaseId} checkpoint ${row.checkpointId} not found`,
      );
    }
    if (
      checkpoint.phaseId !== card.phaseId ||
      checkpoint.specSha256 !== card.specSha256 ||
      checkpoint.sourcePhaseMapSha256 !== card.sourcePhaseMapSha256 ||
      !checkpoint.receiptHash ||
      checkpoint.commitSha.toLowerCase() !== row.commitSha.toLowerCase()
    ) {
      throw incomplete(
        `phase ${card.phaseId} checkpoint proof does not match the ledger`,
      );
    }
    if (checkpoint.runId !== row.runId) {
      throw incomplete(
        `phase ${card.phaseId} checkpoint belongs to a different run`,
      );
    }
    const [checkpointRun] = await tx
      .select({ branchName: taskRunTable.branchName })
      .from(taskRunTable)
      .where(eq(taskRunTable.id, checkpoint.runId))
      .limit(1);
    if (!checkpointRun || checkpointRun.branchName !== row.branchName) {
      throw incomplete(
        `phase ${card.phaseId} checkpoint branch drifted from the ledger`,
      );
    }
  }

  // Stale card projections are repaired from the ledger; an unrecoverable
  // reconcile error surfaces instead of silently finalizing a stale board.
  const repaired = await repairProjectionsForFinalization(
    tx as Parameters<Parameters<typeof db.transaction>[0]>[0],
    taskId,
  );
  if (!repaired) {
    throw incomplete("projection reconcile could not repair the board");
  }
}
