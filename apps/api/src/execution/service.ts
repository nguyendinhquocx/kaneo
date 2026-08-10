import { createId } from "@paralleldrive/cuid2";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  agentPrincipalTable,
  executionIdempotencyTable,
  executionManifestTable,
  githubIntegrationTable,
  projectTable,
  taskRunEvidenceTable,
  taskRunTable,
  taskTable,
} from "../database/schema";
import {
  createLeaseToken,
  EXECUTION_PROTOCOL_VERSION,
  getLeaseExpiry,
  hashLeaseToken,
  isLeaseExpired,
  stableHash,
  type TaskRunState,
  taskSlug,
  validateBranchName,
  validateDocs,
  validateGitSha,
  validateJsonObject,
  validateLeaseEpoch,
  validatePrUrl,
  validateRunState,
  validateScope,
  validateVerificationProfile,
} from "./validation";

export const AGENT_SCOPES = [
  "agent:read",
  "agent:comment",
  "run:claim",
  "run:heartbeat",
  "run:report",
] as const;

export type ExecutionManifestInput = {
  baseBranch: unknown;
  docs?: unknown;
  verificationProfile: unknown;
  allowedAgentIds: unknown;
  policy?: unknown;
};

export type CreateAgentPrincipalInput = {
  runtimeId: unknown;
  hostId: unknown;
  scopes?: unknown;
};

type ReadExecutor = Pick<typeof db, "select">;
type WriteExecutor = Pick<typeof db, "select" | "update" | "insert">;

function validateIdentity(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: `${field} must be a string` });
  }
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(normalized)) {
    throw new HTTPException(400, {
      message: `${field} must be a stable runtime identity`,
    });
  }
  return normalized;
}

function validateScopes(value: unknown): string[] {
  if (value === undefined) return [...AGENT_SCOPES];
  if (!Array.isArray(value) || value.length === 0) {
    throw new HTTPException(400, {
      message: "scopes must be a non-empty array",
    });
  }
  const scopes = value.map((scope) => {
    if (
      typeof scope !== "string" ||
      !(AGENT_SCOPES as readonly string[]).includes(scope)
    ) {
      throw new HTTPException(400, {
        message: `Unsupported agent scope: ${scope}`,
      });
    }
    return scope;
  });
  return [...new Set(scopes)];
}

function validateAllowedAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HTTPException(400, {
      message: "allowedAgentIds must be an array",
    });
  }
  const ids = value.map((id) => {
    if (typeof id !== "string" || !id.trim()) {
      throw new HTTPException(400, {
        message: "allowedAgentIds must contain non-empty IDs",
      });
    }
    return id.trim();
  });
  return [...new Set(ids)];
}

function validatePolicy(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  return validateJsonObject(value, "policy");
}

function assertReportState(state: TaskRunState) {
  if (state === "done" || state === "rejected") {
    throw new HTTPException(403, {
      message: "Only a parent review gate can finish or reject a task run",
    });
  }
}

type TaskRunResponse = ReturnType<typeof serializeRun>;

const IDEMPOTENCY_OPERATIONS = {
  heartbeat: "task_run.heartbeat",
  report: "task_run.report",
  release: "task_run.release",
} as const;

function requireIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 200) {
    throw new HTTPException(400, {
      message:
        "Idempotency-Key header is required and must be <= 200 characters",
    });
  }
  return key;
}

function serializeRun(
  run: typeof taskRunTable.$inferSelect,
  leaseToken?: string | null,
) {
  return {
    id: run.id,
    taskId: run.taskId,
    manifestId: run.manifestId,
    manifestVersion: run.manifestVersion,
    protocolVersion: run.protocolVersion,
    repositoryOwner: run.repositoryOwner,
    repositoryName: run.repositoryName,
    baseBranch: run.baseBranch,
    state: run.state,
    role: run.role,
    agentPrincipalId: run.agentPrincipalId,
    hostId: run.hostId,
    branchName: run.branchName,
    scope: run.scope,
    baseSha: run.baseSha,
    commitSha: run.commitSha,
    prNumber: run.prNumber,
    prUrl: run.prUrl,
    prState: run.prState,
    evidence: run.evidence,
    blocker: run.blocker,
    nextAction: run.nextAction,
    leaseEpoch: run.leaseEpoch,
    leaseActive: run.leaseActive,
    leaseExpiresAt: run.leaseExpiresAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(leaseToken ? { leaseToken } : {}),
  };
}

async function getIdempotencyReplay(
  tx: WriteExecutor,
  {
    userId,
    operation,
    requestKey,
    requestHash,
    runId,
  }: {
    userId: string;
    operation: string;
    requestKey: string;
    requestHash: string;
    runId: string;
  },
): Promise<TaskRunResponse | null> {
  const [reserved] = await tx
    .insert(executionIdempotencyTable)
    .values({
      userId,
      runId,
      operation,
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

  if (reserved) return null;

  const [record] = await tx
    .select()
    .from(executionIdempotencyTable)
    .where(
      and(
        eq(executionIdempotencyTable.operation, operation),
        eq(executionIdempotencyTable.requestKey, requestKey),
      ),
    )
    .limit(1);
  if (!record) {
    throw new HTTPException(409, {
      message: "Idempotency-Key reservation was not available",
    });
  }

  if (
    record.userId !== userId ||
    record.runId !== runId ||
    record.requestHash !== requestHash
  ) {
    throw new HTTPException(409, {
      message: "Idempotency-Key was already used with a different request",
    });
  }

  return record.response as TaskRunResponse;
}

async function saveIdempotencyResponse(
  tx: WriteExecutor,
  {
    userId,
    agentPrincipalId,
    runId,
    operation,
    requestKey,
    requestHash,
    response,
  }: {
    userId: string;
    agentPrincipalId: string;
    runId: string;
    operation: string;
    requestKey: string;
    requestHash: string;
    response: TaskRunResponse;
  },
) {
  const [saved] = await tx
    .update(executionIdempotencyTable)
    .set({
      agentPrincipalId,
      response: response as Record<string, unknown>,
    })
    .where(
      and(
        eq(executionIdempotencyTable.userId, userId),
        eq(executionIdempotencyTable.runId, runId),
        eq(executionIdempotencyTable.operation, operation),
        eq(executionIdempotencyTable.requestKey, requestKey),
        eq(executionIdempotencyTable.requestHash, requestHash),
      ),
    )
    .returning({ id: executionIdempotencyTable.id });
  if (!saved) {
    throw new HTTPException(500, {
      message: "Failed to persist idempotency response",
    });
  }
  return response;
}

async function getOwnedPrincipal(
  userId: string,
  agentPrincipalId: string,
  tx: ReadExecutor = db,
) {
  const [principal] = await tx
    .select()
    .from(agentPrincipalTable)
    .where(
      and(
        eq(agentPrincipalTable.id, agentPrincipalId),
        eq(agentPrincipalTable.userId, userId),
        eq(agentPrincipalTable.isActive, true),
      ),
    )
    .limit(1);

  if (!principal) {
    throw new HTTPException(403, {
      message: "Agent principal is not active or not owned by this user",
    });
  }
  return principal;
}

async function getTaskContext(taskId: string, tx: ReadExecutor = db) {
  const [task] = await tx
    .select({
      id: taskTable.id,
      title: taskTable.title,
      projectId: taskTable.projectId,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, taskId))
    .limit(1);

  if (!task) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  const [manifest] = await tx
    .select()
    .from(executionManifestTable)
    .where(eq(executionManifestTable.projectId, task.projectId))
    .limit(1);

  if (!manifest) {
    throw new HTTPException(409, {
      message: "Project execution manifest is not configured",
    });
  }
  if (manifest.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    throw new HTTPException(409, {
      message: "Execution protocol version is not supported by this runtime",
    });
  }

  const [integration] = await tx
    .select()
    .from(githubIntegrationTable)
    .where(
      and(
        eq(githubIntegrationTable.projectId, task.projectId),
        eq(githubIntegrationTable.isActive, true),
      ),
    )
    .limit(1);

  if (!integration) {
    throw new HTTPException(409, {
      message: "Active GitHub integration is required for execution",
    });
  }

  if (
    manifest.repositoryOwner !== integration.repositoryOwner ||
    manifest.repositoryName !== integration.repositoryName
  ) {
    throw new HTTPException(409, {
      message:
        "Execution manifest does not match the active GitHub integration",
    });
  }

  return { task, manifest, integration };
}

export async function getExecutionManifest(projectId: string) {
  const [manifest] = await db
    .select()
    .from(executionManifestTable)
    .where(eq(executionManifestTable.projectId, projectId))
    .limit(1);
  return manifest ?? null;
}

export async function upsertExecutionManifest(
  projectId: string,
  userId: string,
  input: ExecutionManifestInput,
) {
  const baseBranch = validateBranchName(input.baseBranch);
  const docs = validateDocs(input.docs);
  const verificationProfile = validateVerificationProfile(
    input.verificationProfile,
  );
  const allowedAgentIds = validateAllowedAgentIds(input.allowedAgentIds);
  const policy = validatePolicy(input.policy);

  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .limit(1);
    if (!project)
      throw new HTTPException(404, { message: "Project not found" });

    const [integration] = await tx
      .select()
      .from(githubIntegrationTable)
      .where(
        and(
          eq(githubIntegrationTable.projectId, projectId),
          eq(githubIntegrationTable.isActive, true),
        ),
      )
      .limit(1);
    if (!integration) {
      throw new HTTPException(409, {
        message:
          "Active GitHub integration is required before configuring execution",
      });
    }

    if (allowedAgentIds.length > 0) {
      const principals = await tx
        .select({ id: agentPrincipalTable.id })
        .from(agentPrincipalTable)
        .where(
          and(
            inArray(agentPrincipalTable.id, allowedAgentIds),
            eq(agentPrincipalTable.userId, userId),
            eq(agentPrincipalTable.isActive, true),
          ),
        );
      if (principals.length !== allowedAgentIds.length) {
        throw new HTTPException(400, {
          message: "allowedAgentIds contains an unknown or inactive principal",
        });
      }
    }

    const [existing] = await tx
      .select()
      .from(executionManifestTable)
      .where(eq(executionManifestTable.projectId, projectId))
      .limit(1);

    if (existing) {
      const [updated] = await tx
        .update(executionManifestTable)
        .set({
          repositoryOwner: integration.repositoryOwner,
          repositoryName: integration.repositoryName,
          baseBranch,
          docs,
          verificationProfile,
          allowedAgentIds,
          policy,
          manifestVersion: existing.manifestVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(executionManifestTable.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await tx
      .insert(executionManifestTable)
      .values({
        projectId,
        repositoryOwner: integration.repositoryOwner,
        repositoryName: integration.repositoryName,
        baseBranch,
        docs,
        verificationProfile,
        allowedAgentIds,
        policy,
        manifestVersion: 1,
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
      })
      .returning();
    return created;
  });
}

export async function listAgentPrincipals(userId: string, projectId?: string) {
  if (projectId) {
    const [manifest] = await db
      .select({ allowedAgentIds: executionManifestTable.allowedAgentIds })
      .from(executionManifestTable)
      .where(eq(executionManifestTable.projectId, projectId))
      .limit(1);
    const allowedAgentIds = manifest?.allowedAgentIds ?? [];
    if (allowedAgentIds.length === 0) return [];

    return db
      .select()
      .from(agentPrincipalTable)
      .where(
        and(
          eq(agentPrincipalTable.userId, userId),
          eq(agentPrincipalTable.isActive, true),
          inArray(agentPrincipalTable.id, allowedAgentIds),
        ),
      )
      .orderBy(agentPrincipalTable.runtimeId);
  }

  return db
    .select()
    .from(agentPrincipalTable)
    .where(
      and(
        eq(agentPrincipalTable.userId, userId),
        eq(agentPrincipalTable.isActive, true),
      ),
    )
    .orderBy(agentPrincipalTable.runtimeId);
}

export async function createAgentPrincipal(
  userId: string,
  input: CreateAgentPrincipalInput,
) {
  const runtimeId = validateIdentity(input.runtimeId, "runtimeId");
  const hostId = validateIdentity(input.hostId, "hostId");
  const scopes = validateScopes(input.scopes);

  const [created] = await db
    .insert(agentPrincipalTable)
    .values({ userId, runtimeId, hostId, scopes })
    .returning();
  return created;
}

export async function listTaskRuns(taskId: string) {
  await getTaskContext(taskId);
  const runs = await db
    .select()
    .from(taskRunTable)
    .where(eq(taskRunTable.taskId, taskId))
    .orderBy(desc(taskRunTable.createdAt));
  return runs.map((run) => serializeRun(run));
}

export async function getTaskRun(taskId: string, runId: string) {
  const [run] = await db
    .select()
    .from(taskRunTable)
    .where(and(eq(taskRunTable.id, runId), eq(taskRunTable.taskId, taskId)))
    .limit(1);
  if (!run) throw new HTTPException(404, { message: "Task run not found" });
  return serializeRun(run);
}

export async function listTaskRunEvidence(taskId: string, runId: string) {
  const [run] = await db
    .select({ id: taskRunTable.id })
    .from(taskRunTable)
    .where(and(eq(taskRunTable.id, runId), eq(taskRunTable.taskId, taskId)))
    .limit(1);
  if (!run) throw new HTTPException(404, { message: "Task run not found" });

  return db
    .select()
    .from(taskRunEvidenceTable)
    .where(eq(taskRunEvidenceTable.runId, runId))
    .orderBy(asc(taskRunEvidenceTable.createdAt));
}

export async function claimTaskRun({
  taskId,
  userId,
  agentPrincipalId,
  scope,
  requestKey,
}: {
  taskId: string;
  userId: string;
  agentPrincipalId: string;
  scope: unknown;
  requestKey: string;
}) {
  if (!requestKey || requestKey.length > 200) {
    throw new HTTPException(400, {
      message:
        "Idempotency-Key header is required and must be <= 200 characters",
    });
  }
  const normalizedScope = validateScope(scope);
  const requestHash = stableHash({
    taskId,
    agentPrincipalId,
    scope: normalizedScope,
  });

  return db.transaction(async (tx) => {
    const [existingRequest] = await tx
      .select()
      .from(taskRunTable)
      .where(eq(taskRunTable.requestKey, requestKey))
      .limit(1);
    if (existingRequest) {
      await getOwnedPrincipal(
        userId,
        existingRequest.agentPrincipalId ?? "",
        tx,
      );
      if (existingRequest.requestHash !== requestHash) {
        throw new HTTPException(409, {
          message: "Idempotency-Key was already used with a different request",
        });
      }
      return { run: existingRequest, leaseToken: null };
    }

    // Serialize claims for one task before checking the partial active-lease index.
    await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .for("update");

    const { task, manifest, integration } = await getTaskContext(taskId, tx);
    const principal = await getOwnedPrincipal(userId, agentPrincipalId, tx);
    const allowedAgentIds = Array.isArray(manifest.allowedAgentIds)
      ? manifest.allowedAgentIds
      : [];
    if (!allowedAgentIds.includes(principal.id)) {
      throw new HTTPException(403, {
        message: "Agent principal is not allowed by this project manifest",
      });
    }
    if (!principal.scopes.includes("run:claim")) {
      throw new HTTPException(403, {
        message: "Agent principal lacks run:claim scope",
      });
    }

    const [latestRun] = await tx
      .select({ leaseEpoch: taskRunTable.leaseEpoch })
      .from(taskRunTable)
      .where(eq(taskRunTable.taskId, taskId))
      .orderBy(desc(taskRunTable.leaseEpoch))
      .limit(1);
    const nextLeaseEpoch = (latestRun?.leaseEpoch ?? 0) + 1;

    const [activeRun] = await tx
      .select()
      .from(taskRunTable)
      .where(
        and(
          eq(taskRunTable.taskId, taskId),
          eq(taskRunTable.leaseActive, true),
        ),
      )
      .limit(1);
    if (activeRun) {
      if (!isLeaseExpired(activeRun.leaseExpiresAt)) {
        throw new HTTPException(409, {
          message: "Task already has an active worker lease",
        });
      }
      await tx
        .update(taskRunTable)
        .set({
          leaseActive: false,
          state: "orphaned",
          updatedAt: new Date(),
        })
        .where(eq(taskRunTable.id, activeRun.id));
    }

    const runId = createId();
    const branchName = `${principal.runtimeId}/${taskId}-${runId}-${taskSlug(task.title)}`;
    const leaseToken = createLeaseToken();
    const [run] = await tx
      .insert(taskRunTable)
      .values({
        id: runId,
        taskId,
        manifestId: manifest.id,
        manifestVersion: manifest.manifestVersion,
        protocolVersion: manifest.protocolVersion,
        repositoryOwner: integration.repositoryOwner,
        repositoryName: integration.repositoryName,
        baseBranch: manifest.baseBranch,
        state: "in_progress",
        role: "worker",
        agentPrincipalId: principal.id,
        hostId: principal.hostId,
        branchName,
        scope: normalizedScope,
        requestKey,
        requestHash,
        leaseEpoch: nextLeaseEpoch,
        leaseTokenHash: leaseToken.hash,
        leaseActive: true,
        leaseExpiresAt: getLeaseExpiry(),
        lastHeartbeatAt: new Date(),
      })
      .returning();
    if (!run) {
      throw new HTTPException(500, { message: "Task run was not created" });
    }

    return { run, leaseToken: leaseToken.raw };
  });
}

async function assertCurrentLease(
  tx: WriteExecutor,
  runId: string,
  userId: string,
  leaseEpoch: number,
  leaseToken: string,
  requiredScope: (typeof AGENT_SCOPES)[number] = "run:heartbeat",
) {
  const normalizedLeaseEpoch = validateLeaseEpoch(leaseEpoch);
  const [run] = await tx
    .select()
    .from(taskRunTable)
    .where(eq(taskRunTable.id, runId))
    .limit(1);
  if (!run) throw new HTTPException(404, { message: "Task run not found" });

  if (!run.agentPrincipalId) {
    throw new HTTPException(409, {
      message: "Task run has no active agent principal",
    });
  }
  const principal = await getOwnedPrincipal(userId, run.agentPrincipalId, tx);
  if (!principal.scopes.includes(requiredScope)) {
    throw new HTTPException(403, {
      message: `Agent principal lacks ${requiredScope} scope`,
    });
  }

  if (!run.leaseActive || isLeaseExpired(run.leaseExpiresAt)) {
    if (run.leaseActive) {
      await tx
        .update(taskRunTable)
        .set({ leaseActive: false, state: "orphaned", updatedAt: new Date() })
        .where(eq(taskRunTable.id, run.id));
    }
    throw new HTTPException(409, { message: "Task run lease has expired" });
  }
  if (
    run.leaseEpoch !== normalizedLeaseEpoch ||
    hashLeaseToken(leaseToken) !== run.leaseTokenHash
  ) {
    throw new HTTPException(409, {
      message: "Stale or invalid task run lease fence",
    });
  }

  return { run, principal };
}

export async function heartbeatTaskRun({
  taskId,
  runId,
  userId,
  leaseEpoch,
  leaseToken,
  requestKey,
}: {
  taskId: string;
  runId: string;
  userId: string;
  leaseEpoch: number;
  leaseToken: string;
  requestKey: string;
}) {
  const normalizedKey = requireIdempotencyKey(requestKey);
  const normalizedLeaseEpoch = validateLeaseEpoch(leaseEpoch);
  const leaseTokenHash = hashLeaseToken(leaseToken);
  const requestHash = stableHash({
    taskId,
    runId,
    leaseEpoch: normalizedLeaseEpoch,
    leaseTokenHash,
  });

  return db.transaction(async (tx) => {
    const replay = await getIdempotencyReplay(tx, {
      userId,
      operation: IDEMPOTENCY_OPERATIONS.heartbeat,
      requestKey: normalizedKey,
      requestHash,
      runId,
    });
    if (replay) return replay;

    const { run, principal } = await assertCurrentLease(
      tx,
      runId,
      userId,
      normalizedLeaseEpoch,
      leaseToken,
    );
    if (run.taskId !== taskId) {
      throw new HTTPException(404, { message: "Task run not found" });
    }
    const now = new Date();
    const [updated] = await tx
      .update(taskRunTable)
      .set({
        lastHeartbeatAt: now,
        leaseExpiresAt: getLeaseExpiry(now),
        updatedAt: now,
      })
      .where(
        and(
          eq(taskRunTable.id, runId),
          eq(taskRunTable.leaseEpoch, normalizedLeaseEpoch),
          eq(taskRunTable.leaseTokenHash, leaseTokenHash),
          eq(taskRunTable.leaseActive, true),
        ),
      )
      .returning();
    if (!updated) {
      throw new HTTPException(409, { message: "Stale task run lease fence" });
    }
    return saveIdempotencyResponse(tx, {
      userId,
      agentPrincipalId: principal.id,
      runId,
      operation: IDEMPOTENCY_OPERATIONS.heartbeat,
      requestKey: normalizedKey,
      requestHash,
      response: serializeRun(updated),
    });
  });
}

export async function reportTaskRun({
  taskId,
  runId,
  userId,
  leaseEpoch,
  leaseToken,
  state,
  baseSha,
  commitSha,
  prNumber,
  prUrl,
  prState,
  evidence,
  blocker,
  nextAction,
  requestKey,
}: {
  taskId: string;
  runId: string;
  userId: string;
  leaseEpoch: number;
  leaseToken: string;
  state: unknown;
  baseSha?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  prState?: string;
  evidence?: Record<string, unknown>;
  blocker?: string;
  nextAction?: string;
  requestKey: string;
}) {
  const nextState = validateRunState(state);
  assertReportState(nextState);
  const nextBaseSha = validateGitSha(baseSha, "baseSha");
  const nextCommitSha = validateGitSha(commitSha, "commitSha");
  const nextPrUrl = validatePrUrl(prUrl);
  if (
    prNumber !== undefined &&
    (!Number.isInteger(prNumber) || prNumber < 1 || prNumber > 2_147_483_647)
  ) {
    throw new HTTPException(400, {
      message: "prNumber must be a positive integer",
    });
  }
  const normalizedKey = requireIdempotencyKey(requestKey);
  const normalizedLeaseEpoch = validateLeaseEpoch(leaseEpoch);
  const leaseTokenHash = hashLeaseToken(leaseToken);
  const requestHash = stableHash({
    taskId,
    runId,
    leaseEpoch: normalizedLeaseEpoch,
    leaseTokenHash,
    state: nextState,
    baseSha: nextBaseSha ?? null,
    commitSha: nextCommitSha ?? null,
    prNumber: prNumber ?? null,
    prUrl: nextPrUrl ?? null,
    prState: prState ?? null,
    evidence: evidence ?? null,
    blocker: blocker ?? null,
    nextAction: nextAction ?? null,
  });

  return db.transaction(async (tx) => {
    const replay = await getIdempotencyReplay(tx, {
      userId,
      operation: IDEMPOTENCY_OPERATIONS.report,
      requestKey: normalizedKey,
      requestHash,
      runId,
    });
    if (replay) return replay;

    const { run, principal } = await assertCurrentLease(
      tx,
      runId,
      userId,
      normalizedLeaseEpoch,
      leaseToken,
      "run:report",
    );
    if (run.taskId !== taskId) {
      throw new HTTPException(404, { message: "Task run not found" });
    }

    const now = new Date();
    const nextEvidence =
      evidence === undefined
        ? run.evidence
        : validateJsonObject(evidence, "evidence");
    const [updated] = await tx
      .update(taskRunTable)
      .set({
        state: nextState,
        baseSha: nextBaseSha ?? run.baseSha,
        commitSha: nextCommitSha ?? run.commitSha,
        prNumber: prNumber ?? run.prNumber,
        prUrl: nextPrUrl ?? run.prUrl,
        prState: prState ?? run.prState,
        evidence: nextEvidence,
        blocker: blocker ?? null,
        nextAction: nextAction ?? null,
        leaseActive: nextState !== "in_review",
        lastHeartbeatAt: now,
        leaseExpiresAt: getLeaseExpiry(now),
        updatedAt: now,
      })
      .where(
        and(
          eq(taskRunTable.id, runId),
          eq(taskRunTable.leaseEpoch, normalizedLeaseEpoch),
          eq(taskRunTable.leaseTokenHash, leaseTokenHash),
          eq(taskRunTable.leaseActive, true),
        ),
      )
      .returning();
    if (!updated) {
      throw new HTTPException(409, { message: "Stale task run lease fence" });
    }

    await tx.insert(taskRunEvidenceTable).values({
      runId,
      agentPrincipalId: principal.id,
      kind: "worker_report",
      payload: {
        state: nextState,
        baseSha: nextBaseSha ?? null,
        commitSha: nextCommitSha ?? null,
        prNumber: prNumber ?? null,
        prUrl: nextPrUrl ?? null,
        prState: prState ?? null,
        evidence: nextEvidence,
        blocker: blocker ?? null,
        nextAction: nextAction ?? null,
      },
    });

    return saveIdempotencyResponse(tx, {
      userId,
      agentPrincipalId: principal.id,
      runId,
      operation: IDEMPOTENCY_OPERATIONS.report,
      requestKey: normalizedKey,
      requestHash,
      response: serializeRun(updated),
    });
  });
}

export async function releaseTaskRun({
  taskId,
  runId,
  userId,
  leaseEpoch,
  leaseToken,
  state,
  requestKey,
}: {
  taskId: string;
  runId: string;
  userId: string;
  leaseEpoch: number;
  leaseToken: string;
  state?: unknown;
  requestKey: string;
}) {
  const nextState = state === undefined ? "blocked" : validateRunState(state);
  if (nextState === "done" || nextState === "rejected") {
    throw new HTTPException(403, {
      message: "Only a parent review gate can finish a task run",
    });
  }
  const normalizedKey = requireIdempotencyKey(requestKey);
  const normalizedLeaseEpoch = validateLeaseEpoch(leaseEpoch);
  const leaseTokenHash = hashLeaseToken(leaseToken);
  const requestHash = stableHash({
    taskId,
    runId,
    leaseEpoch: normalizedLeaseEpoch,
    leaseTokenHash,
    state: nextState,
  });

  return db.transaction(async (tx) => {
    const replay = await getIdempotencyReplay(tx, {
      userId,
      operation: IDEMPOTENCY_OPERATIONS.release,
      requestKey: normalizedKey,
      requestHash,
      runId,
    });
    if (replay) return replay;

    const { run, principal } = await assertCurrentLease(
      tx,
      runId,
      userId,
      normalizedLeaseEpoch,
      leaseToken,
      "run:report",
    );
    if (run.taskId !== taskId) {
      throw new HTTPException(404, { message: "Task run not found" });
    }
    const [updated] = await tx
      .update(taskRunTable)
      .set({
        state: nextState,
        leaseActive: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(taskRunTable.id, runId),
          eq(taskRunTable.leaseEpoch, normalizedLeaseEpoch),
          eq(taskRunTable.leaseTokenHash, leaseTokenHash),
          eq(taskRunTable.leaseActive, true),
        ),
      )
      .returning();
    if (!updated) {
      throw new HTTPException(409, { message: "Stale task run lease fence" });
    }
    return saveIdempotencyResponse(tx, {
      userId,
      agentPrincipalId: principal.id,
      runId,
      operation: IDEMPOTENCY_OPERATIONS.release,
      requestKey: normalizedKey,
      requestHash,
      response: serializeRun(updated),
    });
  });
}

export function toTaskRunResponse(
  run: typeof taskRunTable.$inferSelect,
  leaseToken?: string | null,
) {
  return serializeRun(run, leaseToken);
}
