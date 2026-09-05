// SPEC-kaneo-phase-cards-full-run-server-v0-1 (T1): dedicated FULL-run phase
// checkpoint endpoint. A phase checkpoint extends the durable task-run
// checkpoint with phase/spec/source-map provenance and a receipt hash; it is
// the only proof accepted by phase `complete` and the finalization gate.
// Request key: phase-checkpoint:<runId>:<phaseId>:<commitSha>. Both the fresh
// response and the stored idempotency response always carry checkpoint_id.
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  executionIdempotencyTable,
  taskRunCheckpointTable,
  taskRunEvidenceTable,
  taskRunTable,
} from "../database/schema";
import { enqueueNotificationEvent } from "./outbox";
import {
  assertPhaseFence,
  getPhaseCardContext,
  lockFullTask,
  lockLedger,
  lockMappingCards,
  phaseError,
  requirePhaseRequestKey,
  type WriteExecutor,
} from "./phase-progress";
import {
  canonicalSha256,
  getLeaseExpiry,
  hashLeaseToken,
  stableHash,
  validateGitSha,
  validateJsonObject,
  validateRevision,
} from "./validation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const PHASE_CHECKPOINT_OPERATION = "execution.phase_checkpoint";
const REQUIRED_RECEIPT_FIELDS = [
  "receiptId",
  "remoteRef",
  "headSha",
  "commitSha",
  "receiptHash",
] as const;

export type PhaseCheckpointInput = {
  taskId: string;
  runId: string;
  userId: string;
  leaseEpoch: number;
  leaseToken: string;
  phaseId: string;
  headSha: string;
  commitSha: string;
  baseSha?: string;
  guardReceipt: Record<string, unknown>;
  commands?: string[];
  artifactHashes?: Record<string, unknown>;
  expectedRunRevision?: unknown;
  requestKey: string;
};

export function phaseCheckpointRequestKey(
  runId: string,
  phaseId: string,
  commitSha: string,
): string {
  return `phase-checkpoint:${runId}:${phaseId}:${commitSha}`;
}

function checkpointResponse(
  checkpoint: typeof taskRunCheckpointTable.$inferSelect,
): Record<string, unknown> {
  return {
    checkpointId: checkpoint.id,
    runId: checkpoint.runId,
    phaseId: checkpoint.phaseId,
    headSha: checkpoint.headSha,
    commitSha: checkpoint.commitSha,
    baseSha: checkpoint.baseSha,
    receiptHash: checkpoint.receiptHash,
    specSha256: checkpoint.specSha256,
    sourcePhaseMapSha256: checkpoint.sourcePhaseMapSha256,
  };
}

/**
 * Persist a fenced phase checkpoint. The server supplies spec/source-map
 * hashes from the stored graph mapping — the worker cannot declare them — and
 * the row records the canonical guard receipt hash for phase `complete` and
 * the finalization gate.
 */
export async function createPhaseCheckpoint(
  input: PhaseCheckpointInput,
): Promise<Record<string, unknown>> {
  const normalizedHeadSha = validateGitSha(input.headSha, "headSha");
  const normalizedCommitSha = validateGitSha(input.commitSha, "commitSha");
  const normalizedBaseSha = validateGitSha(input.baseSha, "baseSha");
  if (!normalizedHeadSha || !normalizedCommitSha) {
    throw new HTTPException(400, {
      message: "headSha and commitSha are required for a phase checkpoint",
    });
  }
  if (normalizedHeadSha.toLowerCase() !== normalizedCommitSha.toLowerCase()) {
    throw phaseError(
      409,
      "headSha must equal commitSha: the push is not verified as durable on the remote",
    );
  }
  const receipt = validateJsonObject(input.guardReceipt, "guardReceipt");
  for (const field of REQUIRED_RECEIPT_FIELDS) {
    if (typeof receipt[field] !== "string" || !receipt[field]) {
      throw new HTTPException(400, {
        message: `guardReceipt.${field} is required`,
      });
    }
  }
  const phaseId =
    typeof input.phaseId === "string" && input.phaseId.trim()
      ? input.phaseId.trim()
      : "";
  if (!phaseId || phaseId.length > 64) {
    throw new HTTPException(400, {
      message: "phaseId must be a bounded string",
    });
  }
  const receiptHash = canonicalSha256(receipt);
  const expectedRevision = validateRevision(
    input.expectedRunRevision,
    "expectedRunRevision",
  );
  const requestKey = requirePhaseRequestKey(input.requestKey);
  const requestHash = stableHash({
    taskId: input.taskId,
    runId: input.runId,
    phaseId,
    headSha: normalizedHeadSha,
    commitSha: normalizedCommitSha,
    baseSha: normalizedBaseSha ?? null,
    receiptHash,
    expectedRunRevision: expectedRevision ?? null,
  });

  return db.transaction(async (tx: Tx & WriteExecutor) => {
    // Reserve first; an empty stored response (crash between reserve and
    // save) is rebuilt from the checkpoint row or re-executed, never replayed.
    const [reserved] = await tx
      .insert(executionIdempotencyTable)
      .values({
        userId: input.userId,
        runId: input.runId,
        operation: PHASE_CHECKPOINT_OPERATION,
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
    if (!reserved) {
      const [record] = await tx
        .select()
        .from(executionIdempotencyTable)
        .where(
          and(
            eq(executionIdempotencyTable.operation, PHASE_CHECKPOINT_OPERATION),
            eq(executionIdempotencyTable.requestKey, requestKey),
          ),
        )
        .limit(1);
      if (!record) {
        throw phaseError(409, "Idempotency-Key reservation was not available");
      }
      if (
        record.userId !== input.userId ||
        record.runId !== input.runId ||
        record.requestHash !== requestHash
      ) {
        throw phaseError(
          409,
          "Idempotency-Key was already used with a different request",
        );
      }
      const stored = record.response as Record<string, unknown>;
      if (stored && Object.keys(stored).length > 0) return stored;
      // Empty stored response: rebuild from the checkpoint row when the
      // previous attempt crashed after the checkpoint write but before the
      // idempotency save.
      const [existing] = await tx
        .select()
        .from(taskRunCheckpointTable)
        .where(eq(taskRunCheckpointTable.requestId, requestKey))
        .limit(1);
      if (existing) {
        const rebuilt = checkpointResponse(existing);
        await tx
          .update(executionIdempotencyTable)
          .set({ response: rebuilt })
          .where(eq(executionIdempotencyTable.id, record.id));
        return rebuilt;
      }
      // No checkpoint row: fall through and re-execute in this request.
    }

    const fence = await assertPhaseFence(tx, {
      taskId: input.taskId,
      runId: input.runId,
      userId: input.userId,
      leaseEpoch: input.leaseEpoch,
      leaseToken: input.leaseToken,
    });
    await lockFullTask(tx, input.taskId);
    const [run] = await tx
      .select()
      .from(taskRunTable)
      .where(eq(taskRunTable.id, input.runId))
      .limit(1)
      .for("update");
    if (!run || run.taskId !== input.taskId) {
      throw phaseError(404, "Task run not found");
    }
    if (
      expectedRevision !== undefined &&
      expectedRevision !== run.runRevision
    ) {
      throw phaseError(409, "stale_fence: run revision drifted");
    }
    const context = await getPhaseCardContext(tx, input.taskId);
    if (!context.isFullRun) {
      throw phaseError(
        409,
        "use_phase_checkpoint: phase checkpoints require a FULL run with a phase map",
      );
    }
    await lockLedger(tx, input.taskId);
    const cards = await lockMappingCards(tx, input.taskId);
    const card = cards.find((entry) => entry.phaseId === phaseId);
    if (!card) {
      throw phaseError(404, "Phase not found for this FULL run");
    }
    if (
      typeof receipt.remoteRef !== "string" ||
      receipt.remoteRef !== run.branchName
    ) {
      throw phaseError(
        409,
        "guardReceipt.remoteRef must equal the run branchName",
      );
    }

    const now = new Date();
    const [checkpoint] = await tx
      .insert(taskRunCheckpointTable)
      .values({
        runId: input.runId,
        taskId: input.taskId,
        requestId: requestKey,
        leaseEpoch: fence.leaseEpoch,
        baseSha: normalizedBaseSha ?? run.baseSha,
        headSha: normalizedHeadSha,
        commitSha: normalizedCommitSha,
        guardReceipt: receipt,
        commands: input.commands ?? [],
        artifactHashes: input.artifactHashes ?? {},
        verifyResult: {},
        phaseId,
        specSha256: card.specSha256,
        sourcePhaseMapSha256: card.sourcePhaseMapSha256,
        receiptHash,
      })
      .returning();
    if (!checkpoint) {
      throw new HTTPException(500, { message: "Phase checkpoint not created" });
    }

    const [updatedRun] = await tx
      .update(taskRunTable)
      .set({
        state: "checkpointed",
        lastCheckpointSha: normalizedHeadSha,
        lastCommitSha: normalizedCommitSha,
        baseSha: normalizedBaseSha ?? run.baseSha,
        leaseActive: true,
        lastHeartbeatAt: now,
        lastProgressAt: now,
        leaseExpiresAt: getLeaseExpiry(now),
        runRevision: sql`${taskRunTable.runRevision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(taskRunTable.id, input.runId),
          eq(taskRunTable.leaseEpoch, fence.leaseEpoch),
          eq(taskRunTable.leaseTokenHash, hashLeaseToken(input.leaseToken)),
          eq(taskRunTable.leaseActive, true),
        ),
      )
      .returning();
    if (!updatedRun) {
      throw phaseError(409, "stale_fence: lease changed before checkpoint");
    }

    await tx.insert(taskRunEvidenceTable).values({
      runId: input.runId,
      agentPrincipalId: fence.principal.id,
      kind: "phase_checkpoint",
      payload: {
        checkpointId: checkpoint.id,
        phaseId,
        headSha: normalizedHeadSha,
        commitSha: normalizedCommitSha,
        baseSha: normalizedBaseSha ?? null,
        receiptId: receipt.receiptId,
      },
    });
    await enqueueNotificationEvent(tx, {
      taskId: input.taskId,
      runId: input.runId,
      kind: "checkpoint",
      payload: {
        taskId: input.taskId,
        runId: input.runId,
        phaseId,
        commitSha: normalizedCommitSha.slice(0, 12),
      },
    });

    const response = checkpointResponse(checkpoint);
    await tx
      .update(executionIdempotencyTable)
      .set({ response, agentPrincipalId: fence.principal.id })
      .where(
        and(
          eq(executionIdempotencyTable.userId, input.userId),
          eq(executionIdempotencyTable.runId, input.runId),
          eq(executionIdempotencyTable.operation, PHASE_CHECKPOINT_OPERATION),
          eq(executionIdempotencyTable.requestKey, requestKey),
          eq(executionIdempotencyTable.requestHash, requestHash),
        ),
      );
    return response;
  });
}
