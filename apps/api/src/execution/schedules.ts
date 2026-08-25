// Execution schedule service — SPEC-KANEO-MULTI-PI-4CMD-v0.1 (T6).
//
// Durable schedules + exactly-once dispatch occurrences. The unique
// occurrence_key is the dispatch fence: two concurrent dispatchers (or a
// dispatcher retrying after a crash) can never create two runs for the same
// fire time. last_dispatch telemetry is never the dedup mechanism.
//
// v1 scope: one-shot notBefore schedules; cron is rejected fail-closed.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  agentPrincipalTable,
  executionScheduleOccurrenceTable,
  executionScheduleTable,
  taskRunTable,
  taskTable,
} from "../database/schema";
import { publishEvent } from "../events";
import {
  claimTaskRun,
  type ExecutionTransaction,
  publishTaskRunUpdated,
  type ScheduleRunModelPolicy,
} from "./service";
import {
  assertScheduleShape,
  occurrenceKey,
  type SCHEDULE_OCCURRENCE_STATES,
  ScheduleEligibilityError,
  stableHash,
  validateModelId,
  validateRetryPolicy,
  validateSchedulePolicy,
} from "./validation";

type OccurrenceState = (typeof SCHEDULE_OCCURRENCE_STATES)[number];

function scheduleRequestHash(input: {
  taskId: string;
  projectId: string;
  userId: string;
  notBefore: Date;
  host: string;
  preferredModel: string | null;
  fallbackModels: string[];
  fallbackMode: string;
  maxRuntimeSeconds: number;
  concurrencyKey: string;
  retryPolicy: Record<string, number>;
}) {
  return stableHash({
    taskId: input.taskId,
    projectId: input.projectId,
    userId: input.userId,
    notBefore: input.notBefore.toISOString(),
    host: input.host,
    preferredModel: input.preferredModel,
    fallbackModels: input.fallbackModels,
    fallbackMode: input.fallbackMode,
    maxRuntimeSeconds: input.maxRuntimeSeconds,
    concurrencyKey: input.concurrencyKey,
    retryPolicy: input.retryPolicy,
  });
}

export async function getScheduleById(scheduleId: string) {
  const [schedule] = await db
    .select()
    .from(executionScheduleTable)
    .where(eq(executionScheduleTable.id, scheduleId))
    .limit(1);
  if (!schedule) {
    throw new HTTPException(404, { message: "schedule not found" });
  }
  return schedule;
}

export async function getTaskProjectId(taskId: string) {
  const [task] = await db
    .select({ id: taskTable.id, projectId: taskTable.projectId })
    .from(taskTable)
    .where(eq(taskTable.id, taskId))
    .limit(1);
  if (!task) {
    throw new HTTPException(404, { message: "task not found" });
  }
  return task;
}

export interface CreateScheduleInput {
  taskId: string;
  projectId: string;
  userId: string;
  requestKey: string;
  notBefore: Date;
  host?: unknown;
  preferredModel?: string | null;
  fallbackMode?: unknown;
  fallbackModels?: unknown;
  maxRuntimeSeconds: unknown;
  concurrencyKey?: unknown;
  retryPolicy?: unknown;
}

export async function createExecutionSchedule(input: CreateScheduleInput) {
  assertScheduleShape({
    notBefore: input.notBefore,
    cronExpr: undefined,
  });
  if (!input.requestKey || input.requestKey.length > 200) {
    throw new HTTPException(400, {
      message: "Idempotency-Key is required and must be <= 200 characters",
    });
  }
  const policy = validateSchedulePolicy({
    host: input.host,
    maxRuntimeSeconds: input.maxRuntimeSeconds,
    fallbackMode: input.fallbackMode,
    fallbackModels: input.fallbackModels,
    concurrencyKey: input.concurrencyKey,
  });
  const retryPolicy = validateRetryPolicy(input.retryPolicy);
  const preferredModel =
    input.preferredModel === undefined || input.preferredModel === null
      ? null
      : validateModelId(input.preferredModel, "preferredModel");
  if (policy.fallbackMode === "preapproved" && preferredModel === null) {
    throw new HTTPException(400, {
      message: "preapproved fallback requires a preferredModel",
    });
  }

  const [existingByRequest] = await db
    .select()
    .from(executionScheduleTable)
    .where(eq(executionScheduleTable.requestKey, input.requestKey))
    .limit(1);
  if (existingByRequest) {
    const existingHash = scheduleRequestHash({
      taskId: existingByRequest.taskId,
      projectId: existingByRequest.projectId,
      userId: existingByRequest.createdByUserId,
      notBefore: existingByRequest.notBefore,
      host: existingByRequest.host,
      preferredModel: existingByRequest.preferredModel,
      fallbackModels: existingByRequest.fallbackModels,
      fallbackMode: existingByRequest.fallbackMode,
      maxRuntimeSeconds: existingByRequest.maxRuntimeSeconds,
      concurrencyKey: existingByRequest.concurrencyKey,
      retryPolicy: existingByRequest.retryPolicy as Record<string, number>,
    });
    const requestedHash = scheduleRequestHash({
      taskId: input.taskId,
      projectId: input.projectId,
      userId: input.userId,
      notBefore: input.notBefore,
      host: policy.host,
      preferredModel,
      fallbackModels: policy.fallbackModels,
      fallbackMode: policy.fallbackMode,
      maxRuntimeSeconds: policy.maxRuntimeSeconds,
      concurrencyKey: policy.concurrencyKey,
      retryPolicy,
    });
    if (existingHash !== requestedHash) {
      throw new HTTPException(409, {
        message: "Idempotency-Key was already used with a different schedule",
      });
    }
    return existingByRequest;
  }

  const [task] = await db
    .select({ id: taskTable.id, projectId: taskTable.projectId })
    .from(taskTable)
    .where(eq(taskTable.id, input.taskId))
    .limit(1);
  if (!task) {
    throw new HTTPException(404, { message: "task not found" });
  }
  if (task.projectId !== input.projectId) {
    throw new HTTPException(400, {
      message: "task does not belong to the given project",
    });
  }

  const [createdSchedule] = await db
    .insert(executionScheduleTable)
    .values({
      id: createId(),
      taskId: input.taskId,
      projectId: input.projectId,
      createdByUserId: input.userId,
      requestKey: input.requestKey,
      notBefore: input.notBefore,
      host: policy.host,
      preferredModel,
      fallbackModels: policy.fallbackModels,
      fallbackMode: policy.fallbackMode,
      maxRuntimeSeconds: policy.maxRuntimeSeconds,
      retryPolicy,
      concurrencyKey: policy.concurrencyKey,
      nextDispatchAt: input.notBefore,
    })
    .onConflictDoNothing({ target: executionScheduleTable.requestKey })
    .returning();
  if (!createdSchedule) {
    const [racedSchedule] = await db
      .select()
      .from(executionScheduleTable)
      .where(eq(executionScheduleTable.requestKey, input.requestKey))
      .limit(1);
    if (racedSchedule) {
      const racedHash = scheduleRequestHash({
        taskId: racedSchedule.taskId,
        projectId: racedSchedule.projectId,
        userId: racedSchedule.createdByUserId,
        notBefore: racedSchedule.notBefore,
        host: racedSchedule.host,
        preferredModel: racedSchedule.preferredModel,
        fallbackModels: racedSchedule.fallbackModels,
        fallbackMode: racedSchedule.fallbackMode,
        maxRuntimeSeconds: racedSchedule.maxRuntimeSeconds,
        concurrencyKey: racedSchedule.concurrencyKey,
        retryPolicy: racedSchedule.retryPolicy as Record<string, number>,
      });
      const requestedHash = scheduleRequestHash({
        taskId: input.taskId,
        projectId: input.projectId,
        userId: input.userId,
        notBefore: input.notBefore,
        host: policy.host,
        preferredModel,
        fallbackModels: policy.fallbackModels,
        fallbackMode: policy.fallbackMode,
        maxRuntimeSeconds: policy.maxRuntimeSeconds,
        concurrencyKey: policy.concurrencyKey,
        retryPolicy,
      });
      if (racedHash === requestedHash) return racedSchedule;
    }
    throw new HTTPException(409, {
      message: "Idempotency-Key was already used for another schedule",
    });
  }

  await publishEvent("execution.schedule.created", {
    scheduleId: createdSchedule.id,
    taskId: createdSchedule.taskId,
    notBefore: createdSchedule.notBefore.toISOString(),
  });
  return createdSchedule;
}

export async function listDueSchedules(input: { host: string; now?: Date }) {
  const now = input.now ?? new Date();
  return db
    .select({
      id: executionScheduleTable.id,
      taskId: executionScheduleTable.taskId,
      projectId: executionScheduleTable.projectId,
      notBefore: executionScheduleTable.notBefore,
      timezone: executionScheduleTable.timezone,
      host: executionScheduleTable.host,
      preferredModel: executionScheduleTable.preferredModel,
      fallbackModels: executionScheduleTable.fallbackModels,
      fallbackMode: executionScheduleTable.fallbackMode,
      maxRuntimeSeconds: executionScheduleTable.maxRuntimeSeconds,
      retryPolicy: executionScheduleTable.retryPolicy,
      concurrencyKey: executionScheduleTable.concurrencyKey,
      enabled: executionScheduleTable.enabled,
      lastDispatchAt: executionScheduleTable.lastDispatchAt,
      nextDispatchAt: executionScheduleTable.nextDispatchAt,
    })
    .from(executionScheduleTable)
    .where(
      and(
        eq(executionScheduleTable.enabled, true),
        eq(executionScheduleTable.host, input.host),
        lte(executionScheduleTable.notBefore, now),
        or(
          isNull(executionScheduleTable.nextDispatchAt),
          lte(executionScheduleTable.nextDispatchAt, now),
        ),
      ),
    );
}

const OCCURRENCE_RECLAIM_AFTER_MS = 60_000;

export interface ClaimOccurrenceResult {
  occurrenceId: string;
  occurrenceKey: string;
  state: OccurrenceState;
  runId: string | null;
  claimGeneration: number;
  claimedBy: string | null;
  newlyClaimed: boolean;
}

/**
 * Exactly-once claim. Concurrent callers race on the unique occurrence_key;
 * the loser receives the existing occurrence and must NOT create a second run.
 * A crashed dispatcher retry reads the existing occurrence (runId already
 * bound or claim already taken) and reconciles instead of re-dispatching.
 */
export async function claimScheduleOccurrence(
  input: {
    scheduleId: string;
    scheduledFor: Date;
    claimedBy: string;
    now?: Date;
  },
  transaction?: ExecutionTransaction,
): Promise<ClaimOccurrenceResult> {
  const key = occurrenceKey(input.scheduleId, input.scheduledFor);
  const now = input.now ?? new Date();
  const execute = async (
    tx: ExecutionTransaction,
  ): Promise<ClaimOccurrenceResult> => {
    // Lock an existing occurrence before deciding whether a failed/stale
    // claim may be retried. The unique key handles the not-found insert race.
    const [existing] = await tx
      .select()
      .from(executionScheduleOccurrenceTable)
      .where(eq(executionScheduleOccurrenceTable.occurrenceKey, key))
      .limit(1)
      .for("update");

    if (existing) {
      const retryable =
        existing.state === "planned" || existing.state === "failed";
      const staleClaim =
        existing.state === "claimed" &&
        existing.runId === null &&
        (!existing.claimedAt ||
          now.getTime() - existing.claimedAt.getTime() >=
            OCCURRENCE_RECLAIM_AFTER_MS);

      if (retryable || staleClaim) {
        const [claimed] = await tx
          .update(executionScheduleOccurrenceTable)
          .set({
            state: "claimed",
            claimedBy: input.claimedBy,
            claimedAt: now,
            claimGeneration: existing.claimGeneration + 1,
            failureReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(executionScheduleOccurrenceTable.id, existing.id),
              eq(executionScheduleOccurrenceTable.state, existing.state),
            ),
          )
          .returning();
        if (claimed) {
          return {
            occurrenceId: claimed.id,
            occurrenceKey: key,
            state: "claimed",
            runId: claimed.runId,
            claimGeneration: claimed.claimGeneration,
            claimedBy: claimed.claimedBy,
            newlyClaimed: true,
          };
        }
      }
      return {
        occurrenceId: existing.id,
        occurrenceKey: key,
        state: existing.state as OccurrenceState,
        runId: existing.runId,
        claimGeneration: existing.claimGeneration,
        claimedBy: existing.claimedBy,
        newlyClaimed: false,
      };
    }

    const [created] = await tx
      .insert(executionScheduleOccurrenceTable)
      .values({
        id: createId(),
        scheduleId: input.scheduleId,
        occurrenceKey: key,
        scheduledFor: input.scheduledFor,
        state: "claimed",
        claimedBy: input.claimedBy,
        claimedAt: now,
        claimGeneration: 1,
      })
      .onConflictDoNothing({
        target: executionScheduleOccurrenceTable.occurrenceKey,
      })
      .returning();

    if (created) {
      return {
        occurrenceId: created.id,
        occurrenceKey: key,
        state: "claimed",
        runId: created.runId,
        claimGeneration: created.claimGeneration,
        claimedBy: created.claimedBy,
        newlyClaimed: true,
      };
    }

    // Unique conflict: read the winner's occurrence and reconcile.
    const [winner] = await tx
      .select()
      .from(executionScheduleOccurrenceTable)
      .where(eq(executionScheduleOccurrenceTable.occurrenceKey, key))
      .limit(1);
    if (!winner) {
      throw new HTTPException(500, {
        message: "occurrence unique conflict but row not found",
      });
    }
    return {
      occurrenceId: winner.id,
      occurrenceKey: key,
      state: winner.state as OccurrenceState,
      runId: winner.runId,
      claimGeneration: winner.claimGeneration,
      claimedBy: winner.claimedBy,
      newlyClaimed: false,
    };
  };
  return transaction
    ? await execute(transaction)
    : await db.transaction(execute);
}

export async function markOccurrenceDispatched(
  input: {
    occurrenceId: string;
    runId: string;
    claimGeneration: number;
    claimedBy: string;
  },
  transaction?: ExecutionTransaction,
  ackToken?: string,
) {
  const executor = transaction ?? db;
  const values: {
    state: "dispatched";
    runId: string;
    failureReason: null;
    updatedAt: Date;
    ackTokenHash?: string;
  } = {
    state: "dispatched",
    runId: input.runId,
    failureReason: null,
    updatedAt: new Date(),
  };
  if (ackToken) values.ackTokenHash = stableHash(ackToken);
  const [updated] = await executor
    .update(executionScheduleOccurrenceTable)
    .set(values)
    .where(
      and(
        eq(executionScheduleOccurrenceTable.id, input.occurrenceId),
        eq(executionScheduleOccurrenceTable.state, "claimed"),
        eq(
          executionScheduleOccurrenceTable.claimGeneration,
          input.claimGeneration,
        ),
        eq(executionScheduleOccurrenceTable.claimedBy, input.claimedBy),
      ),
    )
    .returning();
  if (!updated) {
    throw new HTTPException(409, {
      message: "occurrence is no longer in claimed state",
    });
  }
  return updated;
}

async function issueDispatchAckToken(
  input: {
    occurrenceId: string;
    runId: string;
    now?: Date;
  },
  transaction?: ExecutionTransaction,
) {
  const token = randomBytes(32).toString("base64url");
  const executor = transaction ?? db;
  const [updated] = await executor
    .update(executionScheduleOccurrenceTable)
    .set({
      ackTokenHash: stableHash(token),
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        eq(executionScheduleOccurrenceTable.id, input.occurrenceId),
        eq(executionScheduleOccurrenceTable.state, "dispatched"),
        eq(executionScheduleOccurrenceTable.runId, input.runId),
      ),
    )
    .returning({ id: executionScheduleOccurrenceTable.id });
  if (!updated) {
    throw new HTTPException(409, {
      message: "schedule occurrence is not ready for dispatch acknowledgement",
    });
  }
  return token;
}

function matchesAckToken(expectedHash: string | null, token: string): boolean {
  if (!expectedHash || token.length > 200) return false;
  const expected = Buffer.from(expectedHash, "utf8");
  const actual = Buffer.from(stableHash(token), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function acknowledgeScheduleDispatch(input: {
  scheduleId: string;
  occurrenceId: string;
  runId: string;
  userId: string;
  agentPrincipalId: string;
  ackToken: string;
}) {
  return db.transaction(async (tx) => {
    const [occurrence] = await tx
      .select({
        id: executionScheduleOccurrenceTable.id,
        scheduleId: executionScheduleOccurrenceTable.scheduleId,
        state: executionScheduleOccurrenceTable.state,
        runId: executionScheduleOccurrenceTable.runId,
        ackTokenHash: executionScheduleOccurrenceTable.ackTokenHash,
      })
      .from(executionScheduleOccurrenceTable)
      .where(eq(executionScheduleOccurrenceTable.id, input.occurrenceId))
      .limit(1)
      .for("update");
    if (
      !occurrence ||
      occurrence.scheduleId !== input.scheduleId ||
      occurrence.state !== "dispatched" ||
      occurrence.runId !== input.runId
    ) {
      throw new HTTPException(409, {
        message:
          "schedule occurrence is not ready for dispatch acknowledgement",
      });
    }

    const [schedule] = await tx
      .select({
        id: executionScheduleTable.id,
        host: executionScheduleTable.host,
      })
      .from(executionScheduleTable)
      .where(eq(executionScheduleTable.id, input.scheduleId))
      .limit(1)
      .for("update");
    if (!schedule) {
      throw new HTTPException(404, { message: "schedule not found" });
    }

    const [run] = await tx
      .select({
        agentPrincipalId: taskRunTable.agentPrincipalId,
        hostId: taskRunTable.hostId,
      })
      .from(taskRunTable)
      .where(
        and(
          eq(taskRunTable.id, input.runId),
          eq(taskRunTable.scheduleId, input.scheduleId),
        ),
      )
      .limit(1);
    if (!run || run.agentPrincipalId !== input.agentPrincipalId) {
      throw new HTTPException(409, {
        message: "dispatch acknowledgement principal does not match the run",
      });
    }

    const [principal] = await tx
      .select({
        hostId: agentPrincipalTable.hostId,
        scopes: agentPrincipalTable.scopes,
      })
      .from(agentPrincipalTable)
      .where(
        and(
          eq(agentPrincipalTable.id, input.agentPrincipalId),
          eq(agentPrincipalTable.userId, input.userId),
          eq(agentPrincipalTable.isActive, true),
        ),
      )
      .limit(1);
    if (!principal) {
      throw new HTTPException(403, {
        message: "Agent principal is not active or not owned by this user",
      });
    }
    if (
      principal.hostId !== schedule.host ||
      run.hostId !== schedule.host ||
      !principal.scopes.includes("run:claim")
    ) {
      throw new HTTPException(403, {
        message: "Dispatch acknowledgement host or scope is invalid",
      });
    }
    if (!matchesAckToken(occurrence.ackTokenHash, input.ackToken)) {
      throw new HTTPException(401, {
        message: "Dispatch acknowledgement token is invalid",
      });
    }

    const [updated] = await tx
      .update(executionScheduleTable)
      .set({ enabled: false, nextDispatchAt: null, updatedAt: new Date() })
      .where(eq(executionScheduleTable.id, input.scheduleId))
      .returning();
    if (!updated) {
      throw new HTTPException(404, { message: "schedule not found" });
    }
    return updated;
  });
}

export async function markOccurrenceFailed(input: {
  occurrenceId: string;
  reason: string;
  claimGeneration: number;
  claimedBy: string;
}) {
  const [updated] = await db
    .update(executionScheduleOccurrenceTable)
    .set({
      state: "failed",
      failureReason: input.reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(executionScheduleOccurrenceTable.id, input.occurrenceId),
        eq(executionScheduleOccurrenceTable.state, "claimed"),
        eq(
          executionScheduleOccurrenceTable.claimGeneration,
          input.claimGeneration,
        ),
        eq(executionScheduleOccurrenceTable.claimedBy, input.claimedBy),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function getOccurrenceByRun(runId: string) {
  const [occurrence] = await db
    .select()
    .from(executionScheduleOccurrenceTable)
    .where(eq(executionScheduleOccurrenceTable.runId, runId))
    .limit(1);
  return occurrence ?? null;
}

export interface DispatchOutcome {
  scheduleId: string;
  occurrenceId: string;
  runId: string | null;
  outcome:
    | "dispatched"
    | "already_dispatched"
    | "reconciled_existing_run"
    | "no_op";
  reason?: string;
  ackToken?: string;
}

const TERMINAL_SCHEDULE_RUN_STATES = new Set([
  "in_review",
  "blocked",
  "done",
  "rejected",
  "failed",
  "cancelled",
  "superseded",
]);

async function getOccurrenceRun(runId: string) {
  const [run] = await db
    .select({ id: taskRunTable.id, state: taskRunTable.state })
    .from(taskRunTable)
    .where(eq(taskRunTable.id, runId))
    .limit(1);
  return run ?? null;
}

async function getRunByRequestKey(requestKey: string) {
  const [run] = await db
    .select({
      id: taskRunTable.id,
      state: taskRunTable.state,
      scheduleId: taskRunTable.scheduleId,
    })
    .from(taskRunTable)
    .where(eq(taskRunTable.requestKey, requestKey))
    .limit(1);
  return run ?? null;
}

async function getOccurrenceByKey(key: string) {
  const [occurrence] = await db
    .select()
    .from(executionScheduleOccurrenceTable)
    .where(eq(executionScheduleOccurrenceTable.occurrenceKey, key))
    .limit(1);
  return occurrence ?? null;
}

async function disableOneShotSchedule(scheduleId: string, now = new Date()) {
  await db
    .update(executionScheduleTable)
    .set({ enabled: false, nextDispatchAt: null, updatedAt: now })
    .where(eq(executionScheduleTable.id, scheduleId));
}

async function retireMissingOccurrence(input: {
  scheduleId: string;
  occurrenceId: string;
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(executionScheduleOccurrenceTable)
      .set({
        state: "failed",
        runId: null,
        failureReason: input.reason.slice(0, 500),
        updatedAt: now,
      })
      .where(
        and(
          eq(executionScheduleOccurrenceTable.id, input.occurrenceId),
          eq(executionScheduleOccurrenceTable.scheduleId, input.scheduleId),
          eq(executionScheduleOccurrenceTable.state, "dispatched"),
        ),
      )
      .returning({ id: executionScheduleOccurrenceTable.id });
    if (updated) {
      await tx
        .update(executionScheduleTable)
        .set({ enabled: false, nextDispatchAt: null, updatedAt: now })
        .where(eq(executionScheduleTable.id, input.scheduleId));
    }
    return Boolean(updated);
  });
}

async function failOccurrenceAndMaybeDisable(input: {
  scheduleId: string;
  occurrenceId: string;
  claimGeneration: number;
  claimedBy: string;
  reason: string;
  disableSchedule: boolean;
  retryAt?: Date;
}) {
  return db.transaction(async (tx) => {
    const [failed] = await tx
      .update(executionScheduleOccurrenceTable)
      .set({
        state: "failed",
        failureReason: input.reason.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(executionScheduleOccurrenceTable.id, input.occurrenceId),
          eq(executionScheduleOccurrenceTable.state, "claimed"),
          eq(
            executionScheduleOccurrenceTable.claimGeneration,
            input.claimGeneration,
          ),
          eq(executionScheduleOccurrenceTable.claimedBy, input.claimedBy),
        ),
      )
      .returning({ id: executionScheduleOccurrenceTable.id });
    if (failed) {
      if (input.disableSchedule) {
        await tx
          .update(executionScheduleTable)
          .set({ enabled: false, nextDispatchAt: null, updatedAt: new Date() })
          .where(eq(executionScheduleTable.id, input.scheduleId));
      } else if (input.retryAt) {
        await tx
          .update(executionScheduleTable)
          .set({ nextDispatchAt: input.retryAt, updatedAt: new Date() })
          .where(eq(executionScheduleTable.id, input.scheduleId));
      }
    }
    return Boolean(failed);
  });
}

async function markDispatchFailure(input: {
  scheduleId: string;
  occurrenceId: string;
  claimGeneration: number;
  claimedBy: string;
  reason: string;
  disableSchedule: boolean;
  retryAt?: Date;
}) {
  const failed = await failOccurrenceAndMaybeDisable(input);
  if (failed) {
    await publishEvent("execution.schedule.failed", {
      scheduleId: input.scheduleId,
      occurrenceId: input.occurrenceId,
      reason: input.reason.slice(0, 500),
    });
  }
}

type DispatchScheduleContext = {
  schedule: {
    id: string;
    taskId: string;
    host: string;
    enabled: boolean;
    notBefore: Date;
    nextDispatchAt: Date | null;
    preferredModel: string | null;
    fallbackMode: string;
    fallbackModels: string[];
    maxRuntimeSeconds: number;
    concurrencyKey: string;
    retryPolicy: Record<string, number>;
  };
  dispatcherIdentity: {
    userId: string;
    agentPrincipalId: string;
  };
  scope: string[];
  noOpReason?: string;
};

async function dispatchNewOccurrenceAtomically(
  input: DispatchScheduleContext & { now: Date },
): Promise<{
  claim: ClaimOccurrenceResult;
  outcome?: DispatchOutcome;
  runId?: string;
}> {
  const modelPolicy: ScheduleRunModelPolicy = {
    preferredModel: input.schedule.preferredModel,
    fallbackMode: input.schedule.fallbackMode,
    fallbackModels: input.schedule.fallbackModels,
    maxRuntimeSeconds: input.schedule.maxRuntimeSeconds,
    concurrencyKey: input.schedule.concurrencyKey,
    retryPolicy: input.schedule.retryPolicy,
  };
  return db.transaction(async (tx) => {
    const claim = await claimScheduleOccurrence(
      {
        scheduleId: input.schedule.id,
        scheduledFor: input.schedule.notBefore,
        claimedBy: `dispatcher:${input.dispatcherIdentity.agentPrincipalId}`,
        now: input.now,
      },
      tx,
    );
    if (!claim.newlyClaimed) return { claim };

    const failInsideTransaction = async (
      reason: string,
      permanentFailure = false,
    ) => {
      const maxAttempts = input.schedule.retryPolicy.maxAttempts ?? 1;
      const exhausted = claim.claimGeneration >= maxAttempts;
      const disableSchedule = permanentFailure || exhausted;
      const retryAt = disableSchedule
        ? undefined
        : new Date(
            input.now.getTime() +
              (input.schedule.retryPolicy.backoffSeconds ?? 60) * 1_000,
          );
      const [failed] = await tx
        .update(executionScheduleOccurrenceTable)
        .set({
          state: "failed",
          failureReason: reason.slice(0, 500),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(executionScheduleOccurrenceTable.id, claim.occurrenceId),
            eq(executionScheduleOccurrenceTable.state, "claimed"),
            eq(
              executionScheduleOccurrenceTable.claimGeneration,
              claim.claimGeneration,
            ),
            eq(
              executionScheduleOccurrenceTable.claimedBy,
              claim.claimedBy ?? "",
            ),
          ),
        )
        .returning({ id: executionScheduleOccurrenceTable.id });
      if (!failed) {
        throw new HTTPException(409, {
          message:
            "occurrence changed before atomic dispatch failure was recorded",
        });
      }
      await tx
        .update(executionScheduleTable)
        .set(
          disableSchedule
            ? { enabled: false, nextDispatchAt: null, updatedAt: input.now }
            : { nextDispatchAt: retryAt, updatedAt: input.now },
        )
        .where(eq(executionScheduleTable.id, input.schedule.id));
      return {
        claim,
        outcome: {
          scheduleId: input.schedule.id,
          occurrenceId: claim.occurrenceId,
          runId: null,
          outcome: "no_op" as const,
          reason,
        },
      };
    };

    if (input.noOpReason) return failInsideTransaction(input.noOpReason, true);

    try {
      const { run } = await claimTaskRun(
        {
          taskId: input.schedule.taskId,
          userId: input.dispatcherIdentity.userId,
          agentPrincipalId: input.dispatcherIdentity.agentPrincipalId,
          scope: input.scope,
          requestKey: claim.occurrenceKey,
          expectedHostId: input.schedule.host,
          scheduleDispatch: true,
          scheduleId: input.schedule.id,
          concurrencyKey: input.schedule.concurrencyKey,
          modelPolicy,
        },
        tx,
      );
      const ackToken = randomBytes(32).toString("base64url");
      await markOccurrenceDispatched(
        {
          occurrenceId: claim.occurrenceId,
          runId: run.id,
          claimGeneration: claim.claimGeneration,
          claimedBy: claim.claimedBy ?? "",
        },
        tx,
        ackToken,
      );
      await tx
        .update(executionScheduleTable)
        .set({ lastDispatchAt: input.now })
        .where(eq(executionScheduleTable.id, input.schedule.id));
      return {
        claim,
        runId: run.id,
        outcome: {
          scheduleId: input.schedule.id,
          occurrenceId: claim.occurrenceId,
          runId: run.id,
          outcome: "dispatched" as const,
          ackToken,
        },
      };
    } catch (error) {
      const reason =
        error instanceof ScheduleEligibilityError
          ? `schedule_eligibility: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      return failInsideTransaction(
        reason,
        error instanceof ScheduleEligibilityError,
      );
    }
  });
}

/**
 * Dispatch a due schedule exactly once. The occurrence claim happens first;
 * run creation uses the occurrence key as the claimTaskRun requestKey, so a
 * crash before telemetry or worker spawn is recoverable: the due schedule
 * remains enabled until the host acknowledges the stable worker launch, and a
 * retry reconciles the existing occurrence/run instead of creating another.
 */
export async function dispatchScheduleOnce(
  input: DispatchScheduleContext & { now?: Date },
): Promise<DispatchOutcome> {
  const now = input.now ?? new Date();
  if (input.noOpReason && input.noOpReason.length > 500) {
    throw new HTTPException(400, { message: "noOpReason is too long" });
  }
  const modelPolicy: ScheduleRunModelPolicy = {
    preferredModel: input.schedule.preferredModel,
    fallbackMode: input.schedule.fallbackMode,
    fallbackModels: input.schedule.fallbackModels,
    maxRuntimeSeconds: input.schedule.maxRuntimeSeconds,
    concurrencyKey: input.schedule.concurrencyKey,
    retryPolicy: input.schedule.retryPolicy,
  };
  const scheduleOccurrenceKey = occurrenceKey(
    input.schedule.id,
    input.schedule.notBefore,
  );
  if (!input.schedule.enabled) {
    const existing = await getOccurrenceByKey(scheduleOccurrenceKey);
    if (!existing) {
      throw new HTTPException(409, {
        message: "schedule is disabled and has no dispatchable occurrence",
      });
    }
    return {
      scheduleId: input.schedule.id,
      occurrenceId: existing.id,
      runId: existing.runId,
      outcome: "no_op",
      reason: "schedule is disabled",
    };
  }
  if (
    input.schedule.notBefore.getTime() > now.getTime() ||
    (input.schedule.nextDispatchAt !== null &&
      input.schedule.nextDispatchAt.getTime() > now.getTime())
  ) {
    throw new HTTPException(409, {
      message: "schedule is not due yet",
    });
  }
  const atomic = await dispatchNewOccurrenceAtomically({ ...input, now });
  const claim = atomic.claim;
  if (atomic.outcome) {
    if (atomic.outcome.outcome === "dispatched" && atomic.runId) {
      await publishTaskRunUpdated(
        input.schedule.taskId,
        atomic.runId,
        input.dispatcherIdentity.userId,
        "in_progress",
      );
      await publishEvent("execution.schedule.dispatched", {
        scheduleId: input.schedule.id,
        occurrenceId: claim.occurrenceId,
        runId: atomic.runId,
      });
    } else if (atomic.outcome.reason) {
      await publishEvent("execution.schedule.failed", {
        scheduleId: input.schedule.id,
        occurrenceId: claim.occurrenceId,
        reason: atomic.outcome.reason.slice(0, 500),
      });
    }
    return atomic.outcome;
  }

  if (!claim.newlyClaimed) {
    if (!claim.runId && claim.state === "dispatched") {
      await retireMissingOccurrence({
        scheduleId: input.schedule.id,
        occurrenceId: claim.occurrenceId,
        reason: "dispatched occurrence points to a missing run",
        now,
      });
      return {
        scheduleId: input.schedule.id,
        occurrenceId: claim.occurrenceId,
        runId: null,
        outcome: "no_op",
        reason: "dispatched occurrence points to a missing run",
      };
    }

    if (!claim.runId && claim.state === "claimed") {
      // A crash may have committed the run before the occurrence binding.
      // Repair that split-brain state immediately from the occurrence request
      // key instead of waiting for the stale-claim timeout.
      const pendingRun = await getRunByRequestKey(claim.occurrenceKey);
      if (pendingRun && pendingRun.scheduleId === input.schedule.id) {
        if (TERMINAL_SCHEDULE_RUN_STATES.has(pendingRun.state)) {
          await markDispatchFailure({
            scheduleId: input.schedule.id,
            occurrenceId: claim.occurrenceId,
            claimGeneration: claim.claimGeneration,
            claimedBy: claim.claimedBy ?? "",
            reason: `scheduled run is already terminal: ${pendingRun.state}`,
            disableSchedule: true,
          });
          return {
            scheduleId: input.schedule.id,
            occurrenceId: claim.occurrenceId,
            runId: pendingRun.id,
            outcome: "no_op",
            reason: `scheduled run is already terminal: ${pendingRun.state}`,
          };
        }
        await markOccurrenceDispatched({
          occurrenceId: claim.occurrenceId,
          runId: pendingRun.id,
          claimGeneration: claim.claimGeneration,
          claimedBy: claim.claimedBy ?? "",
        });
        const ackToken = await issueDispatchAckToken({
          occurrenceId: claim.occurrenceId,
          runId: pendingRun.id,
          now,
        });
        await db
          .update(executionScheduleTable)
          .set({ lastDispatchAt: now })
          .where(eq(executionScheduleTable.id, input.schedule.id));
        return {
          scheduleId: input.schedule.id,
          occurrenceId: claim.occurrenceId,
          runId: pendingRun.id,
          outcome: "reconciled_existing_run",
          ackToken,
        };
      }
    }

    if (claim.runId) {
      const existingRun = await getOccurrenceRun(claim.runId);
      if (!existingRun) {
        await retireMissingOccurrence({
          scheduleId: input.schedule.id,
          occurrenceId: claim.occurrenceId,
          reason: "dispatched occurrence points to a missing run",
          now,
        });
        return {
          scheduleId: input.schedule.id,
          occurrenceId: claim.occurrenceId,
          runId: null,
          outcome: "no_op",
          reason: "dispatched occurrence points to a missing run",
        };
      }
      if (TERMINAL_SCHEDULE_RUN_STATES.has(existingRun.state)) {
        await disableOneShotSchedule(input.schedule.id, now);
        return {
          scheduleId: input.schedule.id,
          occurrenceId: claim.occurrenceId,
          runId: claim.runId,
          outcome: "no_op",
          reason: `scheduled run is already terminal: ${existingRun.state}`,
        };
      }

      // Re-enter the normal schedule claim path. If the dispatcher died and
      // the lease expired (or was revoked), claimTaskRun recovers the same run
      // with a new fencing epoch; it never creates a second run for this key.
      try {
        const { run } = await claimTaskRun({
          taskId: input.schedule.taskId,
          userId: input.dispatcherIdentity.userId,
          agentPrincipalId: input.dispatcherIdentity.agentPrincipalId,
          scope: input.scope,
          requestKey: claim.occurrenceKey,
          expectedHostId: input.schedule.host,
          scheduleDispatch: true,
          scheduleId: input.schedule.id,
          concurrencyKey: input.schedule.concurrencyKey,
          modelPolicy,
        });
        const ackToken = await issueDispatchAckToken({
          occurrenceId: claim.occurrenceId,
          runId: run.id,
          now,
        });
        await db
          .update(executionScheduleTable)
          .set({ lastDispatchAt: now })
          .where(eq(executionScheduleTable.id, input.schedule.id));
        return {
          scheduleId: input.schedule.id,
          occurrenceId: claim.occurrenceId,
          runId: run.id,
          outcome: "reconciled_existing_run",
          ackToken,
        };
      } catch (error) {
        if (
          error instanceof ScheduleEligibilityError ||
          error instanceof HTTPException
        ) {
          await disableOneShotSchedule(input.schedule.id, now);
        } else {
          await db
            .update(executionScheduleTable)
            .set({
              nextDispatchAt: new Date(
                now.getTime() +
                  (input.schedule.retryPolicy.backoffSeconds ?? 60) * 1_000,
              ),
              updatedAt: now,
            })
            .where(eq(executionScheduleTable.id, input.schedule.id));
        }
        return {
          scheduleId: input.schedule.id,
          occurrenceId: claim.occurrenceId,
          runId: claim.runId,
          outcome: "no_op",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      scheduleId: input.schedule.id,
      occurrenceId: claim.occurrenceId,
      runId: null,
      outcome: "already_dispatched",
      reason: `occurrence state ${claim.state}`,
    };
  }

  throw new HTTPException(500, {
    message: "atomic schedule dispatch returned no outcome for a new claim",
  });
}

export async function listRunsForSchedule(scheduleId: string) {
  const [schedule] = await db
    .select({ id: executionScheduleTable.id })
    .from(executionScheduleTable)
    .where(eq(executionScheduleTable.id, scheduleId))
    .limit(1);
  if (!schedule) {
    throw new HTTPException(404, { message: "schedule not found" });
  }
  return db
    .select()
    .from(taskRunTable)
    .where(eq(taskRunTable.scheduleId, scheduleId));
}
