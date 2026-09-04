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
import { and, desc, eq, isNull, lte, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  agentPrincipalTable,
  executionScheduleOccurrenceTable,
  executionScheduleTable,
  taskRelationTable,
  taskRunTable,
  taskTable,
} from "../database/schema";
import { publishEvent } from "../events";
import { enqueueNotificationEvent } from "./outbox";
import { EXECUTION_FLAGS, isExecutionFlagEnabled } from "./gates";
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

const SCHEDULE_NOTIFICATION_ROUTES = ["prodesk-telegram"] as const;
const SCHEDULE_QUOTA_RESUME_MODES = [
  "disabled",
  "allowed_same_model_after_reset",
] as const;

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
  dependencyPolicy: string;
  notificationRoute: string | null;
  telegramQuotaResume: string;
  planHash: string | null;
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
    dependencyPolicy: input.dependencyPolicy,
    notificationRoute: input.notificationRoute,
    telegramQuotaResume: input.telegramQuotaResume,
    planHash: input.planHash,
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
  dependencyPolicy?: unknown;
  notificationRoute?: unknown;
  telegramQuotaResume?: unknown;
  planHash?: unknown;
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
  // SPEC-kaneo-native-telegram-control-v0-1 policy fields: v0.1 freezes
  // dependencyPolicy=reject, a logical notification route allowlist and an
  // explicit Telegram quota-resume mode.
  if (
    input.dependencyPolicy !== undefined &&
    input.dependencyPolicy !== "reject"
  ) {
    throw new HTTPException(400, {
      message: 'dependencyPolicy must be "reject" in v0.1',
    });
  }
  const dependencyPolicy = "reject";
  let notificationRoute: string | null = null;
  if (
    input.notificationRoute !== undefined &&
    input.notificationRoute !== null
  ) {
    if (
      typeof input.notificationRoute !== "string" ||
      !(SCHEDULE_NOTIFICATION_ROUTES as readonly string[]).includes(
        input.notificationRoute,
      )
    ) {
      throw new HTTPException(400, {
        message: `notificationRoute must be one of: ${SCHEDULE_NOTIFICATION_ROUTES.join(", ")}`,
      });
    }
    notificationRoute = input.notificationRoute;
  }
  const telegramQuotaResume =
    input.telegramQuotaResume === undefined ||
    input.telegramQuotaResume === null
      ? "disabled"
      : typeof input.telegramQuotaResume === "string" &&
          (SCHEDULE_QUOTA_RESUME_MODES as readonly string[]).includes(
            input.telegramQuotaResume,
          )
        ? input.telegramQuotaResume
        : null;
  if (telegramQuotaResume === null) {
    throw new HTTPException(400, {
      message: `telegramQuotaResume must be one of: ${SCHEDULE_QUOTA_RESUME_MODES.join(", ")}`,
    });
  }
  let planHash: string | null = null;
  if (input.planHash !== undefined && input.planHash !== null) {
    if (
      typeof input.planHash !== "string" ||
      input.planHash.length < 8 ||
      input.planHash.length > 128
    ) {
      throw new HTTPException(400, {
        message: "planHash must be a bounded string (8-128 chars)",
      });
    }
    planHash = input.planHash;
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
      dependencyPolicy: existingByRequest.dependencyPolicy,
      notificationRoute: existingByRequest.notificationRoute,
      telegramQuotaResume: existingByRequest.telegramQuotaResume,
      planHash: existingByRequest.planHash,
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
      dependencyPolicy,
      notificationRoute,
      telegramQuotaResume,
      planHash,
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
      dependencyPolicy,
      notificationRoute,
      telegramQuotaResume,
      planHash,
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
        dependencyPolicy: racedSchedule.dependencyPolicy,
        notificationRoute: racedSchedule.notificationRoute,
        telegramQuotaResume: racedSchedule.telegramQuotaResume,
        planHash: racedSchedule.planHash,
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
        dependencyPolicy,
        notificationRoute,
        telegramQuotaResume,
        planHash,
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
      scheduleRevision: executionScheduleTable.scheduleRevision,
      planHash: executionScheduleTable.planHash,
      dependencyPolicy: executionScheduleTable.dependencyPolicy,
      telegramQuotaResume: executionScheduleTable.telegramQuotaResume,
      notificationRoute: executionScheduleTable.notificationRoute,
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
    scheduleRevision?: number;
    planHash?: string | null;
    taskRevision?: number | undefined;
    supervisorFenceHash?: string;
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
    scheduleRevision?: number;
    planHash?: string | null;
    supervisorFenceHash?: string;
  } = {
    state: "dispatched",
    runId: input.runId,
    failureReason: null,
    updatedAt: new Date(),
  };
  if (ackToken) values.ackTokenHash = stableHash(ackToken);
  if (input.scheduleRevision !== undefined) {
    values.scheduleRevision = input.scheduleRevision;
  }
  if (input.planHash !== undefined) values.planHash = input.planHash;
  if (input.supervisorFenceHash) {
    values.supervisorFenceHash = input.supervisorFenceHash;
  }
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

/**
 * Re-issue the dispatcher-only fence when a due occurrence is reconciled
 * after the original dispatcher lost its in-memory token. The hash is the
 * durable record; the raw token is returned only to the current dispatcher so
 * it can write the new local handoff file.
 */
async function issueDispatchSupervisorFence(input: {
  occurrenceId: string;
  runId: string;
  now?: Date;
}) {
  const fence = randomBytes(32).toString("base64url");
  const [updated] = await db
    .update(executionScheduleOccurrenceTable)
    .set({
      supervisorFenceHash: stableHash(fence),
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
      message: "schedule occurrence is not ready for supervisor dispatch fence",
    });
  }
  return fence;
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
  /** One-time supervisor fence: delivered to the fixed runner only through
   * the local 0600 handoff file, never through logs or the LLM context. */
  runnerSupervisorFence?: string;
}

const TERMINAL_SCHEDULE_RUN_STATES = new Set([
  "in_review",
  "finalized",
  "rejected",
  "blocked_quota",
  "blocked_input",
  "blocked_clarification",
  "blocked_branch_drift",
  "failed",
  "orphaned",
  "cancelled",
  "superseded",
]);

/** Dependency gates that v0.1 can enforce from durable data at due time.
 * `requires_artifact` and `requires_parent_confirmation` stay declared-only
 * until dedicated artifact/confirmation tables land (spec T1 note). */
class DependencyGateError extends Error {}

async function assertDependencyGatesForDispatch(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  taskId: string,
) {
  const blocking = await tx
    .select({ sourceTaskId: taskRelationTable.sourceTaskId })
    .from(taskRelationTable)
    .where(
      and(
        eq(taskRelationTable.targetTaskId, taskId),
        eq(taskRelationTable.relationType, "blocks"),
      ),
    );
  const sourceIds = [...new Set(blocking.map((row) => row.sourceTaskId))];
  for (const sourceId of sourceIds) {
    const [source] = await tx
      .select({ executionState: taskTable.executionState })
      .from(taskTable)
      .where(eq(taskTable.id, sourceId))
      .limit(1);
    if (source?.executionState !== "done") {
      throw new DependencyGateError(
        `requires_task_done: blocking task ${sourceId} is not done`,
      );
    }
    const [sourceRun] = await tx
      .select({
        state: taskRunTable.state,
        finalizationReceipt: taskRunTable.finalizationReceipt,
      })
      .from(taskRunTable)
      .where(eq(taskRunTable.taskId, sourceId))
      .orderBy(desc(taskRunTable.createdAt))
      .limit(1);
    if (
      sourceRun &&
      sourceRun.state === "finalized" &&
      !sourceRun.finalizationReceipt?.receiptHash
    ) {
      throw new DependencyGateError(
        `requires_merge_receipt: finalized run of ${sourceId} has no verified merge receipt`,
      );
    }
  }
  const [activeRun] = await tx
    .select({ id: taskRunTable.id })
    .from(taskRunTable)
    .where(
      and(eq(taskRunTable.taskId, taskId), eq(taskRunTable.leaseActive, true)),
    )
    .limit(1);
  if (activeRun) {
    throw new DependencyGateError(
      `requires_no_active_run: run ${activeRun.id} still holds an active lease`,
    );
  }
}

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
    // SPEC-kaneo-wavefix-v0-2 (T6): permanent dispatch failures must reach
    // the user via the durable outbox, not just the journal.
    const [scheduleRow] = await db
      .select({ taskId: executionScheduleTable.taskId })
      .from(executionScheduleTable)
      .where(eq(executionScheduleTable.id, input.scheduleId))
      .limit(1);
    if (scheduleRow) {
      await enqueueNotificationEvent(db, {
        taskId: scheduleRow.taskId,
        kind: "failed",
        payload: {
          scheduleId: input.scheduleId,
          outcome: "schedule_dispatch_failed",
          reason: input.reason.slice(0, 300),
        },
      });
    }
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
  /** Snapshot revision the dispatcher polled; CAS guard against mid-flight
   * schedule edits (host/model/policy changed after poll). */
  expectedScheduleRevision?: number | null;
};

function emptyClaim(): ClaimOccurrenceResult {
  return {
    occurrenceId: "",
    occurrenceKey: "",
    state: "planned",
    runId: null,
    claimGeneration: 0,
    claimedBy: null,
    newlyClaimed: false,
  };
}

async function disableScheduleWithReason(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scheduleId: string,
  reason: string,
  now: Date,
) {
  await tx
    .update(executionScheduleTable)
    .set({
      enabled: false,
      nextDispatchAt: null,
      disableReason: reason.slice(0, 500),
      lastFailureAt: now,
      updatedAt: now,
    })
    .where(eq(executionScheduleTable.id, scheduleId));
}

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
    // Lock order: schedule -> task -> dependency rows -> active runs ->
    // occurrence unique key. The schedule lock doubles as the revision CAS
    // fence against mid-flight policy edits.
    const [scheduleRow] = await tx
      .select()
      .from(executionScheduleTable)
      .where(eq(executionScheduleTable.id, input.schedule.id))
      .limit(1)
      .for("update");
    if (!scheduleRow) {
      throw new HTTPException(404, { message: "schedule not found" });
    }
    if (
      input.expectedScheduleRevision !== undefined &&
      input.expectedScheduleRevision !== null &&
      scheduleRow.scheduleRevision !== input.expectedScheduleRevision
    ) {
      return {
        claim: emptyClaim(),
        outcome: {
          scheduleId: input.schedule.id,
          occurrenceId: "",
          runId: null,
          outcome: "no_op" as const,
          reason: "schedule_revision_changed",
        },
      };
    }

    // Dependency gates recheck BEFORE any occurrence is claimed: a gate that
    // just failed must never consume an occurrence or create a run. The gates
    // apply only to the first claim of an occurrence — a reconciling
    // dispatcher racing an existing occurrence must reconcile the run, not
    // gate-fail and disable the schedule mid-race.
    const scheduleOccurrenceKey = occurrenceKey(
      input.schedule.id,
      input.schedule.notBefore,
    );
    const [preexistingOccurrence] = await tx
      .select({ id: executionScheduleOccurrenceTable.id })
      .from(executionScheduleOccurrenceTable)
      .where(
        eq(
          executionScheduleOccurrenceTable.occurrenceKey,
          scheduleOccurrenceKey,
        ),
      )
      .limit(1);
    if (!input.noOpReason && !preexistingOccurrence) {
      try {
        await assertDependencyGatesForDispatch(tx, input.schedule.taskId);
      } catch (error) {
        if (!(error instanceof DependencyGateError)) throw error;
        const reason = `dependency_gate_failed: ${error.message}`;
        await disableScheduleWithReason(
          tx,
          input.schedule.id,
          reason,
          input.now,
        );
        await enqueueNotificationEvent(tx, {
          taskId: input.schedule.taskId,
          kind: "failed",
          payload: {
            scheduleId: input.schedule.id,
            outcome: "dependency_gate_failed",
            reason: reason.slice(0, 300),
          },
        });
        return {
          claim: emptyClaim(),
          outcome: {
            scheduleId: input.schedule.id,
            occurrenceId: "",
            runId: null,
            outcome: "no_op" as const,
            reason,
          },
        };
      }
    }

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
      const supervisorFence = randomBytes(32).toString("base64url");
      await markOccurrenceDispatched(
        {
          occurrenceId: claim.occurrenceId,
          runId: run.id,
          claimGeneration: claim.claimGeneration,
          claimedBy: claim.claimedBy ?? "",
          scheduleRevision: scheduleRow.scheduleRevision,
          planHash: scheduleRow.planHash,
          taskRevision: run.taskRevisionAtClaim,
          supervisorFenceHash: stableHash(supervisorFence),
        },
        tx,
        ackToken,
      );
      await tx
        .update(executionScheduleTable)
        .set({ lastDispatchAt: input.now })
        .where(eq(executionScheduleTable.id, input.schedule.id));
      // Kanban is presentation-only, but a dispatched run must be visible as
      // In Progress without waiting for the worker's first report.
      await tx
        .update(taskTable)
        .set({ status: "in-progress", updatedAt: input.now })
        .where(eq(taskTable.id, input.schedule.taskId));
      // Transactional outbox: exactly-once "started" notification. Emitted
      // only on the first atomic claim; reconciliation paths below never
      // re-notify, so a dispatcher retry cannot spam Telegram.
      await enqueueNotificationEvent(tx, {
        taskId: input.schedule.taskId,
        runId: run.id,
        kind: "started",
        payload: {
          taskId: input.schedule.taskId,
          runId: run.id,
          model: input.schedule.preferredModel,
        },
      });
      return {
        claim,
        runId: run.id,
        outcome: {
          scheduleId: input.schedule.id,
          occurrenceId: claim.occurrenceId,
          runId: run.id,
          outcome: "dispatched" as const,
          ackToken,
          runnerSupervisorFence: supervisorFence,
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
      // T6: permanent no-ops (bad contract, laptop-only, eligibility) must
      // surface to the user — the dispatcher only logs them today.
      await enqueueNotificationEvent(db, {
        taskId: input.schedule.taskId,
        kind: "failed",
        payload: {
          scheduleId: input.schedule.id,
          outcome: "schedule_dispatch_no_op",
          reason: atomic.outcome.reason.slice(0, 300),
        },
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
        const supervisorFence = randomBytes(32).toString("base64url");
        await markOccurrenceDispatched({
          occurrenceId: claim.occurrenceId,
          runId: pendingRun.id,
          claimGeneration: claim.claimGeneration,
          claimedBy: claim.claimedBy ?? "",
          supervisorFenceHash: stableHash(supervisorFence),
        });
        const ackToken = await issueDispatchAckToken({
          occurrenceId: claim.occurrenceId,
          runId: pendingRun.id,
          now,
        });
        await db
          .update(taskTable)
          .set({ status: "in-progress", updatedAt: now })
          .where(eq(taskTable.id, input.schedule.taskId));
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
          runnerSupervisorFence: supervisorFence,
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
        const supervisorFence = await issueDispatchSupervisorFence({
          occurrenceId: claim.occurrenceId,
          runId: run.id,
          now,
        });
        const ackToken = await issueDispatchAckToken({
          occurrenceId: claim.occurrenceId,
          runId: run.id,
          now,
        });
        await db
          .update(taskTable)
          .set({ status: "in-progress", updatedAt: now })
          .where(eq(taskTable.id, input.schedule.taskId));
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
          runnerSupervisorFence: supervisorFence,
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

// ---------------------------------------------------------------------------
// SPEC-kaneo-wavefix-v0-2 (T4): parent schedule update/cancel with CAS.
// Pending-only: an already-dispatched schedule is immutable — run-level
// controls (resume/cancel via control requests) own it from that point.
// Every mutation bumps schedule_revision so an in-flight dispatcher claim
// loses its expectedScheduleRevision race and becomes a clean no_op.
// ---------------------------------------------------------------------------

export const SCHEDULE_CANCEL_REASON = "cancelled";

async function assertNoDispatchedOccurrence(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scheduleId: string,
): Promise<void> {
  const [dispatched] = await tx
    .select({ id: executionScheduleOccurrenceTable.id })
    .from(executionScheduleOccurrenceTable)
    .where(
      and(
        eq(executionScheduleOccurrenceTable.scheduleId, scheduleId),
        eq(executionScheduleOccurrenceTable.state, "dispatched"),
      ),
    )
    .limit(1)
    .for("update");
  if (dispatched) {
    throw new HTTPException(409, {
      message: "schedule_already_dispatched_use_run_control",
    });
  }
}

export interface UpdateScheduleInput {
  scheduleId: string;
  userId: string;
  expectedScheduleRevision: number;
  notBefore?: Date;
  preferredModel?: string | null;
  fallbackMode?: unknown;
  fallbackModels?: unknown;
  maxRuntimeSeconds?: unknown;
  notificationRoute?: unknown;
  telegramQuotaResume?: unknown;
  planHash?: unknown;
  enabled?: boolean;
}

export async function updateExecutionSchedule(input: UpdateScheduleInput) {
  if (
    !Number.isInteger(input.expectedScheduleRevision) ||
    input.expectedScheduleRevision < 1
  ) {
    throw new HTTPException(400, {
      message: "expectedScheduleRevision must be a positive integer",
    });
  }
  return db.transaction(async (tx) => {
    const [schedule] = await tx
      .select()
      .from(executionScheduleTable)
      .where(eq(executionScheduleTable.id, input.scheduleId))
      .limit(1)
      .for("update");
    if (!schedule) {
      throw new HTTPException(404, { message: "schedule not found" });
    }
    if (schedule.scheduleRevision !== input.expectedScheduleRevision) {
      throw new HTTPException(409, { message: "schedule_revision_changed" });
    }
    await assertNoDispatchedOccurrence(tx, input.scheduleId);
    if (schedule.disableReason === SCHEDULE_CANCEL_REASON) {
      throw new HTTPException(409, { message: "schedule_is_cancelled" });
    }

    const now = new Date();
    const updates: Record<string, unknown> = {
      scheduleRevision: schedule.scheduleRevision + 1,
      updatedAt: now,
    };
    // SPEC-kaneo-wavefix-v0-2 (#15): pause/resume a pending chain node.
    // Pause parks the schedule without cancelling it (revisions intact);
    // resume re-arms it at the later of its notBefore and now.
    if (input.enabled !== undefined) {
      if (input.enabled) {
        updates.enabled = true;
        const resumeAt =
          schedule.notBefore && schedule.notBefore > now ? schedule.notBefore : now;
        updates.nextDispatchAt = resumeAt;
      } else {
        updates.enabled = false;
        updates.nextDispatchAt = null;
      }
    }
    if (input.notBefore !== undefined) {
      assertScheduleShape({ notBefore: input.notBefore, cronExpr: undefined });
      updates.notBefore = input.notBefore;
      updates.nextDispatchAt = input.notBefore;
    }
    if (input.preferredModel !== undefined) {
      updates.preferredModel =
        input.preferredModel === null
          ? null
          : validateModelId(input.preferredModel, "preferredModel");
    }
    if (input.maxRuntimeSeconds !== undefined) {
      const policy = validateSchedulePolicy({
        host: schedule.host,
        maxRuntimeSeconds: input.maxRuntimeSeconds,
        fallbackMode: undefined,
        fallbackModels: undefined,
        concurrencyKey: undefined,
      });
      updates.maxRuntimeSeconds = policy.maxRuntimeSeconds;
    }
    if (input.notificationRoute !== undefined) {
      if (
        typeof input.notificationRoute !== "string" ||
        !(SCHEDULE_NOTIFICATION_ROUTES as readonly string[]).includes(
          input.notificationRoute,
        )
      ) {
        throw new HTTPException(400, {
          message: `notificationRoute must be one of: ${SCHEDULE_NOTIFICATION_ROUTES.join(", ")}`,
        });
      }
      updates.notificationRoute = input.notificationRoute;
    }
    if (input.telegramQuotaResume !== undefined) {
      if (
        typeof input.telegramQuotaResume !== "string" ||
        !(SCHEDULE_QUOTA_RESUME_MODES as readonly string[]).includes(
          input.telegramQuotaResume,
        )
      ) {
        throw new HTTPException(400, {
          message: `telegramQuotaResume must be one of: ${SCHEDULE_QUOTA_RESUME_MODES.join(", ")}`,
        });
      }
      updates.telegramQuotaResume = input.telegramQuotaResume;
    }
    if (input.planHash !== undefined) {
      if (
        typeof input.planHash !== "string" ||
        input.planHash.length < 8 ||
        input.planHash.length > 128
      ) {
        throw new HTTPException(400, {
          message: "planHash must be a bounded string (8-128 chars)",
        });
      }
      updates.planHash = input.planHash;
    }

    const [updated] = await tx
      .update(executionScheduleTable)
      .set(updates)
      .where(
        and(
          eq(executionScheduleTable.id, input.scheduleId),
          eq(
            executionScheduleTable.scheduleRevision,
            input.expectedScheduleRevision,
          ),
        ),
      )
      .returning();
    if (!updated) {
      throw new HTTPException(409, { message: "schedule_revision_changed" });
    }
    await publishEvent("execution.schedule.updated", {
      scheduleId: updated.id,
      taskId: updated.taskId,
      scheduleRevision: updated.scheduleRevision,
      userId: input.userId,
    });
    return updated;
  });
}

export async function cancelExecutionSchedule(input: {
  scheduleId: string;
  userId: string;
  expectedScheduleRevision: number;
}) {
  if (
    !Number.isInteger(input.expectedScheduleRevision) ||
    input.expectedScheduleRevision < 1
  ) {
    throw new HTTPException(400, {
      message: "expectedScheduleRevision must be a positive integer",
    });
  }
  return db.transaction(async (tx) => {
    const [schedule] = await tx
      .select()
      .from(executionScheduleTable)
      .where(eq(executionScheduleTable.id, input.scheduleId))
      .limit(1)
      .for("update");
    if (!schedule) {
      throw new HTTPException(404, { message: "schedule not found" });
    }
    if (schedule.disableReason === SCHEDULE_CANCEL_REASON) {
      // Idempotent cancel: repeating the request is a success, not a conflict.
      return schedule;
    }
    if (schedule.scheduleRevision !== input.expectedScheduleRevision) {
      throw new HTTPException(409, { message: "schedule_revision_changed" });
    }
    await assertNoDispatchedOccurrence(tx, input.scheduleId);
    const now = new Date();
    const [updated] = await tx
      .update(executionScheduleTable)
      .set({
        enabled: false,
        nextDispatchAt: null,
        disableReason: SCHEDULE_CANCEL_REASON,
        scheduleRevision: schedule.scheduleRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(executionScheduleTable.id, input.scheduleId),
          eq(
            executionScheduleTable.scheduleRevision,
            input.expectedScheduleRevision,
          ),
        ),
      )
      .returning();
    if (!updated) {
      throw new HTTPException(409, { message: "schedule_revision_changed" });
    }
    await publishEvent("execution.schedule.cancelled", {
      scheduleId: updated.id,
      taskId: updated.taskId,
      scheduleRevision: updated.scheduleRevision,
      userId: input.userId,
    });
    await enqueueNotificationEvent(tx, {
      taskId: updated.taskId,
      kind: "failed",
      payload: {
        scheduleId: updated.id,
        outcome: "schedule_cancelled",
        by: input.userId,
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// SPEC-kaneo-wavefix-v0-2 (T14): chain advance after finalization. The API
// is the single chain authority: after a task finalizes with a merge
// receipt, every unblocked dependant gets its chain schedule created
// idempotently (requestKey dedup). Any missing dependency, cycle guard or
// error becomes a durable failed notification instead of a silent stall.
// ---------------------------------------------------------------------------

export async function advanceChainAfterFinalize(input: {
  projectId: string;
  finalizedTaskId: string;
  finalizedRequestKey: string;
}): Promise<void> {
  try {
    // SPEC #15 pause/re-kick: the global chain kill-switch stops NEW chain
    // schedules. Already-scheduled nodes still dispatch; the operator re-kicks
    // via resumeChainSchedules after unpausing.
    if (await isExecutionFlagEnabled(EXECUTION_FLAGS.chainPaused)) {
      await enqueueNotificationEvent(db, {
        taskId: input.finalizedTaskId,
        kind: "chain_paused",
        payload: {
          after: input.finalizedTaskId,
          reason: "chain_paused_flag",
        },
      });
      return;
    }
    const relations = await db
      .select({ targetTaskId: taskRelationTable.targetTaskId })
      .from(taskRelationTable)
      .where(
        and(
          eq(taskRelationTable.sourceTaskId, input.finalizedTaskId),
          eq(taskRelationTable.relationType, "blocks"),
        ),
      );
    const targets = [
      ...new Set(
        relations
          .map((row) => row.targetTaskId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    for (const targetTaskId of targets) {
      const [targetTask] = await db
        .select({
          id: taskTable.id,
          executionState: taskTable.executionState,
        })
        .from(taskTable)
        .where(eq(taskTable.id, targetTaskId))
        .limit(1);
      if (!targetTask || targetTask.executionState === "done") continue;

      const blockers = await db
        .select({ sourceTaskId: taskRelationTable.sourceTaskId })
        .from(taskRelationTable)
        .where(
          and(
            eq(taskRelationTable.targetTaskId, targetTaskId),
            eq(taskRelationTable.relationType, "blocks"),
          ),
        );
      const sourceIds = [...new Set(blockers.map((row) => row.sourceTaskId))];
      let allDone = true;
      for (const sourceId of sourceIds) {
        const [source] = await db
          .select({ executionState: taskTable.executionState })
          .from(taskTable)
          .where(eq(taskTable.id, sourceId))
          .limit(1);
        if (source?.executionState !== "done") {
          allDone = false;
          break;
        }
      }
      if (!allDone) continue;

      const [existingEnabled] = await db
        .select({ id: executionScheduleTable.id })
        .from(executionScheduleTable)
        .where(
          and(
            eq(executionScheduleTable.taskId, targetTaskId),
            eq(executionScheduleTable.enabled, true),
          ),
        )
        .limit(1);
      if (existingEnabled) continue;

      // Inherit the dispatch policy from the finalized task's latest
      // schedule so chain nodes run with the same host/model policy.
      const [sourceSchedule] = await db
        .select()
        .from(executionScheduleTable)
        .where(eq(executionScheduleTable.taskId, input.finalizedTaskId))
        .orderBy(desc(executionScheduleTable.createdAt))
        .limit(1);

      const requestKey = `chain:${targetTaskId}:${input.finalizedTaskId}:${input.finalizedRequestKey}`;
      await createExecutionSchedule({
        taskId: targetTaskId,
        projectId: input.projectId,
        userId: sourceSchedule?.createdByUserId ?? "",
        requestKey,
        notBefore: new Date(),
        host: sourceSchedule?.host ?? "pi-prodesk",
        preferredModel: sourceSchedule?.preferredModel ?? null,
        fallbackMode: sourceSchedule?.fallbackMode ?? undefined,
        fallbackModels: sourceSchedule?.fallbackModels ?? undefined,
        maxRuntimeSeconds: sourceSchedule?.maxRuntimeSeconds ?? 3_600,
        concurrencyKey: sourceSchedule?.concurrencyKey ?? undefined,
        retryPolicy: sourceSchedule?.retryPolicy ?? undefined,
        dependencyPolicy: "reject",
        notificationRoute: sourceSchedule?.notificationRoute ?? undefined,
        telegramQuotaResume: sourceSchedule?.telegramQuotaResume ?? undefined,
        planHash: sourceSchedule?.planHash ?? undefined,
      });
      await enqueueNotificationEvent(db, {
        taskId: targetTaskId,
        kind: "started",
        payload: {
          outcome: "chain_scheduled",
          after: input.finalizedTaskId,
        },
      });
    }
  } catch (error) {
    await enqueueNotificationEvent(db, {
      taskId: input.finalizedTaskId,
      kind: "failed",
      payload: {
        outcome: "chain_advance_failed",
        reason:
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
      },
    });
  }
}

// SPEC #15 re-kick: after the operator unpauses the chain, sweep one project
// for dependants whose blockers are all done but which have no enabled
// schedule yet, and create those schedules idempotently. Runs synchronously
// with a bounded task scan; safe to call repeatedly (requestKey dedup +
// existing-enabled check make repeat calls no-ops).
export async function resumeChainSchedules(input: {
  projectId: string;
  userId: string;
}): Promise<{ scheduledTaskIds: string[] }> {
  if (await isExecutionFlagEnabled(EXECUTION_FLAGS.chainPaused)) {
    throw new HTTPException(409, {
      message: "Chain is paused; clear the chain_paused flag before re-kicking",
    });
  }

  const projectTasks = await db
    .select({
      id: taskTable.id,
      executionState: taskTable.executionState,
    })
    .from(taskTable)
    .where(eq(taskTable.projectId, input.projectId));
  if (projectTasks.length === 0) return { scheduledTaskIds: [] };

  const stateById = new Map(
    projectTasks.map((task) => [task.id, task.executionState]),
  );
  const taskIds = [...stateById.keys()];

  const relations = await db
    .select({
      sourceTaskId: taskRelationTable.sourceTaskId,
      targetTaskId: taskRelationTable.targetTaskId,
    })
    .from(taskRelationTable)
    .where(
      and(
        eq(taskRelationTable.relationType, "blocks"),
        // Both endpoints must live in this project; relations are global rows.
        or(
          ...taskIds.flatMap((id) => [
            eq(taskRelationTable.sourceTaskId, id),
            eq(taskRelationTable.targetTaskId, id),
          ]),
        ),
      ),
    );

  const blockersByTarget = new Map<string, string[]>();
  for (const relation of relations) {
    if (!stateById.has(relation.targetTaskId)) continue;
    const list = blockersByTarget.get(relation.targetTaskId) ?? [];
    list.push(relation.sourceTaskId);
    blockersByTarget.set(relation.targetTaskId, list);
  }

  const enabledSchedules = await db
    .select({ taskId: executionScheduleTable.taskId })
    .from(executionScheduleTable)
    .where(eq(executionScheduleTable.enabled, true));
  const hasEnabledSchedule = new Set(enabledSchedules.map((row) => row.taskId));

  const scheduledTaskIds: string[] = [];
  for (const [targetTaskId, sourceIds] of blockersByTarget) {
    if (hasEnabledSchedule.has(targetTaskId)) continue;
    if (stateById.get(targetTaskId) === "done") continue;
    const uniqueSourceIds = [...new Set(sourceIds)];
    if (
      !uniqueSourceIds.every((sourceId) => stateById.get(sourceId) === "done")
    ) {
      continue;
    }

    const [sourceSchedule] = await db
      .select()
      .from(executionScheduleTable)
      .where(eq(executionScheduleTable.taskId, uniqueSourceIds[0]))
      .orderBy(desc(executionScheduleTable.createdAt))
      .limit(1);

    const requestKey = `chain-resume:${targetTaskId}:${[...uniqueSourceIds]
      .sort()
      .join(":")}`;
    await createExecutionSchedule({
      taskId: targetTaskId,
      projectId: input.projectId,
      userId: input.userId,
      requestKey,
      notBefore: new Date(),
      host: sourceSchedule?.host ?? "pi-prodesk",
      preferredModel: sourceSchedule?.preferredModel ?? null,
      fallbackMode: sourceSchedule?.fallbackMode ?? undefined,
      fallbackModels: sourceSchedule?.fallbackModels ?? undefined,
      maxRuntimeSeconds: sourceSchedule?.maxRuntimeSeconds ?? 3_600,
      concurrencyKey: sourceSchedule?.concurrencyKey ?? undefined,
      retryPolicy: sourceSchedule?.retryPolicy ?? undefined,
      dependencyPolicy: "reject",
      notificationRoute: sourceSchedule?.notificationRoute ?? undefined,
      telegramQuotaResume: sourceSchedule?.telegramQuotaResume ?? undefined,
      planHash: sourceSchedule?.planHash ?? undefined,
    });
    scheduledTaskIds.push(targetTaskId);
  }
  return { scheduledTaskIds };
}
