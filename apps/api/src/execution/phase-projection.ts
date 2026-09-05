// SPEC-kaneo-phase-cards-full-run-server-v0-1 (T1): durable projection
// outbox reconciler. Ledger commits stay decoupled from child card
// status/comment writes; a failed projection is `display_pending` — it never
// rolls back the ledger nor blocks the worker. Apply is idempotent per
// (fullTaskId, phaseId, projectionKind, ledgerVersion) and safe after crashes.
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import db from "../database";
import {
  activityTable,
  columnTable,
  executionPhaseProjectionTable,
  taskTable,
} from "../database/schema";
import { PHASE_PROJECTION_KINDS, renderPhaseMarker } from "./phase-progress";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

const MAX_ATTEMPTS_BEFORE_FAILED = 5;
const RECONCILE_BATCH = 50;

export type ProjectionApplyResult = {
  claimed: number;
  applied: number;
  failed: number;
  displayPending: boolean;
};

type ProjectionRow = typeof executionPhaseProjectionTable.$inferSelect;

async function resolveColumnIdBySlug(
  executor: Executor,
  projectId: string,
  slug: string,
): Promise<string | null> {
  const [column] = await executor
    .select({ id: columnTable.id })
    .from(columnTable)
    .where(
      and(eq(columnTable.projectId, projectId), eq(columnTable.slug, slug)),
    )
    .limit(1);
  return column?.id ?? null;
}

/**
 * Apply one projection row idempotently. Kanban moves resolve the column
 * server-side by slug; markers re-render server-side from the structured
 * receipt payload — free-text content is never accepted from workers.
 */
async function applyProjectionRow(
  executor: Executor,
  row: ProjectionRow,
): Promise<void> {
  if (row.projectionKind === PHASE_PROJECTION_KINDS.kanban) {
    const slug = row.desiredColumnSlug;
    if (!slug) throw new Error("kanban projection missing desiredColumnSlug");
    const [child] = await executor
      .select({ projectId: taskTable.projectId })
      .from(taskTable)
      .where(eq(taskTable.id, row.childTaskId))
      .limit(1);
    if (!child) {
      // Child deleted (cascaded) — nothing left to project.
      return;
    }
    const columnId = await resolveColumnIdBySlug(
      executor,
      child.projectId,
      slug,
    );
    if (!columnId) {
      throw new Error(`display_pending: no column with slug ${slug}`);
    }
    await executor
      .update(taskTable)
      .set({ columnId, status: slug, updatedAt: new Date() })
      .where(eq(taskTable.id, row.childTaskId));
    return;
  }
  if (row.projectionKind === PHASE_PROJECTION_KINDS.marker) {
    const payload = row.markerPayload as Record<string, unknown>;
    const text = renderPhaseMarker({
      marker: typeof payload.marker === "string" ? payload.marker : "⭕",
      phaseId: row.phaseId,
      title: typeof payload.title === "string" ? payload.title : row.phaseId,
      commitSha:
        typeof payload.commitSha === "string" ? payload.commitSha : null,
      checkpointId:
        typeof payload.checkpointId === "string" ? payload.checkpointId : null,
    });
    const [child] = await executor
      .select({ projectId: taskTable.projectId })
      .from(taskTable)
      .where(eq(taskTable.id, row.childTaskId))
      .limit(1);
    if (!child) return;
    const [existing] = await executor
      .select({ id: activityTable.id })
      .from(activityTable)
      .where(
        and(
          eq(activityTable.taskId, row.childTaskId),
          eq(activityTable.content, text),
        ),
      )
      .limit(1);
    if (existing) return;
    await executor.insert(activityTable).values({
      taskId: row.childTaskId,
      type: "comment",
      userId: null,
      content: text,
      externalSource: "kaneo-phase-projection",
    });
    return;
  }
  throw new Error(`unknown projection kind ${row.projectionKind}`);
}

/**
 * Claim and apply pending (or retryable failed) projections for a FULL task.
 * Bounded: `limit` rows per call. Crashes mid-apply are recovered by the next
 * reconcile; the ledger is never touched here.
 */
export async function reconcilePhaseProjections(input: {
  fullTaskId: string;
  limit?: number;
  executor?: Executor;
}): Promise<ProjectionApplyResult> {
  const executor = input.executor ?? db;
  const limit = Math.min(Math.max(input.limit ?? RECONCILE_BATCH, 1), 200);
  const candidates = await executor
    .select()
    .from(executionPhaseProjectionTable)
    .where(
      and(
        eq(executionPhaseProjectionTable.fullTaskId, input.fullTaskId),
        or(
          eq(executionPhaseProjectionTable.state, "pending"),
          and(
            eq(executionPhaseProjectionTable.state, "failed"),
            sql`${executionPhaseProjectionTable.attempts} < ${MAX_ATTEMPTS_BEFORE_FAILED}`,
          ),
        ),
      ),
    )
    .orderBy(asc(executionPhaseProjectionTable.ledgerVersion))
    .limit(limit);

  let applied = 0;
  let failed = 0;
  for (const row of candidates) {
    try {
      await applyProjectionRow(executor, row);
      await executor
        .update(executionPhaseProjectionTable)
        .set({
          state: "applied",
          appliedAt: new Date(),
          lastError: null,
          attempts: row.attempts + 1,
          updatedAt: new Date(),
        })
        .where(eq(executionPhaseProjectionTable.id, row.id));
      applied += 1;
    } catch (error) {
      failed += 1;
      const message =
        error instanceof Error ? error.message.slice(0, 500) : "unknown";
      const nextAttempts = row.attempts + 1;
      await executor
        .update(executionPhaseProjectionTable)
        .set({
          state:
            nextAttempts >= MAX_ATTEMPTS_BEFORE_FAILED ? "failed" : "pending",
          attempts: nextAttempts,
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(executionPhaseProjectionTable.id, row.id));
    }
  }
  const stillPending =
    applied + failed < candidates.length
      ? candidates.length - applied - failed
      : 0;
  return {
    claimed: candidates.length,
    applied,
    failed,
    displayPending: failed > 0 || stillPending > 0,
  };
}

/**
 * Finalization-time bounded repair inside the parent transaction. Returns
 * true when no pending projections remain (or repairs succeeded).
 */
export async function repairProjectionsForFinalization(
  tx: Tx,
  fullTaskId: string,
): Promise<boolean> {
  const result = await reconcilePhaseProjections({
    fullTaskId,
    executor: tx,
  });
  if (result.failed === 0 && !result.displayPending) return true;
  const [remaining] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(executionPhaseProjectionTable)
    .where(
      and(
        eq(executionPhaseProjectionTable.fullTaskId, fullTaskId),
        inArray(executionPhaseProjectionTable.state, ["pending", "failed"]),
      ),
    );
  return (remaining?.count ?? 0) === 0;
}
