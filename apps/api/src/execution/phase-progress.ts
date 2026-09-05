// SPEC-kaneo-phase-cards-full-run-server-v0-1 (T1): fenced phase-progress
// authority. One FULL task owns an ordered phase ledger; phase child cards
// are projections. Every mutation is fenced (exact principal/host/run/active
// lease/epoch/token — token via X-Kaneo-Lease-Token), idempotent through the
// execution idempotency table with deterministic keys, and serialized under a
// fixed lock order: FULL task -> run -> all ledger rows by ordinal -> phase
// row -> child projection.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  agentPrincipalTable,
  commentTable,
  executionIdempotencyTable,
  executionPhaseCardTable,
  executionPhaseProgressTable,
  executionPhaseProjectionTable,
  taskRunCheckpointTable,
  taskRunEvidenceTable,
  taskRunTable,
  taskTable,
} from "../database/schema";
import { enqueueNotificationEvent } from "./outbox";
import {
  type CanonicalPhaseInput,
  canonicalSha256,
  hashLeaseToken,
  type TaskRunState,
  validateFailureKind,
  validateLeaseEpoch,
  validateRevision,
  WORKER_FAILURE_KINDS,
} from "./validation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ReadExecutor = Pick<Tx, "select">;

export const PHASE_STATES = [
  "pending",
  "in_progress",
  "done",
  "blocked",
] as const;
export type PhaseState = (typeof PHASE_STATES)[number];

export const PHASE_PROJECTION_KINDS = {
  kanban: "kanban_column",
  marker: "phase_marker",
} as const;

const PHASE_IDEMPOTENCY_OPERATION = "execution.phase_progress";
const MAX_REASON_LENGTH = 2_000;

/** Canonical run state per block failureKind (spec block matrix). */
export function mapFailureKindToRunState(failureKind: string): TaskRunState {
  switch (failureKind) {
    case "provider_quota":
      return "blocked_quota";
    case "malformed_phase_map":
      return "blocked_input";
    default:
      return "failed";
  }
}

function phaseError(status: 403 | 404 | 409, message: string): HTTPException {
  return new HTTPException(status, { message });
}

// --- mapping context / central guards -------------------------------------

export type WriteExecutor = ReadExecutor &
  Pick<Tx, "update" | "insert" | "delete">;

export { lockFullTask, lockLedger, lockMappingCards, phaseError };

export type PhaseCardContext = {
  isPhaseChild: boolean;
  isFullRun: boolean;
  parentFullTaskId: string | null;
  projectId: string | null;
};

/**
 * Resolve the phase-card relationship of a task: `isPhaseChild` marks a child
 * card (must never be claimed/mutated generically); `isFullRun` marks a FULL
 * task that owns a phase ledger (worker-generic lifecycle routes are denied).
 */
export async function getPhaseCardContext(
  executor: ReadExecutor,
  taskId: string,
): Promise<PhaseCardContext> {
  const [asChild] = await executor
    .select({
      fullTaskId: executionPhaseCardTable.fullTaskId,
      projectId: executionPhaseCardTable.projectId,
    })
    .from(executionPhaseCardTable)
    .where(eq(executionPhaseCardTable.childTaskId, taskId))
    .limit(1);
  if (asChild) {
    return {
      isPhaseChild: true,
      isFullRun: false,
      parentFullTaskId: asChild.fullTaskId,
      projectId: asChild.projectId,
    };
  }
  const [asFull] = await executor
    .select({ projectId: executionPhaseCardTable.projectId })
    .from(executionPhaseCardTable)
    .where(eq(executionPhaseCardTable.fullTaskId, taskId))
    .limit(1);
  return {
    isPhaseChild: false,
    isFullRun: Boolean(asFull),
    parentFullTaskId: null,
    projectId: asFull?.projectId ?? null,
  };
}

/** Deny any generic write surface that targets a phase child card. */
export async function assertTaskNotPhaseChild(
  executor: ReadExecutor,
  taskId: string,
  message = "phase_card_guard: phase child cards are ledger projections and cannot be mutated directly",
): Promise<void> {
  const [child] = await executor
    .select({ id: executionPhaseCardTable.id })
    .from(executionPhaseCardTable)
    .where(eq(executionPhaseCardTable.childTaskId, taskId))
    .limit(1);
  if (child) {
    throw phaseError(409, message);
  }
}

/**
 * True when the project still has a FULL graph in flight (FULL task not in a
 * terminal execution state). `create_task` of an agent principal is denied
 * while such a graph is active — the parent graph transaction owns topology.
 */
export async function projectHasActiveFullGraph(
  executor: ReadExecutor,
  projectId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: executionPhaseCardTable.id })
    .from(executionPhaseCardTable)
    .innerJoin(taskTable, eq(taskTable.id, executionPhaseCardTable.fullTaskId))
    .where(
      and(
        eq(executionPhaseCardTable.projectId, projectId),
        sql`${taskTable.executionState} not in ('done', 'archived')`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Deny worker/agent lifecycle bypasses on a FULL mapped run. `report` may
 * still transition to in_review once every required phase is done (the
 * normal parent-review handoff); everything else on this list is unconditional.
 */
export async function assertFullRunReportGuard(
  executor: ReadExecutor,
  taskId: string,
  nextState: TaskRunState,
): Promise<void> {
  const context = await getPhaseCardContext(executor, taskId);
  if (!context.isFullRun) return;
  if (nextState === "in_review") {
    const required = await executor
      .select({ state: executionPhaseProgressTable.state })
      .from(executionPhaseProgressTable)
      .innerJoin(
        executionPhaseCardTable,
        and(
          eq(
            executionPhaseCardTable.fullTaskId,
            executionPhaseProgressTable.fullTaskId,
          ),
          eq(
            executionPhaseCardTable.phaseId,
            executionPhaseProgressTable.phaseId,
          ),
        ),
      )
      .where(
        and(
          eq(executionPhaseProgressTable.fullTaskId, taskId),
          eq(executionPhaseCardTable.required, true),
        ),
      );
    const allDone =
      required.length > 0 && required.every((row) => row.state === "done");
    if (!allDone) {
      throw phaseError(
        409,
        "phase_progress_incomplete: required phases are not done; in_review is not allowed",
      );
    }
    return;
  }
  if (nextState !== "in_progress") {
    throw phaseError(
      409,
      "use_phase_progress: blocked/release/report lifecycle on a FULL run must go through the fenced phase-progress API",
    );
  }
}

// --- read-only fence ------------------------------------------------------

async function getPhasePrincipal(
  executor: ReadExecutor,
  userId: string,
  principalId: string,
) {
  const [principal] = await executor
    .select()
    .from(agentPrincipalTable)
    .where(
      and(
        eq(agentPrincipalTable.id, principalId),
        eq(agentPrincipalTable.userId, userId),
        eq(agentPrincipalTable.isActive, true),
      ),
    )
    .limit(1);
  if (!principal) {
    throw phaseError(
      403,
      "Agent principal is not active or not owned by this user",
    );
  }
  return principal;
}

/**
 * Pure read-only fence for the phase paths: exact principal ownership, scope,
 * active unexpired lease, epoch and token hash. Never mutates the run —
 * stale token/epoch/expired leases return 409 stale_fence with no write
 * (orphaning belongs to the watchdog/claim-recovery paths only).
 */
export async function assertPhaseFence(
  executor: ReadExecutor,
  input: {
    taskId: string;
    runId: string;
    userId: string;
    leaseEpoch: number;
    leaseToken: string;
    requiredScope?: string;
  },
) {
  const normalizedEpoch = validateLeaseEpoch(input.leaseEpoch);
  const [run] = await executor
    .select()
    .from(taskRunTable)
    .where(eq(taskRunTable.id, input.runId))
    .limit(1);
  if (!run || run.taskId !== input.taskId) {
    throw phaseError(404, "Task run not found");
  }
  if (!run.agentPrincipalId) {
    throw phaseError(409, "Task run has no active agent principal");
  }
  const principal = await getPhasePrincipal(
    executor,
    input.userId,
    run.agentPrincipalId,
  );
  const scope = input.requiredScope ?? "run:report";
  if (!principal.scopes.includes(scope)) {
    throw new HTTPException(403, {
      message: `Agent principal lacks ${scope} scope`,
    });
  }
  const stale = (reason: string): HTTPException =>
    phaseError(
      409,
      `stale_fence: ${reason} (read-only fence, nothing mutated)`,
    );
  if (!run.leaseActive) throw stale("lease_inactive");
  if (run.leaseExpiresAt.getTime() <= Date.now()) throw stale("expired_lease");
  if (
    run.leaseEpoch !== normalizedEpoch ||
    hashLeaseToken(input.leaseToken) !== run.leaseTokenHash
  ) {
    throw stale("epoch_or_token_mismatch");
  }
  return { run, principal, leaseEpoch: normalizedEpoch };
}

// --- idempotency (phase-local, reuses execution idempotency table) --------

type PhaseIdempotencyInput = {
  tx: WriteExecutor;
  userId: string;
  runId: string;
  requestKey: string;
  requestHash: string;
};

async function reservePhaseIdempotency({
  tx,
  userId,
  runId,
  requestKey,
  requestHash,
}: PhaseIdempotencyInput): Promise<{ replay: Record<string, unknown> | null }> {
  const [reserved] = await tx
    .insert(executionIdempotencyTable)
    .values({
      userId,
      runId,
      operation: PHASE_IDEMPOTENCY_OPERATION,
      requestKey,
      requestHash,
      response: {},
    })
    .onConflictDoNothing({
      target: [
        executionIdempotencyTable.operation,
        executionIdempotencyTable.requestKey,
      ],
    })
    .returning({ id: executionIdempotencyTable.id });
  if (reserved) return { replay: null };
  const [record] = await tx
    .select()
    .from(executionIdempotencyTable)
    .where(
      and(
        eq(executionIdempotencyTable.operation, PHASE_IDEMPOTENCY_OPERATION),
        eq(executionIdempotencyTable.requestKey, requestKey),
      ),
    )
    .limit(1);
  if (!record) {
    throw phaseError(409, "Idempotency-Key reservation was not available");
  }
  if (
    record.userId !== userId ||
    record.runId !== runId ||
    record.requestHash !== requestHash
  ) {
    throw phaseError(
      409,
      "Idempotency-Key was already used with a different request",
    );
  }
  // Crash between reserve and save: an empty stored response is treated as
  // not-yet-reserved and re-executed in this request — never replayed as {}.
  const response = record.response as Record<string, unknown>;
  if (!response || Object.keys(response).length === 0) {
    return { replay: null };
  }
  return { replay: response };
}

async function savePhaseIdempotency({
  tx,
  userId,
  runId,
  requestKey,
  requestHash,
  response,
}: PhaseIdempotencyInput & {
  response: Record<string, unknown>;
}): Promise<void> {
  await tx
    .update(executionIdempotencyTable)
    .set({ response })
    .where(
      and(
        eq(executionIdempotencyTable.userId, userId),
        eq(executionIdempotencyTable.runId, runId),
        eq(executionIdempotencyTable.operation, PHASE_IDEMPOTENCY_OPERATION),
        eq(executionIdempotencyTable.requestKey, requestKey),
        eq(executionIdempotencyTable.requestHash, requestHash),
      ),
    );
}

export function requirePhaseRequestKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 200) {
    throw new HTTPException(400, {
      message:
        "Idempotency-Key header is required and must be <= 200 characters",
    });
  }
  return key;
}

// --- lock order helpers ---------------------------------------------------

async function lockFullTask(tx: WriteExecutor, taskId: string) {
  const [task] = await tx
    .select({ id: taskTable.id, projectId: taskTable.projectId })
    .from(taskTable)
    .where(eq(taskTable.id, taskId))
    .limit(1)
    .for("update");
  if (!task) throw phaseError(404, "Task not found");
  return task;
}

async function lockRunForPhase(
  tx: WriteExecutor,
  runId: string,
  taskId: string,
) {
  const [run] = await tx
    .select()
    .from(taskRunTable)
    .where(eq(taskRunTable.id, runId))
    .limit(1)
    .for("update");
  if (!run || run.taskId !== taskId) {
    throw phaseError(404, "Task run not found");
  }
  return run;
}

async function lockLedger(tx: WriteExecutor, fullTaskId: string) {
  return tx
    .select()
    .from(executionPhaseProgressTable)
    .where(eq(executionPhaseProgressTable.fullTaskId, fullTaskId))
    .orderBy(asc(executionPhaseProgressTable.ordinal))
    .for("update");
}

async function lockMappingCards(executor: ReadExecutor, fullTaskId: string) {
  return executor
    .select()
    .from(executionPhaseCardTable)
    .where(eq(executionPhaseCardTable.fullTaskId, fullTaskId))
    .orderBy(asc(executionPhaseCardTable.ordinal));
}

async function lockChildProjections(
  tx: WriteExecutor,
  fullTaskId: string,
  phaseId: string,
) {
  return tx
    .select()
    .from(executionPhaseProjectionTable)
    .where(
      and(
        eq(executionPhaseProjectionTable.fullTaskId, fullTaskId),
        eq(executionPhaseProjectionTable.phaseId, phaseId),
      ),
    )
    .for("update");
}

// --- projection outbox writers --------------------------------------------

export function renderPhaseMarker(payload: {
  marker: string;
  phaseId: string;
  title: string;
  commitSha?: string | null;
  checkpointId?: string | null;
}): string {
  const sha = payload.commitSha ? ` (${payload.commitSha.slice(0, 12)})` : "";
  return `[${payload.marker}] ${payload.phaseId} ${payload.title}${sha}`;
}

export async function enqueuePhaseProjections(
  tx: WriteExecutor,
  input: {
    fullTaskId: string;
    phaseId: string;
    childTaskId: string;
    ledgerVersion: number;
    columnSlug: "to-do" | "in-progress" | "done";
    marker: string;
    title: string;
    commitSha?: string | null;
    checkpointId?: string | null;
  },
): Promise<void> {
  const markerText = renderPhaseMarker(input);
  const rows: Array<typeof executionPhaseProjectionTable.$inferInsert> = [
    {
      fullTaskId: input.fullTaskId,
      phaseId: input.phaseId,
      projectionKind: PHASE_PROJECTION_KINDS.kanban,
      ledgerVersion: input.ledgerVersion,
      childTaskId: input.childTaskId,
      desiredColumnSlug: input.columnSlug,
      markerPayload: {
        marker: input.marker,
        phaseId: input.phaseId,
        columnSlug: input.columnSlug,
      },
      markerHash: canonicalSha256({
        kind: PHASE_PROJECTION_KINDS.kanban,
        ledgerVersion: input.ledgerVersion,
        columnSlug: input.columnSlug,
      }),
      state: "pending",
    },
    {
      fullTaskId: input.fullTaskId,
      phaseId: input.phaseId,
      projectionKind: PHASE_PROJECTION_KINDS.marker,
      ledgerVersion: input.ledgerVersion,
      childTaskId: input.childTaskId,
      desiredColumnSlug: null,
      markerPayload: {
        marker: input.marker,
        phaseId: input.phaseId,
        title: input.title,
        text: markerText,
        commitSha: input.commitSha ?? null,
        checkpointId: input.checkpointId ?? null,
      },
      markerHash: canonicalSha256({
        kind: PHASE_PROJECTION_KINDS.marker,
        ledgerVersion: input.ledgerVersion,
        text: markerText,
      }),
      state: "pending",
    },
  ];
  await tx
    .insert(executionPhaseProjectionTable)
    .values(rows)
    .onConflictDoNothing({
      target: [
        executionPhaseProjectionTable.fullTaskId,
        executionPhaseProjectionTable.phaseId,
        executionPhaseProjectionTable.projectionKind,
        executionPhaseProjectionTable.ledgerVersion,
      ],
    });
}

/** Graph publish: create the pending ledger + initial projection rows. */
export async function insertPendingPhaseLedger(
  tx: WriteExecutor,
  input: {
    fullTaskId: string;
    phases: Array<CanonicalPhaseInput & { childTaskId: string }>;
  },
): Promise<void> {
  await tx.insert(executionPhaseProgressTable).values(
    input.phases.map((phase) => ({
      fullTaskId: input.fullTaskId,
      phaseId: phase.phaseId,
      ordinal: phase.ordinal,
      state: "pending" as const,
    })),
  );
  for (const phase of input.phases) {
    await enqueuePhaseProjections(tx, {
      fullTaskId: input.fullTaskId,
      phaseId: phase.phaseId,
      childTaskId: phase.childTaskId,
      ledgerVersion: 1,
      columnSlug: "to-do",
      marker: "⭕ QUEUED",
      title: phase.title,
    });
  }
}

// --- phase operations -----------------------------------------------------

export type PhaseProgressAction = "get" | "begin" | "complete" | "block";

export type PhaseProgressInput = {
  taskId: string;
  runId: string;
  userId: string;
  leaseEpoch: number;
  leaseToken: string;
  action: PhaseProgressAction;
  phaseId: string;
  checkpointId?: string;
  failureKind?: unknown;
  reason?: unknown;
  retryAt?: unknown;
  expectedRunRevision?: unknown;
  requestKey: string;
};

function validatePhaseId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 64) {
    throw new HTTPException(400, {
      message: "phaseId must be a bounded string",
    });
  }
  return value.trim();
}

function boundedReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: "reason must be a string" });
  }
  const reason = value.trim();
  if (reason.length > MAX_REASON_LENGTH) {
    throw new HTTPException(400, {
      message: `reason must be <= ${MAX_REASON_LENGTH} characters`,
    });
  }
  return reason;
}

function boundedRetryAt(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HTTPException(400, {
      message: "retryAt must be an ISO timestamp",
    });
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HTTPException(400, {
      message: "retryAt must be an ISO timestamp",
    });
  }
  return parsed;
}

/** Deterministic idempotency keys (spec wire contract). */
export function phaseIdempotencyKey(
  action: "begin" | "complete" | "block",
  runId: string,
  phaseId: string,
  tail?: string,
): string {
  if (action === "begin") return `phase-begin:${runId}:${phaseId}`;
  if (action === "complete") {
    return `phase-complete:${runId}:${phaseId}:${tail ?? ""}`;
  }
  return `phase-block:${runId}:${phaseId}:${tail ?? ""}`;
}

/**
 * Canonical request hash for begin/block excludes leaseEpoch (fence) and
 * free-text reason (audit); phaseId/action/failureKind stay identity.
 */
function phaseRequestHash(
  action: "begin" | "complete" | "block",
  input: {
    taskId: string;
    runId: string;
    phaseId: string;
    failureKind?: string;
    retryAt?: Date;
    checkpointId?: string;
  },
): string {
  return canonicalSha256({
    action,
    taskId: input.taskId,
    phaseId: input.phaseId,
    ...(action === "complete"
      ? { checkpointId: input.checkpointId ?? "" }
      : {
          failureKind: input.failureKind ?? null,
          retryAt: input.retryAt ? input.retryAt.toISOString() : null,
        }),
  });
}

export async function getPhaseProgressSnapshot(
  executor: ReadExecutor,
  taskId: string,
  runId: string,
) {
  const cards = await lockMappingCards(executor, taskId);
  const ledger = await executor
    .select()
    .from(executionPhaseProgressTable)
    .where(eq(executionPhaseProgressTable.fullTaskId, taskId))
    .orderBy(asc(executionPhaseProgressTable.ordinal));
  const phases = cards.map((card) => {
    const row = ledger.find((entry) => entry.phaseId === card.phaseId);
    return {
      phaseId: card.phaseId,
      parserTaskId: card.parserTaskId,
      ordinal: card.ordinal,
      required: card.required,
      childTaskId: card.childTaskId,
      state: row?.state ?? "pending",
      runId: row?.runId ?? null,
      leaseEpoch: row?.leaseEpoch ?? null,
      checkpointId: row?.checkpointId ?? null,
      commitSha: row?.commitSha ?? null,
      branchName: row?.branchName ?? null,
      failureKind: row?.failureKind ?? null,
      reason: row?.reason ?? null,
      ledgerVersion: row?.ledgerVersion ?? 1,
    };
  });
  return {
    taskId,
    runId,
    specSha256: cards[0]?.specSha256 ?? null,
    sourcePhaseMapSha256: cards[0]?.sourcePhaseMapSha256 ?? null,
    graphMapSha256: cards[0]?.graphMapSha256 ?? null,
    graphId: cards[0]?.graphId ?? null,
    phases,
  };
}

async function executePhaseMutation(
  input: PhaseProgressInput,
): Promise<Record<string, unknown>> {
  const { taskId, runId, userId } = input;
  const phaseId = validatePhaseId(input.phaseId);
  const action = input.action;
  if (action === "get") {
    // Read-only: fence then snapshot, no idempotency reservation needed.
    return db.transaction(async (tx) => {
      await assertPhaseFence(tx, {
        taskId,
        runId,
        userId,
        leaseEpoch: input.leaseEpoch,
        leaseToken: input.leaseToken,
      });
      return (await getPhaseProgressSnapshot(tx, taskId, runId)) as Record<
        string,
        unknown
      >;
    });
  }
  if (action === "complete" && !input.checkpointId) {
    throw new HTTPException(400, {
      message: "checkpointId is required for phase complete",
    });
  }
  const normalizedBlockKind =
    action === "block" ? validateFailureKind(input.failureKind) : undefined;
  if (action === "block" && !normalizedBlockKind) {
    throw new HTTPException(400, {
      message: `failureKind is required for block and must be one of ${WORKER_FAILURE_KINDS.join(", ")}`,
    });
  }
  const reason = boundedReason(input.reason);
  const retryAt = boundedRetryAt(input.retryAt);
  const expectedRevision = validateRevision(
    input.expectedRunRevision,
    "expectedRunRevision",
  );
  const requestKey = requirePhaseRequestKey(input.requestKey);
  const requestHash = phaseRequestHash(action, {
    taskId,
    runId,
    phaseId,
    failureKind: normalizedBlockKind,
    retryAt,
    checkpointId: input.checkpointId,
  });

  return db.transaction(async (tx) => {
    const { replay } = await reservePhaseIdempotency({
      tx,
      userId,
      runId,
      requestKey,
      requestHash,
    });
    if (replay) return replay;

    const fence = await assertPhaseFence(tx, {
      taskId,
      runId,
      userId,
      leaseEpoch: input.leaseEpoch,
      leaseToken: input.leaseToken,
    });

    // Lock order: FULL task -> run -> ledger rows by ordinal -> phase row
    // (within the locked ledger set) -> child projections.
    await lockFullTask(tx, taskId);
    const run = await lockRunForPhase(tx, runId, taskId);
    const ledger = await lockLedger(tx, taskId);
    const cards = await lockMappingCards(tx, taskId);
    const titles = await childTitleMap(tx, cards);
    const card = cards.find((entry) => entry.phaseId === phaseId);
    const phase = ledger.find((entry) => entry.phaseId === phaseId);
    if (!card || !phase) {
      throw phaseError(404, "Phase not found for this FULL run");
    }
    await lockChildProjections(tx, taskId, phaseId);

    if (
      expectedRevision !== undefined &&
      expectedRevision !== run.runRevision
    ) {
      throw phaseError(409, "stale_fence: run revision drifted");
    }

    const now = new Date();

    if (action === "begin") {
      if (phase.state === "done") {
        throw phaseError(409, "phase_progress_invalid: phase already done");
      }
      if (phase.state === "in_progress") {
        if (phase.runId === runId) {
          // Same-row recovery: refresh epoch/audit, no state change, still
          // idempotent through the stored response.
          await tx
            .update(executionPhaseProgressTable)
            .set({
              leaseEpoch: fence.leaseEpoch,
              branchName: run.branchName,
              updatedAt: now,
            })
            .where(eq(executionPhaseProgressTable.id, phase.id));
          const response = {
            phaseId,
            state: "in_progress",
            ordinal: phase.ordinal,
            ledgerVersion: phase.ledgerVersion,
            noop: true,
          };
          await savePhaseIdempotency({
            tx,
            userId,
            runId,
            requestKey,
            requestHash,
            response,
          });
          return response;
        }
        throw phaseError(
          409,
          "phase_progress_active_elsewhere: phase is in_progress under another run",
        );
      }
      const predecessors = ledger.filter(
        (entry) =>
          entry.ordinal < phase.ordinal &&
          cards.find((card_) => card_.phaseId === entry.phaseId)?.required,
      );
      const unmet = predecessors.filter((entry) => entry.state !== "done");
      if (unmet.length > 0) {
        throw phaseError(
          409,
          `phase_progress_predecessor: required predecessors not done: ${unmet
            .map((entry) => entry.phaseId)
            .join(", ")}`,
        );
      }
      const active = ledger.find(
        (entry) => entry.state === "in_progress" && entry.phaseId !== phaseId,
      );
      if (active) {
        throw phaseError(
          409,
          `phase_progress_one_active: phase ${active.phaseId} is still in_progress`,
        );
      }
      const nextVersion = phase.ledgerVersion + 1;
      await tx
        .update(executionPhaseProgressTable)
        .set({
          state: "in_progress",
          runId,
          parentRunId: run.parentRunId ?? phase.parentRunId,
          leaseEpoch: fence.leaseEpoch,
          branchName: run.branchName,
          baseSha: run.baseSha,
          failureKind: null,
          reason: null,
          ledgerVersion: nextVersion,
          updatedAt: now,
        })
        .where(eq(executionPhaseProgressTable.id, phase.id));
      await enqueuePhaseProjections(tx, {
        fullTaskId: taskId,
        phaseId,
        childTaskId: card.childTaskId,
        ledgerVersion: nextVersion,
        columnSlug: "in-progress",
        marker: "⭕ DOING",
        title: cardTitle(titles, phaseId),
      });
      const response = {
        phaseId,
        state: "in_progress",
        ordinal: phase.ordinal,
        ledgerVersion: nextVersion,
        noop: false,
      };
      await savePhaseIdempotency({
        tx,
        userId,
        runId,
        requestKey,
        requestHash,
        response,
      });
      return response;
    }

    if (action === "complete") {
      const checkpointId = input.checkpointId as string;
      if (phase.state !== "in_progress") {
        throw phaseError(
          409,
          `phase_progress_invalid: complete requires in_progress, got ${phase.state}`,
        );
      }
      if (phase.runId && phase.runId !== runId) {
        throw phaseError(
          409,
          "phase_progress_invalid: phase is claimed by a different run",
        );
      }
      const [checkpoint] = await tx
        .select()
        .from(taskRunCheckpointTable)
        .where(eq(taskRunCheckpointTable.id, checkpointId))
        .limit(1);
      if (
        !checkpoint ||
        checkpoint.runId !== runId ||
        checkpoint.taskId !== taskId
      ) {
        throw phaseError(404, "Checkpoint not found for this run");
      }
      // Exact phase/spec/map proof; legacy (nullable) fields never qualify.
      if (checkpoint.phaseId !== phaseId) {
        throw phaseError(409, "phase_checkpoint_mismatch: wrong phase");
      }
      if (
        checkpoint.specSha256 !== card.specSha256 ||
        checkpoint.sourcePhaseMapSha256 !== card.sourcePhaseMapSha256
      ) {
        throw phaseError(
          409,
          "phase_checkpoint_mismatch: spec or source phase map hash mismatch",
        );
      }
      if (!checkpoint.receiptHash) {
        throw phaseError(
          409,
          "phase_checkpoint_mismatch: missing receipt hash",
        );
      }
      // Epoch lineage: an older epoch is fine when it belongs to this run and
      // is not in the future; a different run or a future epoch never proves.
      if (checkpoint.leaseEpoch > fence.leaseEpoch) {
        throw phaseError(
          409,
          "phase_checkpoint_mismatch: checkpoint epoch is in the future",
        );
      }
      // Branch lineage: ledger branch must still be this run's branch.
      if (phase.branchName && phase.branchName !== run.branchName) {
        throw phaseError(
          409,
          "phase_checkpoint_mismatch: phase branch drifted from the run branch",
        );
      }
      // Ancestry: base must continue the previously proven phase commit chain
      // (or the run base for the first proven phase).
      const provenCommits = ledger
        .filter(
          (entry) =>
            entry.ordinal < phase.ordinal &&
            entry.state === "done" &&
            entry.commitSha,
        )
        .map((entry) => entry.commitSha as string);
      const expectedBase =
        provenCommits.length > 0
          ? provenCommits[provenCommits.length - 1]
          : run.baseSha;
      if (
        expectedBase &&
        checkpoint.baseSha &&
        checkpoint.baseSha.toLowerCase() !== expectedBase.toLowerCase()
      ) {
        throw phaseError(
          409,
          "phase_checkpoint_mismatch: checkpoint base does not continue the proven ancestry",
        );
      }
      const nextVersion = phase.ledgerVersion + 1;
      await tx
        .update(executionPhaseProgressTable)
        .set({
          state: "done",
          runId,
          leaseEpoch: fence.leaseEpoch,
          checkpointId,
          commitSha: checkpoint.commitSha,
          branchName: run.branchName,
          baseSha: checkpoint.baseSha ?? phase.baseSha,
          failureKind: null,
          reason: null,
          ledgerVersion: nextVersion,
          updatedAt: now,
        })
        .where(eq(executionPhaseProgressTable.id, phase.id));
      await enqueuePhaseProjections(tx, {
        fullTaskId: taskId,
        phaseId,
        childTaskId: card.childTaskId,
        ledgerVersion: nextVersion,
        columnSlug: "done",
        marker: "✅ DONE",
        title: cardTitle(titles, phaseId),
        commitSha: checkpoint.commitSha,
        checkpointId,
      });
      const response = {
        phaseId,
        state: "done",
        ordinal: phase.ordinal,
        ledgerVersion: nextVersion,
        checkpointId,
      };
      await savePhaseIdempotency({
        tx,
        userId,
        runId,
        requestKey,
        requestHash,
        response,
      });
      return response;
    }

    // action === "block": atomic phase blocked + run blocked_* + evidence +
    // outbox + lease inactive via CAS — one transaction, all or nothing.
    if (phase.state !== "in_progress" || phase.runId !== runId) {
      throw phaseError(
        409,
        "phase_progress_invalid: only the active in_progress phase of this run can block",
      );
    }
    const runState = mapFailureKindToRunState(normalizedBlockKind as string);
    const nextVersion = phase.ledgerVersion + 1;
    await tx
      .update(executionPhaseProgressTable)
      .set({
        state: "blocked",
        runId,
        leaseEpoch: fence.leaseEpoch,
        failureKind: normalizedBlockKind as string,
        reason: reason ?? null,
        ledgerVersion: nextVersion,
        updatedAt: now,
      })
      .where(eq(executionPhaseProgressTable.id, phase.id));
    const [blockedRun] = await tx
      .update(taskRunTable)
      .set({
        state: runState,
        leaseActive: false,
        blocker: reason ?? null,
        failureKind: normalizedBlockKind as string,
        retryAt: retryAt ?? run.retryAt,
        manualRecoveryRequired: true,
        runRevision: sql`${taskRunTable.runRevision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(taskRunTable.id, runId),
          eq(taskRunTable.leaseEpoch, fence.leaseEpoch),
          eq(taskRunTable.leaseTokenHash, hashLeaseToken(input.leaseToken)),
          eq(taskRunTable.leaseActive, true),
          ...(expectedRevision === undefined
            ? []
            : [eq(taskRunTable.runRevision, expectedRevision)]),
        ),
      )
      .returning();
    if (!blockedRun) {
      throw phaseError(409, "stale_fence: lease changed before block");
    }
    await tx.insert(taskRunEvidenceTable).values({
      runId,
      agentPrincipalId: fence.principal.id,
      kind: "phase_block",
      payload: {
        phaseId,
        failureKind: normalizedBlockKind,
        runState,
        reason: reason ?? null,
        retryAt: retryAt ? retryAt.toISOString() : null,
      },
    });
    await enqueueNotificationEvent(tx, {
      taskId,
      runId,
      kind:
        runState === "blocked_quota"
          ? "blocked_quota"
          : runState === "blocked_input" || runState === "blocked_clarification"
            ? "needs_input"
            : "failed",
      payload: {
        taskId,
        runId,
        phaseId,
        finalState: runState,
        failureKind: normalizedBlockKind,
        reason: reason ?? null,
      },
    });
    const response = {
      phaseId,
      state: "blocked",
      runState,
      failureKind: normalizedBlockKind,
      ledgerVersion: nextVersion,
    };
    await savePhaseIdempotency({
      tx,
      userId,
      runId,
      requestKey,
      requestHash,
      response,
    });
    return response;
  });
}

function cardTitle(titles: Map<string, string>, phaseId: string): string {
  return titles.get(phaseId) ?? phaseId;
}

async function loadChildTitles(
  executor: ReadExecutor,
  childTaskIds: string[],
): Promise<Map<string, string>> {
  if (childTaskIds.length === 0) return new Map();
  const rows = await executor
    .select({ id: taskTable.id, title: taskTable.title })
    .from(taskTable)
    .where(inArray(taskTable.id, childTaskIds));
  return new Map(rows.map((row) => [row.id, row.title]));
}

async function childTitleMap(
  executor: ReadExecutor,
  cards: Array<typeof executionPhaseCardTable.$inferSelect>,
): Promise<Map<string, string>> {
  const byPhase = new Map<string, string>();
  const titles = await loadChildTitles(
    executor,
    cards.map((card) => card.childTaskId),
  );
  for (const card of cards) {
    byPhase.set(card.phaseId, titles.get(card.childTaskId) ?? card.phaseId);
  }
  return byPhase;
}

/**
 * POST /phase-progress entry: fenced begin/complete/block/get with
 * deterministic idempotency. Empty stored responses are re-executed, never
 * replayed.
 */
export async function postPhaseProgress(
  input: PhaseProgressInput,
): Promise<Record<string, unknown>> {
  const action = input.action;
  if (
    action !== "get" &&
    action !== "begin" &&
    action !== "complete" &&
    action !== "block"
  ) {
    throw new HTTPException(400, { message: "Invalid phase progress action" });
  }
  return executePhaseMutation(input);
}

// --- reject reset (parent authority, runs inside review transaction) ------

export async function resetPhaseLedgerForReject(
  tx: WriteExecutor,
  fullTaskId: string,
  reason: string,
): Promise<void> {
  const ledger = await lockLedger(tx, fullTaskId);
  const cards = await lockMappingCards(tx, fullTaskId);
  for (const phase of ledger) {
    const card = cards.find((entry) => entry.phaseId === phase.phaseId);
    if (!card) continue;
    await lockChildProjections(tx, fullTaskId, phase.phaseId);
    await tx
      .update(executionPhaseProgressTable)
      .set({
        state: "pending",
        runId: null,
        parentRunId: null,
        leaseEpoch: null,
        checkpointId: null,
        commitSha: null,
        branchName: null,
        baseSha: null,
        reason: reason.slice(0, MAX_REASON_LENGTH),
        failureKind: null,
        ledgerVersion: phase.ledgerVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(executionPhaseProgressTable.id, phase.id));
    await enqueuePhaseProjections(tx, {
      fullTaskId,
      phaseId: phase.phaseId,
      childTaskId: card.childTaskId,
      ledgerVersion: phase.ledgerVersion + 1,
      columnSlug: "to-do",
      marker: "⭕ QUEUED",
      title: card.parserTaskId,
    });
  }
}

// --- central REST/MCP guard middleware ------------------------------------

type GuardApiKey = { id?: string } | undefined;

/** Shared agent-principal request detection: API-key callers are agents. */
export function requestActorIsAgent(c: Context): boolean {
  return Boolean(c.get("apiKey") as GuardApiKey);
}

function actorIsAgent(c: Context): boolean {
  return requestActorIsAgent(c);
}

/**
 * Phase-child guard for REST write surfaces. Because MCP mutator tools call
 * these same routes with the same auth, this single middleware covers REST
 * and MCP alike. Phase children are unconditional deny; the FULL task itself
 * denies agent principals (API-key callers) — human session callers keep
 * manual parent authority.
 */
export function phaseCardTaskGuard(taskIdSource: "param" | "body", key = "id") {
  return async (c: Context, next: Next) => {
    let taskId: string | undefined;
    if (taskIdSource === "param") {
      taskId = c.req.param(key);
    } else {
      const body = await c.req.json().catch(() => ({}));
      const value = (body as Record<string, unknown>)[key];
      taskId = typeof value === "string" ? value : undefined;
    }
    if (!taskId) return next();
    const context = await getPhaseCardContext(db, taskId);
    if (context.isPhaseChild) {
      throw phaseError(
        409,
        "phase_card_guard: target task is a phase child card",
      );
    }
    if (context.isFullRun && actorIsAgent(c)) {
      throw phaseError(
        409,
        "use_phase_progress: agent principals must not generically mutate a FULL run task",
      );
    }
    return next();
  };
}

/** Guard for relation/label surfaces that reference tasks in a body. */
export async function assertRelationTargetsGuard(
  executor: ReadExecutor,
  input: {
    sourceTaskId?: string;
    targetTaskId?: string;
    actorIsAgent: boolean;
  },
): Promise<void> {
  const ids = [input.sourceTaskId, input.targetTaskId].filter(
    (id): id is string => Boolean(id),
  );
  for (const id of ids) {
    const context = await getPhaseCardContext(executor, id);
    if (context.isPhaseChild) {
      throw phaseError(
        409,
        "phase_card_guard: relations for phase child cards are owned by the graph transaction",
      );
    }
    if (context.isFullRun && input.actorIsAgent) {
      throw phaseError(
        409,
        "use_phase_progress: agent principals must not forge relations on a FULL run task",
      );
    }
  }
}

/** Guard for label mutation where the label is attached to a task. */
export async function assertLabelTaskGuard(
  executor: ReadExecutor,
  input: { taskId?: string | null; actorIsAgent: boolean },
): Promise<void> {
  if (!input.taskId) return;
  const context = await getPhaseCardContext(executor, input.taskId);
  if (context.isPhaseChild) {
    throw phaseError(
      409,
      "phase_card_guard: labels on phase child cards are projections",
    );
  }
  if (context.isFullRun && input.actorIsAgent) {
    throw phaseError(
      409,
      "use_phase_progress: agent principals must not mutate labels on a FULL run task",
    );
  }
}

/** Guard for create_task / import while a FULL graph is active in a project. */
export async function assertProjectTaskCreationGuard(
  executor: ReadExecutor,
  input: { projectId: string; actorIsAgent: boolean },
): Promise<void> {
  if (!input.actorIsAgent) return;
  const active = await projectHasActiveFullGraph(executor, input.projectId);
  if (active) {
    throw phaseError(
      409,
      "use_phase_progress: agent principals cannot create tasks while a FULL graph is active; use the graph publish API",
    );
  }
}

/** Guard for bulk task operations (deny any phase child / agent-FULL mix). */
export async function assertBulkTaskIdsGuard(
  executor: ReadExecutor,
  input: { taskIds: string[]; actorIsAgent: boolean },
): Promise<void> {
  for (const id of [...new Set(input.taskIds)]) {
    const context = await getPhaseCardContext(executor, id);
    if (context.isPhaseChild) {
      throw phaseError(
        409,
        "phase_card_guard: bulk operations cannot target phase child cards",
      );
    }
    if (context.isFullRun && input.actorIsAgent) {
      throw phaseError(
        409,
        "use_phase_progress: agent principals must not generically mutate a FULL run task",
      );
    }
  }
}

/** Guard for comment surfaces resolving a comment id back to its task. */
export async function assertCommentMutationGuard(
  executor: ReadExecutor,
  input: { commentId: string; actorIsAgent: boolean },
): Promise<void> {
  const [row] = await executor
    .select({ taskId: commentTable.taskId })
    .from(commentTable)
    .where(eq(commentTable.id, input.commentId))
    .limit(1);
  if (!row) return;
  const context = await getPhaseCardContext(executor, row.taskId);
  if (context.isPhaseChild) {
    throw phaseError(
      409,
      "phase_card_guard: comments on phase child cards are ledger projections",
    );
  }
  if (context.isFullRun && input.actorIsAgent) {
    throw phaseError(
      409,
      "use_phase_progress: agent principals must not comment on a FULL run task outside fenced operations",
    );
  }
}

// Re-exported for the finalization gate and routes.
export {
  executionPhaseCardTable,
  executionPhaseProgressTable,
  executionPhaseProjectionTable,
};
