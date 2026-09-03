import { randomBytes } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  agentPrincipalTable,
  activityTable,
  columnTable,
  executionControlRequestTable,
  executionIdempotencyTable,
  executionManifestTable,
  executionScheduleOccurrenceTable,
  executionScheduleTable,
  githubIntegrationTable,
  projectTable,
  taskRelationTable,
  taskRunCheckpointTable,
  taskRunEvidenceTable,
  taskRunTable,
  taskTable,
  workspaceUserTable,
} from "../database/schema";
import { publishEvent } from "../events";
import {
  assertTaskClaimable,
  getLatestTaskRunForGate,
} from "./finalization-gate";
import {
  assertExecutionFlagEnabled,
  EXECUTION_FLAGS,
  recordExecutionMetric,
} from "./gates";
import { enqueueNotificationEvent } from "./outbox";
import { bumpTaskRevision } from "./revisions";
import { isRunTransitionAllowed } from "./transitions";
import {
  createLeaseToken,
  EXECUTION_PROTOCOL_VERSION,
  extractWorkerContractScope,
  extractWorkerContractState,
  FULLY_TERMINAL_RUN_STATES,
  getLeaseExpiry,
  hashLeaseToken,
  isLeaseExpired,
  ScheduleEligibilityError,
  stableHash,
  type TaskRunState,
  taskSlug,
  validateBranchName,
  validateControlAction,
  validateDocs,
  validateFailureKind,
  validateGitSha,
  validateJsonObject,
  validateLeaseEpoch,
  validateModelId,
  validatePrUrl,
  validateRevision,
  validateRunState,
  validateScope,
  validateVerificationProfile,
  validateWorkerReportState,
  WORKER_TERMINAL_RUN_STATES,
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

export type ParentReviewInput = {
  decision: unknown;
  action?: unknown;
  reason?: unknown;
  verification?: unknown;
  prResult?: unknown;
  expectedTaskRevision?: unknown;
  expectedRunRevision?: unknown;
  reviewHeadSha?: unknown;
  requestKey: string;
};

type ParentReviewDecision = "approve" | "reject";
type ParentReviewAction = "none" | "create_pr" | "merge";
type ParentReviewPrResult = {
  status: "PASS" | "BLOCKED";
  operation: "create_pr" | "merge";
  prNumber?: number;
  prUrl?: string;
  prState?: string;
  mergeCommitSha?: string;
  blocker?: string;
  reason?: string;
};
type ParentReviewVerification = {
  verificationProfile: string;
  baseSha: string;
  commitSha: string;
  changedFiles: string[];
  commands: string[];
  diffWithinScope: true;
  branchValid: true;
  testsPassed: true;
};

export type ExecutionTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];
type ReadExecutor = Pick<ExecutionTransaction, "select">;
type WriteExecutor = Pick<ExecutionTransaction, "select" | "update" | "insert">;

export type ScheduleRunModelPolicy = {
  preferredModel: string | null;
  fallbackMode: string;
  fallbackModels: string[];
  maxRuntimeSeconds: number;
  concurrencyKey: string;
  retryPolicy: Record<string, number>;
};

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
  if (state === "finalized" || state === "rejected") {
    throw new HTTPException(403, {
      message: "Only a parent review gate can finalize or reject a task run",
    });
  }
}

function validateParentReviewDecision(value: unknown): ParentReviewDecision {
  if (value !== "approve" && value !== "reject") {
    throw new HTTPException(400, {
      message: "Parent review decision must be approve or reject",
    });
  }
  return value;
}

function validateParentReviewAction(value: unknown): ParentReviewAction {
  if (value === undefined) return "none";
  if (value !== "none" && value !== "create_pr" && value !== "merge") {
    throw new HTTPException(400, {
      message: "Parent review action must be none, create_pr or merge",
    });
  }
  return value;
}

function getParentReviewExecutionFlag(
  decision: ParentReviewDecision,
  action: ParentReviewAction,
) {
  if (decision !== "approve") return undefined;
  // An approval without a PR action represents a manually completed merge.
  // It still crosses the merge gate; otherwise action:none would be a kill-
  // switch bypass that can finalize the task directly.
  return action === "create_pr"
    ? EXECUTION_FLAGS.prCreation
    : EXECUTION_FLAGS.merge;
}

function validateReviewPath(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: `${field} must be a string` });
  }
  const path = value.trim().replace(/\\/g, "/");
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path
      .split("/")
      .some(
        (segment: string) => !segment || segment === "." || segment === "..",
      )
  ) {
    throw new HTTPException(400, {
      message: `${field} must be an explicit relative path`,
    });
  }
  return path;
}

function validateParentReviewVerification(
  value: unknown,
): ParentReviewVerification {
  const input = validateJsonObject(value, "verification");
  const verificationProfile = input.verificationProfile;
  if (typeof verificationProfile !== "string" || !verificationProfile.trim()) {
    throw new HTTPException(400, {
      message: "verification.verificationProfile is required",
    });
  }
  const baseSha = validateGitSha(input.baseSha, "verification.baseSha");
  const commitSha = validateGitSha(input.commitSha, "verification.commitSha");
  if (!baseSha || !commitSha) {
    throw new HTTPException(400, {
      message: "verification.baseSha and verification.commitSha are required",
    });
  }
  const changedFiles = input.changedFiles;
  if (
    !Array.isArray(changedFiles) ||
    changedFiles.length === 0 ||
    changedFiles.length > 2_000
  ) {
    throw new HTTPException(400, {
      message: "verification.changedFiles must contain 1-2000 paths",
    });
  }
  const commands = input.commands;
  if (
    !Array.isArray(commands) ||
    commands.length === 0 ||
    commands.length > 100 ||
    commands.some(
      (command) =>
        typeof command !== "string" ||
        command.trim().length === 0 ||
        command.length > 500,
    )
  ) {
    throw new HTTPException(400, {
      message: "verification.commands must contain 1-100 bounded commands",
    });
  }
  if (
    input.diffWithinScope !== true ||
    input.branchValid !== true ||
    input.testsPassed !== true
  ) {
    throw new HTTPException(409, {
      message:
        "Parent approval requires passing diff, branch and test verification",
    });
  }
  return {
    verificationProfile: verificationProfile.trim(),
    baseSha,
    commitSha,
    changedFiles: changedFiles.map((path, index) =>
      validateReviewPath(path, `verification.changedFiles[${index}]`),
    ),
    commands: commands.map((command) => command.trim()),
    diffWithinScope: true,
    branchValid: true,
    testsPassed: true,
  };
}

function validateParentReviewPrResult(
  value: unknown,
  action: ParentReviewAction,
): ParentReviewPrResult | undefined {
  if (action === "none") {
    if (value !== undefined) {
      throw new HTTPException(400, {
        message: "PR result is only valid for create_pr or merge actions",
      });
    }
    return undefined;
  }
  if (value === undefined) return undefined;
  const input = validateJsonObject(value, "prResult");
  const status = input.status;
  if (status !== "PASS" && status !== "BLOCKED") {
    throw new HTTPException(400, {
      message: "prResult.status must be PASS or BLOCKED",
    });
  }
  const operationValue = input.operation;
  if (operationValue !== action) {
    throw new HTTPException(400, {
      message: "prResult.operation must match the requested review action",
    });
  }
  const operation = action;
  const blocker = input.blocker;
  if (
    blocker !== undefined &&
    (typeof blocker !== "string" ||
      ![
        "credential_blocked",
        "policy_blocked",
        "merge_conflict",
        "pr_conflict",
        "pr_create_failed",
        "merge_failed",
      ].includes(blocker))
  ) {
    throw new HTTPException(400, {
      message: "prResult.blocker is not a recognized fail-closed blocker",
    });
  }
  const reason = input.reason;
  if (
    reason !== undefined &&
    (typeof reason !== "string" || reason.trim().length > 500)
  ) {
    throw new HTTPException(400, {
      message: "prResult.reason must be a bounded string",
    });
  }
  if (status === "BLOCKED") {
    return {
      status,
      operation,
      blocker:
        typeof blocker === "string"
          ? (blocker as ParentReviewPrResult["blocker"])
          : "credential_blocked",
      reason: typeof reason === "string" ? reason.trim() : undefined,
    };
  }
  const prNumber = input.prNumber;
  if (
    typeof prNumber !== "number" ||
    !Number.isInteger(prNumber) ||
    prNumber < 1 ||
    prNumber > 2_147_483_647
  ) {
    throw new HTTPException(400, {
      message: "prResult.prNumber must be a positive integer",
    });
  }
  const prUrl = input.prUrl;
  if (typeof prUrl !== "string" || prUrl.length > 2_048) {
    throw new HTTPException(400, {
      message: "prResult.prUrl must be a bounded URL",
    });
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(prUrl);
  } catch {
    throw new HTTPException(400, { message: "prResult.prUrl is invalid" });
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    parsedUrl.port ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    !/^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*(?:\/.*)?$/.test(parsedUrl.pathname)
  ) {
    throw new HTTPException(400, {
      message: "prResult.prUrl must be an HTTPS GitHub pull-request URL",
    });
  }
  const prState =
    typeof input.prState === "string" ? input.prState.trim().toLowerCase() : "";
  const expectedState = action === "create_pr" ? "open" : "merged";
  if (prState !== expectedState) {
    throw new HTTPException(409, {
      message: `prResult.prState must be ${expectedState} for ${action}`,
    });
  }
  // A merge receipt without the merge commit is not a verifiable receipt.
  let mergeCommitSha: string | undefined;
  if (action === "merge") {
    mergeCommitSha = validateGitSha(
      input.mergeCommitSha,
      "prResult.mergeCommitSha",
    );
    if (!mergeCommitSha) {
      throw new HTTPException(409, {
        message:
          "prResult.mergeCommitSha is required for a verified merge receipt",
      });
    }
  }
  return {
    status,
    operation,
    prNumber: prNumber as number,
    prUrl: prUrl as string,
    prState,
    ...(mergeCommitSha ? { mergeCommitSha } : {}),
    reason: typeof reason === "string" ? reason.trim() : undefined,
  };
}

function assertPrResultMatchesIntegration(
  result: ParentReviewPrResult,
  integration: typeof githubIntegrationTable.$inferSelect,
): void {
  if (result.status !== "PASS" || !result.prUrl) return;
  const parsedUrl = new URL(result.prUrl);
  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  const [owner, repository, kind] = segments;
  if (
    !owner ||
    !repository ||
    segments.length < 4 ||
    owner.toLowerCase() !== integration.repositoryOwner.toLowerCase() ||
    repository.toLowerCase() !== integration.repositoryName.toLowerCase() ||
    kind !== "pull"
  ) {
    throw new HTTPException(409, {
      message: "PR result does not belong to the active GitHub repository",
    });
  }
}

function pathMatchesReviewScope(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");
  if (
    normalizedPattern.includes("*") ||
    normalizedPattern.includes("?") ||
    normalizedPattern.includes("[")
  ) {
    const regexSpecialCharacters = new Set([
      ".",
      "+",
      "^",
      "$",
      "{",
      "}",
      "(",
      ")",
      "|",
      "[",
      "]",
      "\\",
    ]);
    const escaped = [...normalizedPattern]
      .map((character) =>
        regexSpecialCharacters.has(character) ? `\\${character}` : character,
      )
      .join("")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}(?:/|$)`).test(normalizedPath);
  }
  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(`${normalizedPattern.replace(/\/+$/, "")}/`)
  );
}

function assertParentReviewableRun(
  run: typeof taskRunTable.$inferSelect,
  principalRuntimeId: string,
  manifest: typeof executionManifestTable.$inferSelect,
  verification: ParentReviewVerification,
): void {
  if (run.state !== "in_review") {
    throw new HTTPException(409, {
      message: "Only a worker run in in_review state can be approved",
    });
  }
  if (!run.commitSha || run.commitSha !== verification.commitSha) {
    throw new HTTPException(409, {
      message: "Worker commit evidence is missing or does not match the run",
    });
  }
  if (!run.baseSha || run.baseSha !== verification.baseSha) {
    throw new HTTPException(409, {
      message:
        "Worker base commit evidence is missing or does not match the run",
    });
  }
  if (
    run.manifestId !== manifest.id ||
    run.manifestVersion !== manifest.manifestVersion ||
    run.protocolVersion !== manifest.protocolVersion ||
    run.repositoryOwner !== manifest.repositoryOwner ||
    run.repositoryName !== manifest.repositoryName ||
    run.baseBranch !== manifest.baseBranch
  ) {
    throw new HTTPException(409, {
      message:
        "Task run snapshot no longer matches the active execution manifest",
    });
  }
  if (verification.verificationProfile !== manifest.verificationProfile) {
    throw new HTTPException(409, {
      message:
        "Verification profile does not match the project execution manifest",
    });
  }
  const expectedPrefix = `${principalRuntimeId}/${run.taskId}-${run.id}-`;
  if (
    !run.branchName.startsWith(expectedPrefix) ||
    run.branchName === run.baseBranch ||
    ["main", "master", "develop"].includes(run.branchName)
  ) {
    throw new HTTPException(409, {
      message: "Worker branch does not match the server-issued task branch",
    });
  }
  const outsideScope = verification.changedFiles.filter(
    (path) =>
      !run.scope.some((pattern) => pathMatchesReviewScope(path, pattern)),
  );
  if (outsideScope.length > 0) {
    throw new HTTPException(409, {
      message: `Parent diff verification found files outside the run scope: ${outsideScope.slice(0, 10).join(", ")}`,
    });
  }
}

type TaskRunResponse = ReturnType<typeof serializeRun>;

const IDEMPOTENCY_OPERATIONS = {
  heartbeat: "task_run.heartbeat",
  report: "task_run.report",
  release: "task_run.release",
  review: "task_run.review",
  checkpoint: "task_run.checkpoint",
  supervisorReport: "task_run.supervisor_report",
  controlRequest: "execution.control_request",
  preapprovedFallback: "task_run.preapproved_fallback",
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
    scheduleId: run.scheduleId,
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
    // SPEC-kaneo-native-telegram-control-v0-1 typed run fields.
    runRevision: run.runRevision,
    taskRevisionAtClaim: run.taskRevisionAtClaim,
    scheduleRevision: run.scheduleRevision,
    parentRunId: run.parentRunId,
    logicalSessionId: run.logicalSessionId,
    retryAt: run.retryAt,
    modelFailed: run.modelFailed,
    failureKind: run.failureKind,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    lastCheckpointSha: run.lastCheckpointSha,
    lastCommitSha: run.lastCommitSha,
    finalizationReceipt: run.finalizationReceipt,
    manualRecoveryRequired: run.manualRecoveryRequired,
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
    runId: string | null;
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

export async function publishTaskRunUpdated(
  taskId: string,
  runId: string,
  userId: string,
  state: string,
): Promise<void> {
  const [task] = await db
    .select({ projectId: taskTable.projectId })
    .from(taskTable)
    .where(eq(taskTable.id, taskId))
    .limit(1);
  if (!task) return;

  await publishEvent("task_run.updated", {
    projectId: task.projectId,
    taskId,
    runId,
    userId,
    state,
  });
}

async function getTaskContext(
  taskId: string,
  tx: ReadExecutor = db,
  lockTask = false,
) {
  const taskQuery = tx
    .select({
      id: taskTable.id,
      title: taskTable.title,
      description: taskTable.description,
      status: taskTable.status,
      projectId: taskTable.projectId,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, taskId))
    .limit(1);
  const [task] = lockTask ? await taskQuery.for("update") : await taskQuery;

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
      .select({ id: projectTable.id, workspaceId: projectTable.workspaceId })
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
        .innerJoin(
          workspaceUserTable,
          and(
            eq(workspaceUserTable.userId, agentPrincipalTable.userId),
            eq(workspaceUserTable.workspaceId, project.workspaceId),
          ),
        )
        .where(
          and(
            inArray(agentPrincipalTable.id, allowedAgentIds),
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
    const [project] = await db
      .select({ workspaceId: projectTable.workspaceId })
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .limit(1);
    if (!project)
      throw new HTTPException(404, { message: "Project not found" });

    const [manifest] = await db
      .select({ allowedAgentIds: executionManifestTable.allowedAgentIds })
      .from(executionManifestTable)
      .where(eq(executionManifestTable.projectId, projectId))
      .limit(1);
    const allowedAgentIds = manifest?.allowedAgentIds ?? [];
    if (allowedAgentIds.length === 0) return [];

    // Project-scoped callers already passed workspaceAccess. Return every
    // active allowed worker in that workspace so a parent account can inspect
    // and review a run owned by another service account.
    return db
      .select({
        id: agentPrincipalTable.id,
        userId: agentPrincipalTable.userId,
        runtimeId: agentPrincipalTable.runtimeId,
        hostId: agentPrincipalTable.hostId,
        scopes: agentPrincipalTable.scopes,
        isActive: agentPrincipalTable.isActive,
        createdAt: agentPrincipalTable.createdAt,
        updatedAt: agentPrincipalTable.updatedAt,
      })
      .from(agentPrincipalTable)
      .innerJoin(
        workspaceUserTable,
        and(
          eq(workspaceUserTable.userId, agentPrincipalTable.userId),
          eq(workspaceUserTable.workspaceId, project.workspaceId),
        ),
      )
      .where(
        and(
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

function assertManifestModelPolicy(
  manifestPolicy: Record<string, unknown>,
  modelPolicy: ScheduleRunModelPolicy,
): void {
  const configured = manifestPolicy.allowedModels;
  if (configured === undefined) return;
  if (
    !Array.isArray(configured) ||
    configured.length === 0 ||
    configured.some((model) => typeof model !== "string")
  ) {
    throw new ScheduleEligibilityError(
      "Project model policy is malformed or has no allowed models",
    );
  }

  let allowedModels: Set<string>;
  try {
    allowedModels = new Set(
      configured.map((model) =>
        validateModelId(model, "manifest allowed model"),
      ),
    );
  } catch (error) {
    throw new ScheduleEligibilityError(
      error instanceof Error
        ? error.message
        : "Project model policy is invalid",
    );
  }
  const requestedModels = [
    modelPolicy.preferredModel,
    ...modelPolicy.fallbackModels,
  ].filter((model): model is string => Boolean(model));
  if (requestedModels.length === 0) {
    throw new ScheduleEligibilityError(
      "Schedule must select a model when the project manifest declares an allowlist",
    );
  }
  const disallowed = requestedModels.filter(
    (model) => !allowedModels.has(model),
  );
  if (disallowed.length > 0) {
    throw new ScheduleEligibilityError(
      `Schedule model is not allowed by the project policy: ${disallowed.join(", ")}`,
    );
  }
}

async function assertScheduledTaskEligible(
  tx: WriteExecutor,
  input: {
    taskId: string;
    status: string;
    description: string | null;
    scope: string[];
    manifestPolicy: Record<string, unknown>;
    modelPolicy?: ScheduleRunModelPolicy;
  },
) {
  const executionState =
    extractWorkerContractState(input.description) ?? input.status;
  if (executionState !== "ready" && executionState !== "queued") {
    throw new ScheduleEligibilityError(
      `Scheduled task must be ready or queued, got ${executionState}`,
    );
  }

  const contract = extractWorkerContractScope(input.description);
  if (!contract || contract.laptopOnly || contract.files.length === 0) {
    throw new ScheduleEligibilityError(
      "Scheduled task has no dispatchable worker contract",
    );
  }
  const requestedScope = [...new Set(input.scope)].sort();
  const contractScope = [...new Set(contract.files)].sort();
  if (JSON.stringify(requestedScope) !== JSON.stringify(contractScope)) {
    throw new ScheduleEligibilityError(
      "Dispatch scope does not exactly match the worker contract",
    );
  }
  if (input.modelPolicy) {
    assertManifestModelPolicy(input.manifestPolicy, input.modelPolicy);
  }

  const blockingRelations = await tx
    .select({ sourceTaskId: taskRelationTable.sourceTaskId })
    .from(taskRelationTable)
    .where(
      and(
        eq(taskRelationTable.targetTaskId, input.taskId),
        eq(taskRelationTable.relationType, "blocks"),
      ),
    );
  const sourceTaskIds = [
    ...new Set(blockingRelations.map((row) => row.sourceTaskId)),
  ];
  if (sourceTaskIds.length === 0) return;

  const sourceTasks = await tx
    .select({
      id: taskTable.id,
      status: taskTable.status,
      columnId: taskTable.columnId,
    })
    .from(taskTable)
    .where(inArray(taskTable.id, sourceTaskIds));
  const columnIds = sourceTasks
    .map((task) => task.columnId)
    .filter((columnId): columnId is string => Boolean(columnId));
  const finalColumns = columnIds.length
    ? await tx
        .select({ id: columnTable.id, isFinal: columnTable.isFinal })
        .from(columnTable)
        .where(inArray(columnTable.id, columnIds))
    : [];
  const finalColumnIds = new Set(
    finalColumns.filter((column) => column.isFinal).map((column) => column.id),
  );
  const unsatisfied = sourceTasks.filter(
    (task) =>
      task.status !== "done" &&
      task.status !== "archived" &&
      !finalColumnIds.has(task.columnId ?? ""),
  );
  if (unsatisfied.length > 0) {
    throw new ScheduleEligibilityError(
      `Scheduled task dependency gate is not satisfied: ${unsatisfied
        .map((task) => task.id)
        .join(", ")}`,
    );
  }
}

type ResumeFallbackEvidence = {
  scheduleId: string;
  fromRunId: string;
  model: string;
  failedModel: string;
  failureKind: string;
  fallbackIndex: number;
};

type ClaimTaskRunInput = {
  taskId: string;
  userId: string;
  agentPrincipalId: string;
  scope: unknown;
  requestKey: string;
  expectedHostId?: string;
  scheduleDispatch?: boolean;
  scheduleId?: string;
  concurrencyKey?: string;
  modelPolicy?: ScheduleRunModelPolicy;
  resumeFromRunId?: string;
  resumeBranchName?: string;
  resumeBaseSha?: string | null;
  resumeCommitSha?: string | null;
  logicalSessionId?: string | null;
  resumeFallback?: ResumeFallbackEvidence;
};

export async function claimTaskRun(
  input: ClaimTaskRunInput,
  transaction?: ExecutionTransaction,
) {
  const {
    taskId,
    userId,
    agentPrincipalId,
    scope,
    requestKey,
    expectedHostId,
    scheduleDispatch = false,
    scheduleId,
    concurrencyKey,
    modelPolicy,
    resumeFromRunId,
    resumeBranchName,
    resumeBaseSha,
    resumeCommitSha,
    logicalSessionId,
    resumeFallback,
  } = input;
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
    scheduleId: scheduleId ?? null,
    modelPolicy: modelPolicy ?? null,
    expectedHostId: expectedHostId ?? null,
    resumeFromRunId: resumeFromRunId ?? null,
    resumeBranchName: resumeBranchName ?? null,
    resumeBaseSha: resumeBaseSha ?? null,
    resumeCommitSha: resumeCommitSha ?? null,
    logicalSessionId: logicalSessionId ?? null,
    resumeFallback: resumeFallback ?? null,
  });

  const execute = async (tx: ExecutionTransaction) => {
    if (concurrencyKey) {
      if (!scheduleId) {
        throw new HTTPException(400, {
          message: "scheduleId is required with concurrencyKey",
        });
      }
      // Serialize dispatches sharing a key. v1 intentionally uses a
      // conservative single-flight limit; T7 can widen this with an explicit
      // max-concurrency policy without changing the fencing contract.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${concurrencyKey}))`,
      );
    }

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
      if (expectedHostId && existingRequest.hostId !== expectedHostId) {
        throw new HTTPException(409, {
          message: "Idempotency-Key belongs to a different host binding",
        });
      }
      // SPEC-kaneo-wavefix-v0-2 (T7): bounded recovery — an endlessly
      // recycling run must escalate to the parent instead of adopting
      // forever (each recovery burns quota and may repeat the same crash).
      const MAX_RECOVERY_EPOCH = 4;
      if (
        scheduleDispatch &&
        existingRequest.agentPrincipalId === agentPrincipalId &&
        (existingRequest.state === "in_progress" ||
          existingRequest.state === "orphaned") &&
        existingRequest.leaseEpoch < MAX_RECOVERY_EPOCH &&
        (!existingRequest.leaseActive ||
          isLeaseExpired(existingRequest.leaseExpiresAt))
      ) {
        await tx
          .select({ id: taskTable.id })
          .from(taskTable)
          .where(eq(taskTable.id, existingRequest.taskId))
          .for("update");
        const recoveryToken = createLeaseToken();
        const [recoveredRun] = await tx
          .update(taskRunTable)
          .set({
            state: "in_progress",
            leaseActive: true,
            leaseEpoch: existingRequest.leaseEpoch + 1,
            leaseTokenHash: recoveryToken.hash,
            leaseExpiresAt: getLeaseExpiry(),
            lastHeartbeatAt: new Date(),
            lastProgressAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(taskRunTable.id, existingRequest.id),
              eq(taskRunTable.leaseEpoch, existingRequest.leaseEpoch),
            ),
          )
          .returning();
        if (!recoveredRun) {
          throw new HTTPException(409, {
            message: "Scheduled run changed before lease recovery",
          });
        }
        return { run: recoveredRun, leaseToken: recoveryToken.raw };
      }
      return { run: existingRequest, leaseToken: null };
    }

    if (scheduleDispatch && !scheduleId) {
      throw new HTTPException(400, {
        message: "scheduleDispatch requires scheduleId",
      });
    }

    // Serialize claims for one task before checking the partial active-lease index.
    await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .for("update");

    let taskContext: Awaited<ReturnType<typeof getTaskContext>>;
    try {
      taskContext = await getTaskContext(taskId, tx);
      await assertTaskClaimable(tx, {
        projectId: taskContext.task.projectId,
        status: taskContext.task.status,
      });
      if (scheduleDispatch) {
        await assertScheduledTaskEligible(tx, {
          taskId: taskContext.task.id,
          status: taskContext.task.status,
          description: taskContext.task.description,
          scope: normalizedScope,
          manifestPolicy: taskContext.manifest.policy ?? {},
          modelPolicy,
        });
      }
    } catch (error) {
      if (scheduleDispatch && error instanceof HTTPException) {
        throw new ScheduleEligibilityError(error.message);
      }
      throw error;
    }
    const { task, manifest, integration } = taskContext;
    let principal: Awaited<ReturnType<typeof getOwnedPrincipal>>;
    try {
      principal = await getOwnedPrincipal(userId, agentPrincipalId, tx);
      if (expectedHostId && principal.hostId !== expectedHostId) {
        throw new HTTPException(403, {
          message: "Agent principal host does not match schedule host",
        });
      }
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
    } catch (error) {
      if (scheduleDispatch && error instanceof HTTPException) {
        throw new ScheduleEligibilityError(error.message);
      }
      throw error;
    }

    if (concurrencyKey && scheduleId) {
      const [activeConcurrency] = await tx
        .select({ runId: taskRunTable.id })
        .from(taskRunTable)
        .innerJoin(
          executionScheduleTable,
          eq(taskRunTable.scheduleId, executionScheduleTable.id),
        )
        .where(
          and(
            eq(executionScheduleTable.concurrencyKey, concurrencyKey),
            ne(executionScheduleTable.id, scheduleId),
            eq(taskRunTable.leaseActive, true),
            gt(taskRunTable.leaseExpiresAt, new Date()),
          ),
        )
        .limit(1);
      if (activeConcurrency) {
        throw new HTTPException(409, {
          message: `Concurrency key is already active: ${concurrencyKey}`,
        });
      }
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
      // Scheduled dispatch creates the durable run before the ProDesk Pi
      // process starts. The worker then calls the normal claim endpoint with
      // its own idempotency key. A normal claim may adopt only a run that was
      // created by a schedule; a dispatcher retry must additionally match the
      // exact schedule id. This prevents a second schedule or manual run from
      // rotating another run's lease token.
      const isScheduledHandoff =
        activeRun.scheduleId !== null &&
        (!scheduleDispatch || activeRun.scheduleId === scheduleId);
      if (
        isScheduledHandoff &&
        activeRun.state === "in_progress" &&
        activeRun.agentPrincipalId === principal.id &&
        JSON.stringify([...activeRun.scope].sort()) ===
          JSON.stringify([...normalizedScope].sort()) &&
        !isLeaseExpired(activeRun.leaseExpiresAt)
      ) {
        const adoptionToken = createLeaseToken();
        const [adoptedRun] = await tx
          .update(taskRunTable)
          .set({
            leaseTokenHash: adoptionToken.hash,
            leaseExpiresAt: getLeaseExpiry(),
            lastHeartbeatAt: new Date(),
            lastProgressAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(taskRunTable.id, activeRun.id),
              eq(taskRunTable.leaseEpoch, activeRun.leaseEpoch),
              eq(taskRunTable.leaseActive, true),
            ),
          )
          .returning();
        if (!adoptedRun) {
          throw new HTTPException(409, {
            message: "Task run changed before worker adoption",
          });
        }
        return { run: adoptedRun, leaseToken: adoptionToken.raw };
      }

      if (!isLeaseExpired(activeRun.leaseExpiresAt)) {
        await recordExecutionMetric("lease_conflict", {
          taskId,
          activeRunId: activeRun.id,
        });
        throw new HTTPException(409, {
          message: "Task already has an active worker lease",
        });
      }
      const [orphanedRun] = await tx
        .update(taskRunTable)
        .set({
          leaseActive: false,
          state: "orphaned",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(taskRunTable.id, activeRun.id),
            eq(taskRunTable.leaseEpoch, activeRun.leaseEpoch),
            eq(taskRunTable.leaseActive, true),
          ),
        )
        .returning({ id: taskRunTable.id });
      if (!orphanedRun) {
        await recordExecutionMetric("lease_conflict", {
          taskId,
          activeRunId: activeRun.id,
          reason: "takeover_race",
        });
        throw new HTTPException(409, {
          message: "Task run lease changed before takeover",
        });
      }
    }

    let resumeSource:
      | { taskId: string; attempt: number; maxAttempts: number }
      | undefined;
    if (resumeFromRunId) {
      const [source] = await tx
        .select({
          taskId: taskRunTable.taskId,
          attempt: taskRunTable.attempt,
          maxAttempts: taskRunTable.maxAttempts,
        })
        .from(taskRunTable)
        .where(eq(taskRunTable.id, resumeFromRunId))
        .limit(1);
      if (!source || source.taskId !== taskId) {
        throw new HTTPException(404, {
          message: "Resume source task run not found for task",
        });
      }
      resumeSource = source;
    }
    const policyMaxAttempts = modelPolicy?.retryPolicy?.maxAttempts;
    const configuredMaxAttempts =
      typeof policyMaxAttempts === "number" &&
      Number.isInteger(policyMaxAttempts) &&
      policyMaxAttempts >= 1
        ? policyMaxAttempts
        : 1;
    const runAttempt = resumeSource ? resumeSource.attempt + 1 : 1;
    const runMaxAttempts = Math.max(
      resumeSource?.maxAttempts ?? 1,
      configuredMaxAttempts,
    );
    const runId = createId();
    const branchName = resumeBranchName
      ? validateBranchName(resumeBranchName, "resumeBranchName")
      : `${principal.runtimeId}/${taskId}-${runId}-${taskSlug(task.title)}`;
    const leaseToken = createLeaseToken();
    const [run] = await tx
      .insert(taskRunTable)
      .values({
        id: runId,
        taskId,
        scheduleId: scheduleId ?? null,
        manifestId: manifest.id,
        manifestVersion: manifest.manifestVersion,
        protocolVersion: manifest.protocolVersion,
        repositoryOwner: integration.repositoryOwner,
        repositoryName: integration.repositoryName,
        baseBranch: manifest.baseBranch,
        state: "in_progress",
        role: "worker",
        parentRunId: resumeFromRunId ?? null,
        logicalSessionId: logicalSessionId ?? null,
        attempt: runAttempt,
        maxAttempts: runMaxAttempts,
        agentPrincipalId: principal.id,
        hostId: principal.hostId,
        branchName,
        scope: normalizedScope,
        baseSha: resumeBaseSha ?? null,
        commitSha: resumeCommitSha ?? null,
        requestKey,
        requestHash,
        leaseEpoch: nextLeaseEpoch,
        leaseTokenHash: leaseToken.hash,
        evidence: {
          ...(resumeFromRunId
            ? {
                resume: {
                  fromRunId: resumeFromRunId,
                  branchName,
                  baseSha: resumeBaseSha ?? null,
                  commitSha: resumeCommitSha ?? null,
                  preferredModel: modelPolicy?.preferredModel ?? null,
                  fallbackMode: modelPolicy?.fallbackMode ?? "manual",
                  fallbackModels: modelPolicy?.fallbackModels ?? [],
                },
              }
            : {}),
          ...(resumeFallback ? { fallback: resumeFallback } : {}),
          ...(scheduleDispatch
            ? {
                schedule: {
                  scheduleId: scheduleId ?? null,
                  preferredModel: modelPolicy?.preferredModel ?? null,
                  fallbackMode: modelPolicy?.fallbackMode ?? "manual",
                  fallbackModels: modelPolicy?.fallbackModels ?? [],
                  maxRuntimeSeconds: modelPolicy?.maxRuntimeSeconds ?? null,
                  concurrencyKey: modelPolicy?.concurrencyKey ?? null,
                  retryPolicy: modelPolicy?.retryPolicy ?? {},
                },
              }
            : {}),
        },
        leaseActive: true,
        leaseExpiresAt: getLeaseExpiry(),
        lastHeartbeatAt: new Date(),
        lastProgressAt: new Date(),
      })
      .returning();
    if (!run) {
      throw new HTTPException(500, { message: "Task run was not created" });
    }

    return { run, leaseToken: leaseToken.raw };
  };
  const result = transaction
    ? await execute(transaction)
    : await db.transaction(execute);
  if (!transaction) {
    await publishTaskRunUpdated(
      taskId,
      result.run.id,
      userId,
      result.run.state,
    );
  }
  return result;
}

export async function resumeTaskRun(input: {
  taskId: string;
  sourceRunId: string;
  userId: string;
  agentPrincipalId: string;
  preferredModel?: string | null;
  /** "telegram" enables the continue_quota policy gate; parent resumes are
   * unrestricted (SPEC-kaneo-native-telegram-control-v0-1 T5). */
  initiatedBy?: unknown;
  contextNote?: unknown;
  requestKey: string;
}) {
  const requestKey = requireIdempotencyKey(input.requestKey);
  let telegramInitiated = false;
  if (input.initiatedBy !== undefined) {
    if (input.initiatedBy !== "telegram" && input.initiatedBy !== "parent") {
      throw new HTTPException(400, {
        message: 'initiatedBy must be "telegram" or "parent"',
      });
    }
    telegramInitiated = input.initiatedBy === "telegram";
  }
  let boundedContextNote: string | undefined;
  if (input.contextNote !== undefined) {
    if (
      typeof input.contextNote !== "string" ||
      !input.contextNote.trim() ||
      input.contextNote.length > 2_000
    ) {
      throw new HTTPException(400, {
        message:
          "contextNote must be a bounded non-empty string (<= 2000 chars)",
      });
    }
    boundedContextNote = input.contextNote.trim();
  }
  const [source] = await db
    .select()
    .from(taskRunTable)
    .where(
      and(
        eq(taskRunTable.id, input.sourceRunId),
        eq(taskRunTable.taskId, input.taskId),
      ),
    )
    .limit(1);
  if (!source) {
    throw new HTTPException(404, { message: "Source task run not found" });
  }
  const resumableStates = new Set([
    "blocked",
    "blocked_quota",
    "blocked_input",
    "blocked_clarification",
    "blocked_branch_drift",
    "failed",
    "orphaned",
  ]);
  if (!resumableStates.has(source.state)) {
    throw new HTTPException(409, {
      message: `Task run state ${source.state} is not resumable`,
    });
  }
  if (source.leaseActive) {
    throw new HTTPException(409, {
      message: "Cannot resume a run while its lease is active",
    });
  }
  const sourceEvidence = asEvidenceRecord(source.evidence);
  const scheduleEvidence = asEvidenceRecord(sourceEvidence.schedule);
  const supervisorReceipt = asEvidenceRecord(sourceEvidence.supervisorReceipt);
  const sourceLogicalSessionId =
    typeof source.logicalSessionId === "string" && source.logicalSessionId
      ? source.logicalSessionId
      : typeof supervisorReceipt.logicalSessionId === "string" &&
          supervisorReceipt.logicalSessionId
        ? supervisorReceipt.logicalSessionId
        : null;
  const scheduleRetryPolicy = readRetryPolicy(scheduleEvidence.retryPolicy);
  const effectiveMaxAttempts = Math.max(
    source.maxAttempts,
    scheduleRetryPolicy.maxAttempts ?? 1,
  );

  // SPEC-kaneo-native-telegram-control-v0-1 (T5): a Telegram-initiated quota
  // continue is fail-closed against schedule policy, retryAt and attempts.
  if (telegramInitiated && source.state === "blocked_quota") {
    if (source.retryAt && source.retryAt.getTime() > Date.now()) {
      throw new HTTPException(409, {
        message: "continue_quota is not allowed before retryAt",
      });
    }
    if (source.attempt >= effectiveMaxAttempts) {
      throw new HTTPException(409, {
        message: "quota resume attempts are exhausted (maxAttempts reached)",
      });
    }
    if (!source.scheduleId) {
      throw new HTTPException(403, {
        message:
          "quota resume requires a schedule with an explicit Telegram quota-resume policy",
      });
    }
    const [schedule] = await db
      .select({
        telegramQuotaResume: executionScheduleTable.telegramQuotaResume,
      })
      .from(executionScheduleTable)
      .where(eq(executionScheduleTable.id, source.scheduleId))
      .limit(1);
    if (schedule?.telegramQuotaResume !== "allowed_same_model_after_reset") {
      throw new HTTPException(403, {
        message: "Telegram quota resume is disabled for this schedule",
      });
    }
  }
  if (
    !source.agentPrincipalId ||
    source.agentPrincipalId !== input.agentPrincipalId
  ) {
    throw new HTTPException(403, {
      message: "Resume must keep the original worker principal and branch",
    });
  }
  const preferredModel =
    input.preferredModel === undefined || input.preferredModel === null
      ? input.preferredModel === null
        ? null
        : typeof scheduleEvidence.preferredModel === "string"
          ? validateModelId(scheduleEvidence.preferredModel, "preferredModel")
          : null
      : validateModelId(input.preferredModel, "preferredModel");
  const maxRuntimeSeconds = Number.isInteger(scheduleEvidence.maxRuntimeSeconds)
    ? (scheduleEvidence.maxRuntimeSeconds as number)
    : 3600;
  const modelPolicy: ScheduleRunModelPolicy = {
    preferredModel,
    fallbackMode: "manual",
    fallbackModels: [],
    maxRuntimeSeconds,
    concurrencyKey: `resume:${input.taskId}`,
    retryPolicy: scheduleRetryPolicy,
  };
  const context = await getTaskContext(input.taskId);
  assertManifestModelPolicy(context.manifest.policy ?? {}, modelPolicy);
  const result = await claimTaskRun({
    taskId: input.taskId,
    userId: input.userId,
    agentPrincipalId: input.agentPrincipalId,
    scope: source.scope,
    requestKey,
    expectedHostId: source.hostId,
    modelPolicy,
    scheduleId: source.scheduleId ?? undefined,
    resumeFromRunId: source.id,
    // No resumeBranchName: claimTaskRun generates a new branch containing the
    // new run ID, so an old run worktree/branch can never block recovery.
    resumeBaseSha: source.lastCheckpointSha ?? source.baseSha,
    resumeCommitSha: source.commitSha,
    logicalSessionId: sourceLogicalSessionId,
  });
  if (boundedContextNote) {
    await db
      .update(taskRunTable)
      .set({
        evidence: {
          ...(result.run.evidence ?? {}),
          resumeContext: {
            note: boundedContextNote,
            by: input.initiatedBy ?? "parent",
          },
        },
        runRevision: sql`${taskRunTable.runRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(taskRunTable.id, result.run.id));
  }
  // SPEC-kaneo-native-telegram-control-v0-1 (T5): a Telegram resume must
  // actually spawn a worker on the host. Bind a dispatched occurrence with a
  // one-time supervisor fence + ack token (same fencing shape as a schedule
  // dispatch) so the calling dispatcher can precreate the worktree, write the
  // 0600 handoff and acknowledge the spawn. Parent resumes keep the old
  // semantics (host spawn is arranged by the parent flow, not this route).
  let dispatch: ResumeDispatchMetadata | null = null;
  if (telegramInitiated && source.scheduleId) {
    dispatch = await bindResumeDispatchOccurrence({
      source,
      run: result.run,
    });
  }
  await publishTaskRunUpdated(
    input.taskId,
    result.run.id,
    input.userId,
    result.run.state,
  );
  return { run: result.run, leaseToken: result.leaseToken, dispatch };
}

export type ResumeDispatchMetadata = {
  scheduleId: string;
  occurrenceId: string;
  ackToken: string;
  runnerSupervisorFence: string;
  preferredModel: string | null;
  maxRuntimeSeconds: number;
};

async function bindResumeDispatchOccurrence({
  source,
  run,
}: {
  source: typeof taskRunTable.$inferSelect;
  run: typeof taskRunTable.$inferSelect;
}): Promise<ResumeDispatchMetadata | null> {
  const scheduleId = source.scheduleId;
  if (!scheduleId) return null;
  const ackToken = randomBytes(32).toString("base64url");
  const supervisorFence = randomBytes(32).toString("base64url");
  const [occurrence] = await db
    .insert(executionScheduleOccurrenceTable)
    .values({
      id: createId(),
      scheduleId,
      // Unique per resumed run; keeps the resume fence separate from the
      // original one-shot occurrence key.
      occurrenceKey: `${scheduleId}:resume:${run.id}`,
      scheduledFor: new Date(),
      state: "dispatched",
      claimedBy: `dispatcher:${source.agentPrincipalId}`,
      claimedAt: new Date(),
      claimGeneration: 1,
      scheduleRevision: run.scheduleRevision ?? 1,
      taskRevision: run.taskRevisionAtClaim,
      manifestVersion: run.manifestVersion,
      supervisorFenceHash: stableHash(supervisorFence),
      ackTokenHash: stableHash(ackToken),
      runId: run.id,
    })
    .onConflictDoNothing({
      target: executionScheduleOccurrenceTable.occurrenceKey,
    })
    .returning();
  if (!occurrence) return null;
  const scheduleEvidence = asEvidenceRecord(
    asEvidenceRecord(source.evidence).schedule,
  );
  return {
    scheduleId,
    occurrenceId: occurrence.id,
    ackToken,
    runnerSupervisorFence: supervisorFence,
    preferredModel:
      typeof scheduleEvidence.preferredModel === "string"
        ? scheduleEvidence.preferredModel
        : null,
    maxRuntimeSeconds: Number.isInteger(scheduleEvidence.maxRuntimeSeconds)
      ? (scheduleEvidence.maxRuntimeSeconds as number)
      : 3600,
  };
}

const PREAPPROVED_FALLBACK_FAILURE_KINDS = new Set([
  "provider_quota",
  "provider_timeout",
  "provider_5xx",
]);

function asEvidenceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readRetryPolicy(value: unknown): Record<string, number> {
  const record = asEvidenceRecord(value);
  const policy: Record<string, number> = {};
  for (const key of ["maxAttempts", "backoffSeconds"] as const) {
    const candidate = record[key];
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 1
    ) {
      policy[key] = candidate;
    }
  }
  return policy;
}

function readWorkerFailureKind(
  evidence: Record<string, unknown>,
): string | null {
  const worker = asEvidenceRecord(evidence.worker);
  const candidate = worker.failureKind ?? evidence.failureKind;
  return typeof candidate === "string" ? candidate : null;
}

function readFallbackIndex(evidence: Record<string, unknown>): number {
  const fallback = asEvidenceRecord(evidence.fallback);
  const value = fallback.fallbackIndex;
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : -1;
}

function readCurrentFallbackModel(
  evidence: Record<string, unknown>,
  preferredModel: string | null,
): string | null {
  const fallback = asEvidenceRecord(evidence.fallback);
  const model = fallback.model;
  if (typeof model === "string" && model.length > 0) return model;
  return preferredModel;
}

export async function listPreapprovedFallbackCandidates(host: string) {
  const rows = await db
    .select({
      runId: taskRunTable.id,
      taskId: taskRunTable.taskId,
      scheduleId: executionScheduleTable.id,
      agentPrincipalId: taskRunTable.agentPrincipalId,
      hostId: taskRunTable.hostId,
      scope: taskRunTable.scope,
      evidence: taskRunTable.evidence,
      state: taskRunTable.state,
      leaseActive: taskRunTable.leaseActive,
      leaseEpoch: taskRunTable.leaseEpoch,
      preferredModel: executionScheduleTable.preferredModel,
      fallbackModels: executionScheduleTable.fallbackModels,
      maxRuntimeSeconds: executionScheduleTable.maxRuntimeSeconds,
      scheduleHost: executionScheduleTable.host,
    })
    .from(taskRunTable)
    .innerJoin(
      executionScheduleTable,
      eq(taskRunTable.scheduleId, executionScheduleTable.id),
    )
    .where(
      and(
        eq(executionScheduleTable.host, host),
        eq(executionScheduleTable.fallbackMode, "preapproved"),
      ),
    )
    .orderBy(desc(taskRunTable.leaseEpoch))
    .limit(200);

  const latestByTask = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByTask.has(row.taskId)) latestByTask.set(row.taskId, row);
  }

  return [...latestByTask.values()]
    .map((row) => {
      const evidence = asEvidenceRecord(row.evidence);
      const fallbackEvidence = asEvidenceRecord(evidence.fallback);
      const fallbackModel =
        typeof fallbackEvidence.model === "string"
          ? fallbackEvidence.model
          : null;
      const action =
        row.state === "in_progress" && row.leaseActive && fallbackModel
          ? "spawn"
          : row.state === "blocked_quota" && !row.leaseActive
            ? "advance"
            : null;
      const fallbackFailureKind =
        typeof fallbackEvidence.failureKind === "string"
          ? fallbackEvidence.failureKind
          : null;
      const failureKind =
        readWorkerFailureKind(evidence) ?? fallbackFailureKind;
      const fallbackIndex = readFallbackIndex(evidence);
      const currentModel =
        fallbackModel ?? readCurrentFallbackModel(evidence, row.preferredModel);
      const nextModel =
        action === "advance"
          ? (row.fallbackModels[fallbackIndex + 1] ?? null)
          : null;
      return {
        action,
        runId: row.runId,
        taskId: row.taskId,
        scheduleId: row.scheduleId,
        agentPrincipalId: row.agentPrincipalId,
        hostId: row.hostId,
        scope: row.scope,
        state: row.state,
        leaseActive: row.leaseActive,
        leaseEpoch: row.leaseEpoch,
        failureKind,
        currentModel,
        fallbackIndex,
        nextModel,
        maxRuntimeSeconds: row.maxRuntimeSeconds,
        host: row.scheduleHost,
      };
    })
    .filter(
      (candidate) =>
        candidate.action !== null &&
        candidate.agentPrincipalId !== null &&
        candidate.hostId === candidate.host &&
        PREAPPROVED_FALLBACK_FAILURE_KINDS.has(candidate.failureKind ?? ""),
    );
}

export async function advancePreapprovedFallback(input: {
  taskId: string;
  sourceRunId: string;
  userId: string;
  agentPrincipalId: string;
  requestKey: string;
}) {
  const requestKey = requireIdempotencyKey(input.requestKey);
  const requestHash = stableHash({
    taskId: input.taskId,
    sourceRunId: input.sourceRunId,
    agentPrincipalId: input.agentPrincipalId,
  });
  const result = await db.transaction(async (tx) => {
    await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(eq(taskTable.id, input.taskId))
      .for("update");
    const [source] = await tx
      .select()
      .from(taskRunTable)
      .where(
        and(
          eq(taskRunTable.id, input.sourceRunId),
          eq(taskRunTable.taskId, input.taskId),
        ),
      )
      .limit(1)
      .for("update");
    if (!source) {
      throw new HTTPException(404, { message: "Source task run not found" });
    }
    if (
      !source.agentPrincipalId ||
      source.agentPrincipalId !== input.agentPrincipalId
    ) {
      throw new HTTPException(403, {
        message: "Fallback must keep the original worker principal",
      });
    }
    const principal = await getOwnedPrincipal(
      input.userId,
      source.agentPrincipalId,
      tx,
    );
    if (!principal.scopes.includes("run:claim")) {
      throw new HTTPException(403, {
        message: "Agent principal lacks run:claim scope",
      });
    }

    const replay = await getIdempotencyReplay(tx, {
      userId: input.userId,
      operation: IDEMPOTENCY_OPERATIONS.preapprovedFallback,
      requestKey,
      requestHash,
      runId: source.id,
    });
    if (replay) {
      return { outcome: "replayed" as const, run: replay };
    }

    if (source.state !== "blocked_quota" || source.leaseActive) {
      throw new HTTPException(409, {
        message: "Preapproved fallback requires a released blocked_quota run",
      });
    }
    if (!source.scheduleId) {
      throw new HTTPException(409, {
        message: "Preapproved fallback requires a scheduled run",
      });
    }
    const [schedule] = await tx
      .select()
      .from(executionScheduleTable)
      .where(eq(executionScheduleTable.id, source.scheduleId))
      .limit(1);
    if (schedule?.fallbackMode !== "preapproved") {
      throw new HTTPException(409, {
        message: "The source schedule does not allow preapproved fallback",
      });
    }
    if (schedule.host !== source.hostId) {
      throw new HTTPException(409, {
        message: "Source run host does not match its schedule host",
      });
    }

    const evidence = asEvidenceRecord(source.evidence);
    const failureKind = readWorkerFailureKind(evidence);
    if (!PREAPPROVED_FALLBACK_FAILURE_KINDS.has(failureKind ?? "")) {
      throw new HTTPException(409, {
        message: "The worker failure is not eligible for preapproved fallback",
      });
    }
    const normalizedFailureKind = failureKind as string;
    const fallbackIndex = readFallbackIndex(evidence);
    const currentModel = readCurrentFallbackModel(
      evidence,
      schedule.preferredModel,
    );
    if (!currentModel) {
      throw new HTTPException(409, {
        message: "Preapproved fallback requires a preferred model",
      });
    }
    const failedModel = currentModel as string;
    const nextIndex = fallbackIndex + 1;
    const nextModel = schedule.fallbackModels[nextIndex];
    if (!nextModel) {
      const [exhausted] = await tx
        .update(taskRunTable)
        .set({
          state: "failed",
          blocker: "preapproved_fallback_exhausted",
          nextAction: "Parent must choose a model and resume manually",
          evidence: {
            ...evidence,
            fallback: {
              scheduleId: schedule.id,
              fromRunId: source.id,
              model: currentModel,
              failedModel: currentModel,
              failureKind: normalizedFailureKind,
              fallbackIndex,
              exhausted: true,
            },
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(taskRunTable.id, source.id),
            eq(taskRunTable.state, "blocked_quota"),
            eq(taskRunTable.leaseActive, false),
          ),
        )
        .returning();
      if (!exhausted) {
        throw new HTTPException(409, {
          message: "Source run changed before fallback exhaustion was recorded",
        });
      }
      await tx.insert(taskRunEvidenceTable).values({
        runId: source.id,
        agentPrincipalId: principal.id,
        kind: "preapproved_fallback_exhausted",
        payload: {
          failureKind: normalizedFailureKind,
          fallbackIndex,
          model: currentModel,
        },
      });
      const response = serializeRun(exhausted);
      await saveIdempotencyResponse(tx, {
        userId: input.userId,
        agentPrincipalId: principal.id,
        runId: source.id,
        operation: IDEMPOTENCY_OPERATIONS.preapprovedFallback,
        requestKey,
        requestHash,
        response,
      });
      return { outcome: "exhausted" as const, run: response };
    }
    validateModelId(nextModel, "fallback model");
    if (nextModel === currentModel) {
      throw new HTTPException(409, {
        message: "Fallback model list repeats the failed model",
      });
    }
    const taskContext = await getTaskContext(input.taskId, tx);
    const modelPolicy: ScheduleRunModelPolicy = {
      preferredModel: nextModel,
      fallbackMode: "preapproved",
      fallbackModels: schedule.fallbackModels.slice(nextIndex + 1),
      maxRuntimeSeconds: schedule.maxRuntimeSeconds,
      concurrencyKey: schedule.concurrencyKey,
      retryPolicy: (schedule.retryPolicy ?? {}) as Record<string, number>,
    };
    assertManifestModelPolicy(taskContext.manifest.policy ?? {}, modelPolicy);
    const fallbackRequestKey = `preapproved-fallback:${source.id}:${nextIndex}`;
    const claimed = await claimTaskRun(
      {
        taskId: input.taskId,
        userId: input.userId,
        agentPrincipalId: input.agentPrincipalId,
        scope: source.scope,
        requestKey: fallbackRequestKey,
        expectedHostId: schedule.host,
        scheduleId: schedule.id,
        concurrencyKey: schedule.concurrencyKey,
        modelPolicy,
        resumeFromRunId: source.id,
        // Fallback runs also receive a fresh branch; never reuse the source
        // branch that may still be checked out by its old worktree.
        resumeBaseSha: source.lastCheckpointSha ?? source.baseSha,
        resumeCommitSha: source.commitSha,
        logicalSessionId:
          source.logicalSessionId ??
          (typeof asEvidenceRecord(
            asEvidenceRecord(source.evidence).supervisorReceipt,
          ).logicalSessionId === "string"
            ? (asEvidenceRecord(
                asEvidenceRecord(source.evidence).supervisorReceipt,
              ).logicalSessionId as string)
            : null),
        resumeFallback: {
          scheduleId: schedule.id,
          fromRunId: source.id,
          model: nextModel,
          failedModel,
          failureKind: normalizedFailureKind,
          fallbackIndex: nextIndex,
        },
      },
      tx,
    );
    await tx.insert(taskRunEvidenceTable).values({
      runId: source.id,
      agentPrincipalId: principal.id,
      kind: "preapproved_fallback_dispatched",
      payload: {
        fromRunId: source.id,
        toRunId: claimed.run.id,
        model: nextModel,
        failedModel,
        failureKind: normalizedFailureKind,
        fallbackIndex: nextIndex,
      },
    });
    const response = serializeRun(claimed.run);
    await saveIdempotencyResponse(tx, {
      userId: input.userId,
      agentPrincipalId: principal.id,
      runId: source.id,
      operation: IDEMPOTENCY_OPERATIONS.preapprovedFallback,
      requestKey,
      requestHash,
      response,
    });
    return { outcome: "created" as const, run: response };
  });

  if (result.outcome === "created") {
    await publishTaskRunUpdated(
      input.taskId,
      result.run.id,
      input.userId,
      result.run.state,
    );
  } else if (result.outcome === "exhausted") {
    await publishTaskRunUpdated(
      input.taskId,
      input.sourceRunId,
      input.userId,
      result.run.state,
    );
  }
  return result;
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
    await recordExecutionMetric("stale_fence_rejected", {
      runId,
      taskId: run.taskId,
      reason: "expired_lease",
    });
    throw new HTTPException(409, { message: "Task run lease has expired" });
  }
  if (
    run.leaseEpoch !== normalizedLeaseEpoch ||
    hashLeaseToken(leaseToken) !== run.leaseTokenHash
  ) {
    await recordExecutionMetric("stale_fence_rejected", {
      runId,
      taskId: run.taskId,
      reason: "epoch_or_token_mismatch",
    });
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

  const result = await db.transaction(async (tx) => {
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
        lastProgressAt: now,
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
      await recordExecutionMetric("stale_fence_rejected", {
        runId,
        taskId,
        reason: "compare_and_swap_failed",
      });
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
  await publishTaskRunUpdated(taskId, result.id, userId, result.state);
  return result;
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
  failureKind,
  modelFailed,
  retryAt,
  expectedRunRevision,
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
  failureKind?: unknown;
  modelFailed?: unknown;
  retryAt?: unknown;
  expectedRunRevision?: unknown;
  requestKey: string;
}) {
  const nextState = validateWorkerReportState(state);
  assertReportState(nextState);
  const nextFailureKind = validateFailureKind(failureKind);
  let nextModelFailed: string | undefined;
  if (modelFailed !== undefined) {
    if (typeof modelFailed !== "string" || modelFailed.trim().length > 200) {
      throw new HTTPException(400, {
        message: "modelFailed must be a bounded string (<= 200 chars)",
      });
    }
    nextModelFailed = modelFailed.trim();
  }
  let nextRetryAt: Date | undefined;
  if (retryAt !== undefined) {
    if (typeof retryAt !== "string") {
      throw new HTTPException(400, {
        message: "retryAt must be an ISO timestamp",
      });
    }
    const parsed = new Date(retryAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new HTTPException(400, {
        message: "retryAt must be an ISO timestamp",
      });
    }
    nextRetryAt = parsed;
  }
  const expectedRevision = validateRevision(
    expectedRunRevision,
    "expectedRunRevision",
  );
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
    failureKind: nextFailureKind ?? null,
    modelFailed: nextModelFailed ?? null,
    retryAt: nextRetryAt?.toISOString() ?? null,
    expectedRunRevision: expectedRevision ?? null,
  });

  const result = await db.transaction(async (tx) => {
    if (nextCommitSha !== undefined) {
      await assertExecutionFlagEnabled(
        EXECUTION_FLAGS.gitPush,
        { taskId, runId },
        tx,
      );
    }

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
    // SPEC-kaneo-wavefix-v0-2 (T0): centralized lifecycle enforcement — a
    // worker report may never move a run through an unlisted transition
    // (e.g. finalized -> in_progress); resume paths must go through
    // claimTaskRun so the old epoch is fenced.
    if (!isRunTransitionAllowed(run.state as TaskRunState, nextState)) {
      throw new HTTPException(409, {
        message: `run_transition_rejected: ${run.state} -> ${nextState}`,
      });
    }
    const now = new Date();
    const nextEvidence =
      evidence === undefined
        ? run.evidence
        : {
            ...run.evidence,
            worker: validateJsonObject(evidence, "evidence"),
          };
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
        failureKind: nextFailureKind ?? run.failureKind,
        modelFailed: nextModelFailed ?? run.modelFailed,
        retryAt: nextRetryAt ?? run.retryAt,
        lastCommitSha: nextCommitSha ?? run.lastCommitSha,
        manualRecoveryRequired:
          nextState === "failed" || nextState.startsWith("blocked_")
            ? true
            : run.manualRecoveryRequired,
        leaseActive: nextState === "in_progress",
        lastHeartbeatAt: now,
        lastProgressAt: now,
        leaseExpiresAt: getLeaseExpiry(now),
        runRevision: sql`${taskRunTable.runRevision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(taskRunTable.id, runId),
          eq(taskRunTable.leaseEpoch, normalizedLeaseEpoch),
          eq(taskRunTable.leaseTokenHash, leaseTokenHash),
          eq(taskRunTable.leaseActive, true),
          ...(expectedRevision === undefined
            ? []
            : [eq(taskRunTable.runRevision, expectedRevision)]),
        ),
      )
      .returning();
    if (!updated) {
      await recordExecutionMetric("stale_fence_rejected", {
        runId,
        taskId,
        reason: "compare_and_swap_failed",
      });
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

    // Kanban is presentation-only and never bumps task_revision, but the
    // board must follow the run lifecycle: worker-terminal in_review moves
    // the card to In Review for the parent gate.
    if (nextState === "in_review") {
      await tx
        .update(taskTable)
        .set({ status: "in-review", updatedAt: now })
        .where(eq(taskTable.id, taskId));
      // SPEC-kaneo-wavefix-v0-2 (T8): board cards must update in real time.
      // Without this event the execution path mutated the row silently and
      // the UI stayed stale until a manual reload.
      const [taskRow] = await tx
        .select({ projectId: taskTable.projectId })
        .from(taskTable)
        .where(eq(taskTable.id, taskId))
        .limit(1);
      if (taskRow) {
        await publishEvent("task.status_changed", {
          taskId,
          projectId: taskRow.projectId,
          userId,
          oldStatus: "in-progress",
          newStatus: "in-review",
          type: "status_changed",
        });
      }
    }

    // Transactional outbox: worker-reachable notifications. The supervisor
    // sweep covers crashed workers; this covers every live worker report.
    if (nextState === "in_review") {
      await enqueueNotificationEvent(tx, {
        taskId,
        runId,
        kind: "in_review",
        payload: {
          taskId,
          runId,
          branch: run.branchName,
          commitSha: nextCommitSha ?? run.commitSha,
        },
      });
    } else if (nextState !== "in_progress") {
      await enqueueNotificationEvent(tx, {
        taskId,
        runId,
        kind:
          nextState === "blocked_quota"
            ? "blocked_quota"
            : nextState === "blocked_input" ||
                nextState === "blocked_clarification"
              ? "needs_input"
              : "failed",
        payload: {
          taskId,
          runId,
          finalState: nextState,
          failureKind: nextFailureKind ?? null,
          retryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
          lastCheckpointSha: run.lastCheckpointSha,
          blocker: blocker ?? null,
        },
      });
    }

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
  await publishTaskRunUpdated(taskId, result.id, userId, result.state);
  return result;
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
  const nextState = state === undefined ? undefined : validateRunState(state);
  if (nextState === undefined) {
    throw new HTTPException(400, {
      message:
        "A canonical release state is required: blocked_quota, blocked_input, blocked_clarification, blocked_branch_drift, failed, cancelled or superseded",
    });
  }
  if (nextState === "finalized" || nextState === "rejected") {
    throw new HTTPException(403, {
      message: "Only a parent review gate can finalize or reject a task run",
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

  const result = await db.transaction(async (tx) => {
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
      await recordExecutionMetric("stale_fence_rejected", {
        runId,
        taskId,
        reason: "compare_and_swap_failed",
      });
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
  await publishTaskRunUpdated(taskId, result.id, userId, result.state);
  return result;
}

/**
 * SPEC-kaneo-native-telegram-control-v0-1 (T1): durable worker checkpoint.
 * Only accepted with a fixed Git guard push receipt proving the remote branch
 * HEAD equals the checkpoint commit; lease epoch + optional run revision CAS
 * fence the write. Idempotent per requestKey.
 */
export async function createTaskRunCheckpoint({
  taskId,
  runId,
  userId,
  leaseEpoch,
  leaseToken,
  baseSha,
  headSha,
  commitSha,
  guardReceipt,
  commands,
  artifactHashes,
  verifyResult,
  expectedRunRevision,
  requestKey,
}: {
  taskId: string;
  runId: string;
  userId: string;
  leaseEpoch: number;
  leaseToken: string;
  baseSha?: unknown;
  headSha: unknown;
  commitSha: unknown;
  guardReceipt: unknown;
  commands?: unknown;
  artifactHashes?: unknown;
  verifyResult?: unknown;
  expectedRunRevision?: unknown;
  requestKey: string;
}): Promise<TaskRunResponse> {
  const normalizedHeadSha = validateGitSha(headSha, "headSha");
  const normalizedCommitSha = validateGitSha(commitSha, "commitSha");
  const normalizedBaseSha = validateGitSha(baseSha, "baseSha");
  if (!normalizedHeadSha || !normalizedCommitSha) {
    throw new HTTPException(400, {
      message: "headSha and commitSha are required for a checkpoint",
    });
  }
  if (normalizedHeadSha.toLowerCase() !== normalizedCommitSha.toLowerCase()) {
    throw new HTTPException(409, {
      message:
        "headSha must equal commitSha: the push is not verified as durable on the remote",
    });
  }
  const receipt = validateJsonObject(guardReceipt, "guardReceipt");
  for (const field of [
    "receiptId",
    "remoteRef",
    "headSha",
    "commitSha",
    "receiptHash",
  ]) {
    if (typeof receipt[field] !== "string" || !receipt[field]) {
      throw new HTTPException(400, {
        message: `guardReceipt.${field} is required`,
      });
    }
  }
  if (
    typeof receipt.headSha === "string" &&
    receipt.headSha.toLowerCase() !== normalizedHeadSha.toLowerCase()
  ) {
    throw new HTTPException(409, {
      message: "guardReceipt.headSha must match the checkpoint headSha",
    });
  }
  if (
    typeof receipt.commitSha === "string" &&
    receipt.commitSha.toLowerCase() !== normalizedCommitSha.toLowerCase()
  ) {
    throw new HTTPException(409, {
      message: "guardReceipt.commitSha must match the checkpoint commitSha",
    });
  }
  const boundedCommands = commands === undefined ? [] : validateDocs(commands);
  const boundedArtifacts =
    artifactHashes === undefined
      ? {}
      : validateJsonObject(artifactHashes, "artifactHashes");
  const boundedVerify =
    verifyResult === undefined
      ? {}
      : validateJsonObject(verifyResult, "verifyResult");
  const expectedRevision = validateRevision(
    expectedRunRevision,
    "expectedRunRevision",
  );
  const normalizedKey = requireIdempotencyKey(requestKey);
  const normalizedLeaseEpoch = validateLeaseEpoch(leaseEpoch);
  const leaseTokenHash = hashLeaseToken(leaseToken);
  const requestHash = stableHash({
    taskId,
    runId,
    leaseEpoch: normalizedLeaseEpoch,
    leaseTokenHash,
    headSha: normalizedHeadSha,
    commitSha: normalizedCommitSha,
    baseSha: normalizedBaseSha ?? null,
    guardReceipt,
    expectedRunRevision: expectedRevision ?? null,
  });

  const result = await db.transaction(async (tx) => {
    const replay = await getIdempotencyReplay(tx, {
      userId,
      operation: IDEMPOTENCY_OPERATIONS.checkpoint,
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
    // T0: checkpoint reports follow the same centralized lifecycle rules.
    if (!isRunTransitionAllowed(run.state as TaskRunState, "checkpointed")) {
      throw new HTTPException(409, {
        message: `run_transition_rejected: ${run.state} -> checkpointed`,
      });
    }
    if (
      typeof receipt.remoteRef !== "string" ||
      receipt.remoteRef !== run.branchName
    ) {
      throw new HTTPException(409, {
        message: "guardReceipt.remoteRef must equal the run branchName",
      });
    }
    const nextState: TaskRunState = "checkpointed";
    const now = new Date();
    await tx.insert(taskRunCheckpointTable).values({
      runId,
      taskId,
      requestId: normalizedKey,
      leaseEpoch: normalizedLeaseEpoch,
      baseSha: normalizedBaseSha ?? run.baseSha,
      headSha: normalizedHeadSha,
      commitSha: normalizedCommitSha,
      guardReceipt: receipt,
      commands: boundedCommands,
      artifactHashes: boundedArtifacts,
      verifyResult: boundedVerify,
    });
    const [updated] = await tx
      .update(taskRunTable)
      .set({
        state: nextState,
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
          eq(taskRunTable.id, runId),
          eq(taskRunTable.leaseEpoch, normalizedLeaseEpoch),
          eq(taskRunTable.leaseTokenHash, leaseTokenHash),
          eq(taskRunTable.leaseActive, true),
          ...(expectedRevision === undefined
            ? []
            : [eq(taskRunTable.runRevision, expectedRevision)]),
        ),
      )
      .returning();
    if (!updated) {
      await recordExecutionMetric("stale_fence_rejected", {
        runId,
        taskId,
        reason: "checkpoint_compare_and_swap_failed",
      });
      throw new HTTPException(409, { message: "Stale task run lease fence" });
    }

    await tx.insert(taskRunEvidenceTable).values({
      runId,
      agentPrincipalId: principal.id,
      kind: "checkpoint",
      payload: {
        requestId: normalizedKey,
        headSha: normalizedHeadSha,
        commitSha: normalizedCommitSha,
        baseSha: normalizedBaseSha ?? null,
        receiptId: receipt.receiptId,
      },
    });
    await enqueueNotificationEvent(tx, {
      taskId,
      runId,
      kind: "checkpoint",
      payload: {
        taskId,
        runId,
        commitSha: normalizedCommitSha.slice(0, 12),
        phase:
          typeof boundedVerify.phase === "string" ? boundedVerify.phase : null,
      },
    });

    return saveIdempotencyResponse(tx, {
      userId,
      agentPrincipalId: principal.id,
      runId,
      operation: IDEMPOTENCY_OPERATIONS.checkpoint,
      requestKey: normalizedKey,
      requestHash,
      response: serializeRun(updated),
    });
  });
  await publishTaskRunUpdated(taskId, result.id, userId, result.state);
  return result;
}

/**
 * SPEC-kaneo-native-telegram-control-v0-1 (T1): dispatcher supervisor report.
 * The fixed dispatcher terminalizes a run whose worker process died before
 * reporting, using the structured worker terminal receipt recorded in the run
 * root. Idempotent per requestKey; the receipt's own finalState is the only
 * state source (no substring guessing).
 */
export async function supervisorReportTaskRun({
  taskId,
  runId,
  userId,
  agentPrincipalId,
  occurrenceId,
  handoffHash,
  supervisorFence,
  workerTerminalReceipt,
  expectedRunRevision,
  requestKey,
}: {
  taskId: string;
  runId: string;
  userId: string;
  agentPrincipalId: unknown;
  occurrenceId?: unknown;
  handoffHash?: unknown;
  supervisorFence?: unknown;
  workerTerminalReceipt: unknown;
  expectedRunRevision?: unknown;
  requestKey: string;
}): Promise<TaskRunResponse> {
  let normalizedFence: string | undefined;
  if (
    typeof supervisorFence !== "string" ||
    !supervisorFence ||
    supervisorFence.length > 200
  ) {
    throw new HTTPException(401, {
      message: "A bounded supervisor fence is required",
    });
  }
  normalizedFence = supervisorFence;
  const normalizedPrincipalId = validateIdentity(
    agentPrincipalId,
    "agentPrincipalId",
  );
  const receipt = validateJsonObject(
    workerTerminalReceipt,
    "workerTerminalReceipt",
  );
  for (const field of [
    "schemaVersion",
    "taskId",
    "runId",
    "stopReason",
    "finalState",
  ]) {
    if (typeof receipt[field] !== "string" || !receipt[field]) {
      throw new HTTPException(400, {
        message: `workerTerminalReceipt.${field} is required`,
      });
    }
  }
  if (receipt.taskId !== taskId || receipt.runId !== runId) {
    throw new HTTPException(409, {
      message: "workerTerminalReceipt must bind the exact task and run",
    });
  }
  const nextState = validateRunState(receipt.finalState);
  assertReportState(nextState);
  const nextFailureKind = validateFailureKind(receipt.failureKind);
  let nextRetryAt: Date | null = null;
  if (receipt.retryAt !== undefined && receipt.retryAt !== null) {
    if (typeof receipt.retryAt !== "string") {
      throw new HTTPException(400, {
        message: "receipt.retryAt must be an ISO timestamp",
      });
    }
    const parsed = new Date(receipt.retryAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new HTTPException(400, {
        message: "receipt.retryAt must be an ISO timestamp",
      });
    }
    nextRetryAt = parsed;
  }
  if (handoffHash !== undefined) {
    if (typeof handoffHash !== "string" || handoffHash.length > 128) {
      throw new HTTPException(400, {
        message: "handoffHash must be a bounded string",
      });
    }
    if (receipt.handoffHash !== handoffHash) {
      throw new HTTPException(409, {
        message: "handoffHash must match receipt.handoffHash",
      });
    }
  }
  if (
    occurrenceId !== undefined &&
    (typeof occurrenceId !== "string" || !occurrenceId.trim())
  ) {
    throw new HTTPException(400, {
      message: "occurrenceId must be a non-empty string",
    });
  }
  const expectedRevision = validateRevision(
    expectedRunRevision,
    "expectedRunRevision",
  );
  const normalizedKey = requireIdempotencyKey(requestKey);
  const requestHash = stableHash({
    taskId,
    runId,
    agentPrincipalId: normalizedPrincipalId,
    occurrenceId: occurrenceId ?? null,
    handoffHash: handoffHash ?? null,
    receiptHash: stableHash(receipt),
    expectedRunRevision: expectedRevision ?? null,
  });

  const result = await db.transaction(async (tx) => {
    const replay = await getIdempotencyReplay(tx, {
      userId,
      operation: IDEMPOTENCY_OPERATIONS.supervisorReport,
      requestKey: normalizedKey,
      requestHash,
      runId,
    });
    if (replay) return replay;

    const [run] = await tx
      .select()
      .from(taskRunTable)
      .where(and(eq(taskRunTable.id, runId), eq(taskRunTable.taskId, taskId)))
      .limit(1)
      .for("update");
    if (!run) throw new HTTPException(404, { message: "Task run not found" });
    // Supervisor fence: the one-time token handed to the fixed runner through
    // the local 0600 handoff file at dispatch time. Without a matching fence
    // the report is rejected before any state change.
    const [occurrence] = await tx
      .select({
        id: executionScheduleOccurrenceTable.id,
        state: executionScheduleOccurrenceTable.state,
        supervisorFenceHash:
          executionScheduleOccurrenceTable.supervisorFenceHash,
      })
      .from(executionScheduleOccurrenceTable)
      .where(eq(executionScheduleOccurrenceTable.runId, runId))
      .limit(1);
    if (
      !occurrence?.supervisorFenceHash ||
      occurrence.state !== "dispatched" ||
      stableHash(normalizedFence) !== occurrence.supervisorFenceHash
    ) {
      throw new HTTPException(401, {
        message:
          "Supervisor fence is invalid or the occurrence is not dispatched",
      });
    }
    // The dispatcher must own the run's worker principal: it spawned this
    // worker and is the only actor allowed to terminalize it on crash. The
    // wire field is the server-issued principal row ID; runtimeId is a
    // separate stable identity used by the host binding.
    const [principal] = await tx
      .select({
        id: agentPrincipalTable.id,
        userId: agentPrincipalTable.userId,
      })
      .from(agentPrincipalTable)
      .where(eq(agentPrincipalTable.id, normalizedPrincipalId))
      .limit(1);
    if (!principal || principal.id !== run.agentPrincipalId) {
      throw new HTTPException(403, {
        message:
          "Supervisor report must come from the run's own agent principal",
      });
    }
    // The supervisor crash sweep exists to terminalize workers that died
    // before reporting. A run that already reached a terminal state carries
    // an authoritative worker report (in_review) or parent/final decision;
    // overwriting it from the sweep would destroy exactly the evidence the
    // parent review gate needs. The dispatcher also skips these states, so
    // this guard is the machine-enforced backstop (SPEC canonical states).
    if (
      (WORKER_TERMINAL_RUN_STATES as readonly string[]).includes(run.state) ||
      (FULLY_TERMINAL_RUN_STATES as readonly string[]).includes(run.state)
    ) {
      throw new HTTPException(409, {
        message:
          "Run already terminal; supervisor report must not override the worker or parent decision",
      });
    }
    if (
      expectedRevision !== undefined &&
      expectedRevision !== run.runRevision
    ) {
      throw new HTTPException(409, {
        message:
          "Stale expectedRunRevision: run changed before supervisor report",
      });
    }
    const now = new Date();
    const nextEvidence = {
      ...(run.evidence ?? {}),
      supervisorReceipt: receipt,
    };
    const [updated] = await tx
      .update(taskRunTable)
      .set({
        state: nextState,
        failureKind: nextFailureKind ?? run.failureKind,
        retryAt: nextRetryAt ?? run.retryAt,
        evidence: nextEvidence,
        manualRecoveryRequired:
          nextState === "failed" ||
          nextState === "orphaned" ||
          nextState.startsWith("blocked_"),
        leaseActive: false,
        runRevision: sql`${taskRunTable.runRevision} + 1`,
        updatedAt: now,
      })
      .where(eq(taskRunTable.id, runId))
      .returning();
    if (!updated) {
      throw new HTTPException(409, {
        message: "Task run changed before supervisor report",
      });
    }

    await tx.insert(taskRunEvidenceTable).values({
      runId,
      agentPrincipalId: run.agentPrincipalId,
      kind: "supervisor_report",
      payload: { requestId: normalizedKey, finalState: nextState },
    });
    const outboxKind =
      nextState === "in_review"
        ? "in_review"
        : nextState === "blocked_quota"
          ? "blocked_quota"
          : nextState === "blocked_input" ||
              nextState === "blocked_clarification"
            ? "needs_input"
            : "failed";
    await enqueueNotificationEvent(tx, {
      taskId,
      runId,
      kind: outboxKind,
      payload: {
        taskId,
        runId,
        finalState: nextState,
        failureKind: nextFailureKind ?? null,
        retryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
        lastCheckpointSha: run.lastCheckpointSha,
      },
    });

    return saveIdempotencyResponse(tx, {
      userId,
      agentPrincipalId: run.agentPrincipalId,
      runId,
      operation: IDEMPOTENCY_OPERATIONS.supervisorReport,
      requestKey: normalizedKey,
      requestHash,
      response: serializeRun(updated),
    });
  });
  await publishTaskRunUpdated(taskId, result.id, userId, result.state);
  return result;
}

export type ControlRequestActorType = "parent" | "telegram";

/**
 * SPEC-kaneo-native-telegram-control-v0-1 (T1): structured control request.
 * Telegram/parent create requests; only the dispatcher consumes them with a
 * CAS claim. The actor type is derived from the authenticated API key scope
 * by the route, never from the request body.
 */
/**
 * SPEC-kaneo-wavefix-v0-2 (T11): route a human Kaneo comment to the live
 * worker run as a steer_message control request. No-op when there is no
 * active lease — the caller (comment controller) ignores the outcome so a
 * plain comment never fails because steering is unavailable.
 */
export async function maybeSteerActiveRunFromComment(input: {
  taskId: string;
  userId: string;
  content: string;
}): Promise<{ steered: boolean; reason?: string }> {
  const message = input.content.trim().slice(0, 2_000);
  if (!message) return { steered: false, reason: "empty_comment" };
  // System markers (T9 [⭕ DOING] / T9b [✅ DONE] / bot replies) never steer
  // and never trigger the bot fallback reply, which would otherwise loop.
  if (message.startsWith("[")) {
    return { steered: false, reason: "system_marker" };
  }
  const [activeRun] = await db
    .select({
      id: taskRunTable.id,
      leaseEpoch: taskRunTable.leaseEpoch,
      agentPrincipalId: taskRunTable.agentPrincipalId,
    })
    .from(taskRunTable)
    .where(
      and(
        eq(taskRunTable.taskId, input.taskId),
        eq(taskRunTable.state, "in_progress"),
        eq(taskRunTable.leaseActive, true),
      ),
    )
    .limit(1);
  if (!activeRun) {
    // SPEC-kaneo-wavefix-v0-2 (#19b): no live run to receive the comment —
    // the bot answers in the worker's place so the human is not left talking
    // to nobody. Direct insert: going through create-comment would re-enter
    // this hook (the guard above also breaks that loop).
    const [latestRun] = await db
      .select({ state: taskRunTable.state, leaseEpoch: taskRunTable.leaseEpoch })
      .from(taskRunTable)
      .where(eq(taskRunTable.taskId, input.taskId))
      .orderBy(desc(taskRunTable.createdAt))
      .limit(1);
    if (latestRun) {
      await db.insert(activityTable).values({
        taskId: input.taskId,
        type: "comment",
        userId: input.userId,
        content: `[🤖] No active worker run on this task (last run state: ${latestRun.state}). Your comment was not delivered to any worker. Schedule the task again to start a new run.`,
      });
    }
    return { steered: false, reason: "no_active_run" };
  }
  try {
    await createControlRequest({
      taskId: input.taskId,
      runId: activeRun.id,
      action: "steer_message",
      actorType: "parent",
      actorUserId: input.userId,
      payload: { message },
      expectedTaskRevision: undefined,
      expectedRunRevision: undefined,
      expiresInSeconds: 3_600,
      requestKey: `comment-steer-${activeRun.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return { steered: true };
  } catch (error) {
    return {
      steered: false,
      reason: error instanceof Error ? error.message : "steer_request_failed",
    };
  }
}

export async function createControlRequest({
  taskId,
  runId,
  action,
  actorType,
  authenticatedPrincipalId,
  actorUserId,
  route,
  host,
  eventId,
  deliveryId,
  payload,
  expectedTaskRevision,
  expectedRunRevision,
  expiresInSeconds,
  requestKey,
}: {
  taskId: unknown;
  runId?: unknown;
  action: unknown;
  actorType: ControlRequestActorType;
  authenticatedPrincipalId?: string | null;
  actorUserId?: string | null;
  route?: string | null;
  host?: string | null;
  eventId?: unknown;
  deliveryId?: unknown;
  payload?: unknown;
  expectedTaskRevision?: unknown;
  expectedRunRevision?: unknown;
  expiresInSeconds?: unknown;
  requestKey: string;
}) {
  const normalizedTaskId = validateIdentity(taskId, "taskId");
  const normalizedRunId =
    runId === undefined || runId === null
      ? null
      : validateIdentity(runId, "runId");
  const normalizedAction = validateControlAction(action);
  const boundedPayload =
    payload === undefined
      ? {}
      : validateJsonObject(payload, "payload", 8 * 1024);
  if (
    normalizedAction === "continue_quota" &&
    Object.keys(boundedPayload).some((key) =>
      ["model", "scope", "contract", "preferredModel"].includes(key),
    )
  ) {
    throw new HTTPException(400, {
      message:
        "continue_quota payload must not contain model/scope/contract overrides",
    });
  }
  // SPEC-kaneo-wavefix-v0-2 (T10): steering payloads are bounded untrusted
  // text; scope/model/contract overrides must go through contract amendment
  // (parent flow), never through a Telegram reply.
  if (normalizedAction === "steer_message") {
    const message = boundedPayload.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new HTTPException(400, {
        message: "steer_message payload requires a non-empty message string",
      });
    }
    if (
      Object.keys(boundedPayload).some((key) =>
        [
          "model",
          "scope",
          "contract",
          "preferredModel",
          "files",
          "writes",
        ].includes(key),
      )
    ) {
      throw new HTTPException(400, {
        message:
          "steer_message payload must not contain scope/contract overrides",
      });
    }
  }
  const expectedTask = validateRevision(
    expectedTaskRevision,
    "expectedTaskRevision",
  );
  const expectedRun = validateRevision(
    expectedRunRevision,
    "expectedRunRevision",
  );
  const ttl =
    expiresInSeconds === undefined
      ? 3_600
      : typeof expiresInSeconds === "number" &&
          Number.isInteger(expiresInSeconds) &&
          expiresInSeconds >= 30 &&
          expiresInSeconds <= 86_400
        ? expiresInSeconds
        : -1;
  if (ttl === -1) {
    throw new HTTPException(400, {
      message: "expiresInSeconds must be an integer between 30 and 86400",
    });
  }
  const requestKeyTrimmed = requestKey.trim();
  if (!requestKeyTrimmed || requestKeyTrimmed.length > 200) {
    throw new HTTPException(400, {
      message:
        "Idempotency-Key (requestId) is required and must be <= 200 characters",
    });
  }
  const requestHash = stableHash({
    taskId: normalizedTaskId,
    runId: normalizedRunId,
    action: normalizedAction,
    actorType,
    eventId: eventId ?? null,
    deliveryId: deliveryId ?? null,
    payload: boundedPayload,
    expectedTaskRevision: expectedTask ?? null,
    expectedRunRevision: expectedRun ?? null,
  });

  return db.transaction(async (tx) => {
    const replay = await getIdempotencyReplay(tx, {
      userId: actorUserId ?? "",
      operation: IDEMPOTENCY_OPERATIONS.controlRequest,
      requestKey: requestKeyTrimmed,
      requestHash,
      runId: normalizedRunId,
    });
    if (replay) {
      return {
        outcome: "replayed" as const,
        request: replay as unknown as Record<string, unknown>,
      };
    }

    const [task] = await tx
      .select({ id: taskTable.id, projectId: taskTable.projectId })
      .from(taskTable)
      .where(eq(taskTable.id, normalizedTaskId))
      .limit(1);
    if (!task) throw new HTTPException(404, { message: "Task not found" });
    if (normalizedRunId) {
      const [run] = await tx
        .select({ id: taskRunTable.id })
        .from(taskRunTable)
        .where(
          and(
            eq(taskRunTable.id, normalizedRunId),
            eq(taskRunTable.taskId, normalizedTaskId),
          ),
        )
        .limit(1);
      if (!run) {
        throw new HTTPException(404, {
          message: "Task run not found for task",
        });
      }
    }

    const [created] = await tx
      .insert(executionControlRequestTable)
      .values({
        requestId: requestKeyTrimmed,
        actorType,
        authenticatedPrincipalId: authenticatedPrincipalId ?? null,
        actorUserId: actorUserId ?? null,
        route: route ?? null,
        host: host ?? null,
        action: normalizedAction,
        taskId: normalizedTaskId,
        runId: normalizedRunId,
        eventId: typeof eventId === "string" ? eventId : null,
        deliveryId: typeof deliveryId === "string" ? deliveryId : null,
        payload: boundedPayload,
        expectedTaskRevision: expectedTask ?? null,
        expectedRunRevision: expectedRun ?? null,
        state: "pending",
        expiresAt: new Date(Date.now() + ttl * 1_000),
      })
      .onConflictDoNothing({
        target: executionControlRequestTable.requestId,
      })
      .returning();
    if (!created) {
      const [existing] = await tx
        .select()
        .from(executionControlRequestTable)
        .where(eq(executionControlRequestTable.requestId, requestKeyTrimmed))
        .limit(1);
      if (
        existing &&
        stableHash({
          taskId: existing.taskId,
          runId: existing.runId,
          action: existing.action,
          actorType: existing.actorType,
          eventId: existing.eventId,
          deliveryId: existing.deliveryId,
          payload: existing.payload,
          expectedTaskRevision: existing.expectedTaskRevision,
          expectedRunRevision: existing.expectedRunRevision,
        }) === requestHash
      ) {
        return {
          outcome: "replayed" as const,
          request: serializeControlRequest(existing),
        };
      }
      throw new HTTPException(409, {
        message:
          "requestId already exists with a different payload (idempotency conflict)",
      });
    }
    return {
      outcome: "created" as const,
      request: serializeControlRequest(created),
    };
  });
}

function serializeControlRequest(
  request: typeof executionControlRequestTable.$inferSelect,
) {
  return {
    id: request.id,
    requestId: request.requestId,
    actorType: request.actorType,
    authenticatedPrincipalId: request.authenticatedPrincipalId,
    actorUserId: request.actorUserId,
    route: request.route,
    host: request.host,
    action: request.action,
    taskId: request.taskId,
    runId: request.runId,
    eventId: request.eventId,
    deliveryId: request.deliveryId,
    payload: request.payload,
    expectedTaskRevision: request.expectedTaskRevision,
    expectedRunRevision: request.expectedRunRevision,
    state: request.state,
    claimedBy: request.claimedBy,
    claimExpiresAt: request.claimExpiresAt,
    appliedAt: request.appliedAt,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

/**
 * Dispatcher view of pending control requests for its host, oldest first.
 * Expired-but-still-pending rows are marked expired on read (best effort).
 */
export async function listDueControlRequests({
  host,
  limit = 50,
}: {
  host: string;
  limit?: number;
}) {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const now = new Date();
  await db
    .update(executionControlRequestTable)
    .set({ state: "expired" })
    .where(
      and(
        eq(executionControlRequestTable.state, "pending"),
        lte(executionControlRequestTable.expiresAt, now),
      ),
    );
  const rows = await db
    .select()
    .from(executionControlRequestTable)
    .where(
      and(
        eq(executionControlRequestTable.state, "pending"),
        eq(executionControlRequestTable.host, host),
      ),
    )
    .orderBy(asc(executionControlRequestTable.createdAt))
    .limit(boundedLimit);
  return rows.map(serializeControlRequest);
}

/** CAS claim a pending control request for a named consumer. */
export async function claimControlRequest({
  id,
  consumerId,
  claimTtlSeconds,
}: {
  id: unknown;
  consumerId: unknown;
  claimTtlSeconds?: unknown;
}) {
  const normalizedId = validateIdentity(id, "id");
  if (
    typeof consumerId !== "string" ||
    !consumerId.trim() ||
    consumerId.length > 120
  ) {
    throw new HTTPException(400, {
      message: "consumerId must be a bounded string",
    });
  }
  const ttl =
    claimTtlSeconds === undefined
      ? 300
      : typeof claimTtlSeconds === "number" &&
          Number.isInteger(claimTtlSeconds) &&
          claimTtlSeconds >= 30 &&
          claimTtlSeconds <= 3_600
        ? claimTtlSeconds
        : -1;
  if (ttl === -1) {
    throw new HTTPException(400, {
      message: "claimTtlSeconds must be an integer between 30 and 3600",
    });
  }
  const now = new Date();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(executionControlRequestTable)
      .where(eq(executionControlRequestTable.id, normalizedId))
      .limit(1)
      .for("update");
    if (!existing) {
      throw new HTTPException(404, { message: "Control request not found" });
    }
    if (existing.state === "claimed") {
      if (
        existing.claimedBy === consumerId.trim() &&
        existing.claimExpiresAt &&
        existing.claimExpiresAt.getTime() > now.getTime()
      ) {
        return {
          outcome: "already_claimed" as const,
          request: serializeControlRequest(existing),
        };
      }
      throw new HTTPException(409, {
        message: "Control request already claimed",
      });
    }
    if (existing.state !== "pending") {
      return {
        outcome: existing.state as "applied" | "rejected" | "expired",
        request: serializeControlRequest(existing),
      };
    }
    const [claimed] = await tx
      .update(executionControlRequestTable)
      .set({
        state: "claimed",
        claimedBy: consumerId.trim(),
        claimedAt: now,
        claimExpiresAt: new Date(now.getTime() + ttl * 1_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(executionControlRequestTable.id, normalizedId),
          eq(executionControlRequestTable.state, "pending"),
        ),
      )
      .returning();
    if (!claimed) {
      throw new HTTPException(409, {
        message: "Control request changed before claim",
      });
    }
    return {
      outcome: "claimed" as const,
      request: serializeControlRequest(claimed),
    };
  });
}

/**
 * CAS apply a claimed control request. Policy enforcement for the wrapped
 * action lives in the endpoints the dispatcher calls next (resume, fallback,
 * ready_task); apply only records the outcome with a CAS on claim ownership.
 */
export async function applyControlRequest({
  id,
  consumerId,
  outcome,
  result,
}: {
  id: unknown;
  consumerId: unknown;
  outcome: unknown;
  result?: unknown;
}) {
  const normalizedId = validateIdentity(id, "id");
  if (typeof consumerId !== "string" || !consumerId.trim()) {
    throw new HTTPException(400, {
      message: "consumerId must be a non-empty string",
    });
  }
  if (outcome !== "applied" && outcome !== "rejected") {
    throw new HTTPException(400, {
      message: 'outcome must be "applied" or "rejected"',
    });
  }
  const boundedResult =
    result === undefined ? {} : validateJsonObject(result, "result", 8 * 1024);
  const now = new Date();
  const [updated] = await db
    .update(executionControlRequestTable)
    .set({
      state: outcome,
      resultHash: stableHash(boundedResult),
      appliedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(executionControlRequestTable.id, normalizedId),
        eq(executionControlRequestTable.state, "claimed"),
        eq(executionControlRequestTable.claimedBy, consumerId.trim()),
      ),
    )
    .returning();
  if (!updated) {
    throw new HTTPException(409, {
      message: "Control request is not claimed by this consumer (CAS failed)",
    });
  }
  return { outcome, request: serializeControlRequest(updated) };
}

export async function reclaimStaleTaskRuns(input?: {
  now?: Date;
  staleAfterSeconds?: number;
}) {
  const now = input?.now ?? new Date();
  const staleAfterSeconds = input?.staleAfterSeconds ?? 1_800;
  if (
    !Number.isInteger(staleAfterSeconds) ||
    staleAfterSeconds < 60 ||
    staleAfterSeconds > 86_400
  ) {
    throw new HTTPException(400, {
      message: "staleAfterSeconds must be an integer between 60 and 86400",
    });
  }
  const cutoff = new Date(now.getTime() - staleAfterSeconds * 1_000);
  const reclaimed = await db.transaction(async (tx) => {
    // SPEC-kaneo-wavefix-v0-2 (T7): liveness is the last PROGRESS signal
    // (claim/heartbeat/report/checkpoint), falling back to the heartbeat for
    // rows created before last_progress_at existed.
    const lastLive = sql`COALESCE(${taskRunTable.lastProgressAt}, ${taskRunTable.lastHeartbeatAt})`;
    // SPEC-kaneo-wavefix-v0-2 (#10): two stale-run classes. Class 1 — lease
    // gone quiet (below). Class 2 — the run still heartbeats (zombie worker
    // loop) but never made a commit/checkpoint within 2x the stale window,
    // so the lease watchdog above can never catch it. The client-side
    // no-progress sweep only scans its own workspace dir, which skips runs
    // spawned by other lanes (TelePi, env workspace); this server pass
    // covers every lane.
    const zombieCutoff = new Date(now.getTime() - staleAfterSeconds * 2_000);
    const zombieCandidates = await tx
      .select({
        id: taskRunTable.id,
        taskId: taskRunTable.taskId,
        agentPrincipalId: taskRunTable.agentPrincipalId,
        leaseEpoch: taskRunTable.leaseEpoch,
        createdAt: taskRunTable.createdAt,
      })
      .from(taskRunTable)
      .where(
        and(
          eq(taskRunTable.state, "in_progress"),
          eq(taskRunTable.leaseActive, true),
          lte(taskRunTable.createdAt, zombieCutoff),
          isNull(taskRunTable.commitSha),
          isNull(taskRunTable.lastCheckpointSha),
        ),
      )
      .limit(100)
      .for("update");
    const candidates = await tx
      .select({
        id: taskRunTable.id,
        taskId: taskRunTable.taskId,
        agentPrincipalId: taskRunTable.agentPrincipalId,
        leaseEpoch: taskRunTable.leaseEpoch,
        lastHeartbeatAt: taskRunTable.lastHeartbeatAt,
      })
      .from(taskRunTable)
      .where(
        and(
          eq(taskRunTable.state, "in_progress"),
          eq(taskRunTable.leaseActive, true),
          lte(lastLive, cutoff),
          lte(taskRunTable.leaseExpiresAt, now),
        ),
      )
      .limit(100)
      .for("update");
    const results: Array<{
      id: string;
      taskId: string;
      leaseEpoch: number;
      lastHeartbeatAt: Date;
    }> = [];
    for (const candidate of candidates) {
      const [updated] = await tx
        .update(taskRunTable)
        .set({
          state: "orphaned",
          leaseActive: false,
          leaseExpiresAt: now,
          blocker: "watchdog_stale_lease",
          nextAction:
            "Parent must inspect checkpoint/branch before resuming this run",
          updatedAt: now,
        })
        .where(
          and(
            eq(taskRunTable.id, candidate.id),
            eq(taskRunTable.leaseEpoch, candidate.leaseEpoch),
            eq(taskRunTable.leaseActive, true),
            eq(taskRunTable.state, "in_progress"),
          ),
        )
        .returning({
          id: taskRunTable.id,
          taskId: taskRunTable.taskId,
          leaseEpoch: taskRunTable.leaseEpoch,
          lastHeartbeatAt: taskRunTable.lastHeartbeatAt,
        });
      if (!updated) continue;
      await tx.insert(taskRunEvidenceTable).values({
        runId: updated.id,
        agentPrincipalId: candidate.agentPrincipalId,
        kind: "watchdog_stale_lease",
        payload: {
          staleAfterSeconds,
          lastHeartbeatAt: candidate.lastHeartbeatAt.toISOString(),
          reclaimedAt: now.toISOString(),
          leaseEpoch: candidate.leaseEpoch,
          blocker: "watchdog_stale_lease",
        },
      });
      results.push(updated);
    }
    // Class 2: zombie heartbeat, zero progress. Terminalize identically but
    // with its own blocker/evidence so parent review can tell them apart.
    for (const candidate of zombieCandidates) {
      const [updated] = await tx
        .update(taskRunTable)
        .set({
          state: "orphaned",
          leaseActive: false,
          leaseExpiresAt: now,
          blocker: "watchdog_no_progress",
          nextAction:
            "Run made no commit/checkpoint within the no-progress window; parent must inspect before resuming",
          updatedAt: now,
        })
        .where(
          and(
            eq(taskRunTable.id, candidate.id),
            eq(taskRunTable.leaseEpoch, candidate.leaseEpoch),
            eq(taskRunTable.leaseActive, true),
            eq(taskRunTable.state, "in_progress"),
          ),
        )
        .returning({
          id: taskRunTable.id,
          taskId: taskRunTable.taskId,
          leaseEpoch: taskRunTable.leaseEpoch,
          lastHeartbeatAt: taskRunTable.lastHeartbeatAt,
        });
      if (!updated) continue;
      await tx.insert(taskRunEvidenceTable).values({
        runId: updated.id,
        agentPrincipalId: candidate.agentPrincipalId,
        kind: "watchdog_no_progress",
        payload: {
          staleAfterSeconds: staleAfterSeconds * 2,
          createdAt: candidate.createdAt.toISOString(),
          reclaimedAt: now.toISOString(),
          leaseEpoch: candidate.leaseEpoch,
          blocker: "watchdog_no_progress",
        },
      });
      results.push(updated);
    }
    return results;
  });
  for (const run of reclaimed) {
    await publishTaskRunUpdated(run.taskId, run.id, "watchdog", "orphaned");
    await publishEvent("execution.watchdog.reclaimed", {
      taskId: run.taskId,
      runId: run.id,
      leaseEpoch: run.leaseEpoch,
    });
    // SPEC-kaneo-wavefix-v0-2 (T7): a silent orphan is the exact failure
    // class that wedged the TrelloX E2E for ten hours — surface it.
    await enqueueNotificationEvent(db, {
      taskId: run.taskId,
      runId: run.id,
      kind: "failed",
      payload: {
        outcome: "watchdog_reclaimed",
        reason: "run stalled: no progress heartbeat within the stale window",
        leaseEpoch: run.leaseEpoch,
      },
    });
  }
  return reclaimed;
}

export async function reviewTaskRun({
  taskId,
  runId,
  userId,
  decision,
  action,
  reason,
  verification,
  prResult,
  expectedTaskRevision,
  expectedRunRevision,
  reviewHeadSha,
  requestKey,
}: {
  taskId: string;
  runId: string;
  userId: string;
} & ParentReviewInput): Promise<TaskRunResponse> {
  const normalizedDecision = validateParentReviewDecision(decision);
  const normalizedAction = validateParentReviewAction(action);
  const normalizedReason =
    reason === undefined
      ? undefined
      : typeof reason === "string"
        ? reason.trim()
        : "";
  if (normalizedDecision === "reject" && !normalizedReason) {
    throw new HTTPException(400, {
      message: "A rejection reason is required",
    });
  }
  const normalizedKey = requireIdempotencyKey(requestKey);
  const expectedTaskRevisionValue = validateRevision(
    expectedTaskRevision,
    "expectedTaskRevision",
  );
  const expectedRunRevisionValue = validateRevision(
    expectedRunRevision,
    "expectedRunRevision",
  );
  const normalizedReviewHeadSha = validateGitSha(
    reviewHeadSha,
    "reviewHeadSha",
  );
  if (normalizedDecision === "reject" && !normalizedReviewHeadSha) {
    throw new HTTPException(400, {
      message: "reviewHeadSha is required when rejecting a run",
    });
  }
  if (
    normalizedDecision === "approve" &&
    normalizedAction === "merge" &&
    !normalizedReviewHeadSha
  ) {
    throw new HTTPException(400, {
      message: "reviewHeadSha is required when finalizing a merge",
    });
  }
  const normalizedVerification =
    normalizedDecision === "approve"
      ? validateParentReviewVerification(verification)
      : verification === undefined
        ? undefined
        : validateJsonObject(verification, "verification");
  const normalizedPrResult =
    normalizedDecision === "approve"
      ? validateParentReviewPrResult(prResult, normalizedAction)
      : undefined;
  const requestHash = stableHash({
    taskId,
    runId,
    decision: normalizedDecision,
    action: normalizedAction,
    reason: normalizedReason ?? null,
    verification: normalizedVerification ?? null,
    prResult: normalizedPrResult ?? null,
    expectedTaskRevision: expectedTaskRevisionValue ?? null,
    expectedRunRevision: expectedRunRevisionValue ?? null,
    reviewHeadSha: normalizedReviewHeadSha ?? null,
  });

  const result = await db.transaction(async (tx) => {
    const executionFlag = getParentReviewExecutionFlag(
      normalizedDecision,
      normalizedAction,
    );
    if (executionFlag) {
      await assertExecutionFlagEnabled(
        executionFlag,
        { taskId, runId, reason: "parent_review" },
        tx,
      );
    }

    const replay = await getIdempotencyReplay(tx, {
      userId,
      operation: IDEMPOTENCY_OPERATIONS.review,
      requestKey: normalizedKey,
      requestHash,
      runId,
    });
    if (replay) return { response: replay, taskStatusChanged: null };

    // Keep task -> run lock ordering identical to status/move/claim paths.
    // Without the task lock, a direct status writer could race this review
    // transaction between the run decision and task finalization.
    const { task, manifest, integration } = await getTaskContext(
      taskId,
      tx,
      true,
    );
    const [run] = await tx
      .select()
      .from(taskRunTable)
      .where(and(eq(taskRunTable.id, runId), eq(taskRunTable.taskId, taskId)))
      .limit(1)
      .for("update");
    if (!run) throw new HTTPException(404, { message: "Task run not found" });
    if (!run.agentPrincipalId) {
      throw new HTTPException(409, {
        message: "Task run has no worker principal to review",
      });
    }
    const [workerPrincipal] = await tx
      .select({
        id: agentPrincipalTable.id,
        userId: agentPrincipalTable.userId,
        runtimeId: agentPrincipalTable.runtimeId,
        isActive: agentPrincipalTable.isActive,
      })
      .from(agentPrincipalTable)
      .where(eq(agentPrincipalTable.id, run.agentPrincipalId))
      .limit(1);
    if (!workerPrincipal) {
      throw new HTTPException(409, {
        message: "Task run worker principal is no longer available",
      });
    }
    if (!workerPrincipal.isActive) {
      throw new HTTPException(409, {
        message: "Task run worker principal is inactive",
      });
    }

    // Review authority comes from the authenticated session/API-key user. The
    // optional X-Kaneo-Agent-Principal header is caller-controlled metadata and
    // is deliberately ignored: a worker must not select another principal it
    // owns to masquerade as a parent. A distinct authenticated principal owner
    // is the fail-closed boundary for native parent/worker separation.
    if (workerPrincipal.userId === userId) {
      throw new HTTPException(403, {
        message:
          "The authenticated parent identity must be distinct from the worker principal",
      });
    }

    if (run.state === "finalized" || run.state === "rejected") {
      throw new HTTPException(409, {
        message: "Terminal task runs cannot be reviewed again",
      });
    }
    if (
      normalizedReviewHeadSha &&
      (!run.commitSha ||
        normalizedReviewHeadSha.toLowerCase() !== run.commitSha.toLowerCase())
    ) {
      throw new HTTPException(409, {
        message: "reviewHeadSha must equal the reviewed run commitSha",
      });
    }

    const latestRun = await getLatestTaskRunForGate(tx, taskId, true);
    if (!latestRun || latestRun.id !== run.id) {
      throw new HTTPException(409, {
        message: "Only the latest task run can be reviewed",
      });
    }

    let nextState: TaskRunState;
    let blocker: string | null = null;
    let nextAction: string | null = null;
    let finalizationReceipt: Record<string, unknown> | null = null;
    let prFields: {
      prNumber?: number;
      prUrl?: string;
      prState?: string;
    } = {};
    if (normalizedDecision === "reject") {
      nextState = "rejected";
    } else {
      if (
        !normalizedVerification ||
        !("verificationProfile" in normalizedVerification)
      ) {
        throw new HTTPException(400, {
          message: "Approval verification is required",
        });
      }
      const approvalVerification =
        normalizedVerification as ParentReviewVerification;
      assertParentReviewableRun(
        run,
        workerPrincipal.runtimeId,
        manifest,
        approvalVerification,
      );
      if (normalizedAction === "none") {
        // Spec: action=none must never finalize a run. It would be a kill-
        // switch bypass around the merge gate.
        throw new HTTPException(409, {
          message:
            "Approval requires action create_pr or merge; action none cannot finalize a run",
        });
      }
      const policyKey =
        normalizedAction === "create_pr" ? "allowPrCreate" : "allowMerge";
      const policyAllowsAction = manifest.policy[policyKey] === true;
      if (!policyAllowsAction) {
        // Gate blocked: keep the run in_review so the parent can retry after
        // fixing manifest policy/credentials; never swallow it into a
        // terminal state here.
        nextState = "in_review";
        blocker = "credential_blocked";
        nextAction = `Manifest policy ${policyKey} must be true and a reviewed host credential adapter is required`;
        await recordExecutionMetric(
          normalizedAction === "create_pr"
            ? "pr_gate_blocked"
            : "merge_gate_blocked",
          { taskId, runId, reason: "manifest_policy" },
        );
      } else if (normalizedPrResult?.status !== "PASS") {
        await recordExecutionMetric(
          normalizedAction === "create_pr"
            ? "pr_gate_blocked"
            : "merge_gate_blocked",
          {
            taskId,
            runId,
            reason: normalizedPrResult?.blocker ?? "adapter_blocked",
          },
        );
        nextState = "in_review";
        blocker = normalizedPrResult?.blocker ?? "credential_blocked";
        nextAction =
          normalizedPrResult?.reason ??
          `A passing host credential adapter result is required for ${normalizedAction}`;
      } else {
        try {
          assertPrResultMatchesIntegration(normalizedPrResult, integration);
        } catch (error) {
          await recordExecutionMetric(
            normalizedAction === "create_pr"
              ? "pr_gate_blocked"
              : "merge_gate_blocked",
            { taskId, runId, reason: "repository_mismatch" },
          );
          throw error;
        }
        if (
          normalizedAction === "merge" &&
          // SPEC-kaneo-wavefix-v0-2 (T13): a merge may carry a PR created in
          // the same parent-review operation (run.prNumber was null and the
          // guard auto-created it). Only reject when the run ALREADY had a PR
          // and the evidence points at a different one.
          (run.prNumber
            ? normalizedPrResult.prNumber !== run.prNumber ||
              (run.prUrl && normalizedPrResult.prUrl !== run.prUrl)
            : !normalizedPrResult.prNumber ||
              !normalizedPrResult.prUrl ||
              normalizedPrResult.status !== "PASS")
        ) {
          await recordExecutionMetric("merge_gate_blocked", {
            taskId,
            runId,
            reason: "pull_request_mismatch",
          });
          throw new HTTPException(409, {
            message:
              "Merge evidence must match the pull request recorded on the run",
          });
        }
        prFields = {
          prNumber: normalizedPrResult.prNumber,
          prUrl: normalizedPrResult.prUrl,
          prState: normalizedPrResult.prState,
        };
        if (normalizedAction === "create_pr") {
          // Creating a PR records the review and leaves the final merge gate open.
          nextState = "in_review";
          nextAction = "Human merge gate is required before task finalization";
        } else {
          nextState = "finalized";
          finalizationReceipt = {
            receiptId: `review-${normalizedKey}`,
            prNumber: normalizedPrResult.prNumber ?? null,
            prUrl: normalizedPrResult.prUrl ?? null,
            mergeCommitSha: normalizedPrResult.mergeCommitSha ?? null,
            verifiedAt: new Date().toISOString(),
            receiptHash: stableHash({
              prNumber: normalizedPrResult.prNumber ?? null,
              prUrl: normalizedPrResult.prUrl ?? null,
              mergeCommitSha: normalizedPrResult.mergeCommitSha ?? null,
              reviewHeadSha: normalizedReviewHeadSha ?? null,
            }),
          };
        }
      }
    }

    let taskStatusChanged: {
      taskId: string;
      projectId: string;
      title: string;
      oldStatus: string;
    } | null = null;
    if (nextState === "finalized") {
      const [doneColumn] = await tx
        .select({ id: columnTable.id })
        .from(columnTable)
        .where(
          and(
            eq(columnTable.projectId, task.projectId),
            eq(columnTable.slug, "done"),
          ),
        )
        .limit(1);
      if (!doneColumn) {
        throw new HTTPException(409, {
          message: "Project has no done column for parent finalization",
        });
      }
      // CAS the task revision, then switch execution authority state + the
      // Kanban presentation mapping in the same transaction.
      await bumpTaskRevision(tx, {
        taskId,
        expected: expectedTaskRevisionValue ?? undefined,
      });
      await tx
        .update(taskTable)
        .set({
          status: "done",
          columnId: doneColumn.id,
          executionState: "done",
          updatedAt: new Date(),
        })
        .where(eq(taskTable.id, taskId));
      taskStatusChanged = {
        taskId,
        projectId: task.projectId,
        title: task.title,
        oldStatus: task.status,
      };
    } else if (nextState === "rejected") {
      // Reject atomically requeues the task as ready for a branch-per-run
      // retry; the Kanban mapping follows the execution authority state.
      const [todoColumn] = await tx
        .select({ id: columnTable.id })
        .from(columnTable)
        .where(
          and(
            eq(columnTable.projectId, task.projectId),
            eq(columnTable.slug, "to-do"),
          ),
        )
        .limit(1);
      if (!todoColumn) {
        throw new HTTPException(409, {
          message: "Project has no to-do column for rejection requeue",
        });
      }
      await bumpTaskRevision(tx, {
        taskId,
        expected: expectedTaskRevisionValue ?? undefined,
      });
      await tx
        .update(taskTable)
        .set({
          status: "to-do",
          columnId: todoColumn.id,
          executionState: "ready",
          updatedAt: new Date(),
        })
        .where(eq(taskTable.id, taskId));
    }

    const parentReview = {
      decision: normalizedDecision,
      action: normalizedAction,
      reviewerUserId: userId,
      workerPrincipalId: workerPrincipal.id,
      reason: normalizedReason ?? null,
      verification: normalizedVerification ?? null,
      prResult: normalizedPrResult ?? null,
      blocker,
      nextAction,
    };
    const nextEvidence = {
      ...(run.evidence ?? {}),
      parentReview,
    };
    if (
      expectedRunRevisionValue !== undefined &&
      expectedRunRevisionValue !== run.runRevision
    ) {
      throw new HTTPException(409, {
        message: "Stale expectedRunRevision: run changed before review",
      });
    }
    const [updated] = await tx
      .update(taskRunTable)
      .set({
        state: nextState,
        leaseActive: false,
        blocker,
        nextAction,
        evidence: nextEvidence,
        ...(finalizationReceipt ? { finalizationReceipt } : {}),
        runRevision: sql`${taskRunTable.runRevision} + 1`,
        ...prFields,
        updatedAt: new Date(),
      })
      .where(eq(taskRunTable.id, runId))
      .returning();
    if (!updated) {
      throw new HTTPException(409, {
        message: "Task run changed before review",
      });
    }

    await tx.insert(taskRunEvidenceTable).values({
      runId,
      agentPrincipalId: run.agentPrincipalId,
      kind: "parent_review",
      payload: parentReview,
    });

    // Transactional outbox: terminal review outcomes always notify Telegram.
    if (nextState === "finalized") {
      await enqueueNotificationEvent(tx, {
        taskId,
        runId,
        kind: "done",
        payload: {
          taskId,
          runId,
          branch: run.branchName,
          commitSha: run.commitSha,
          prNumber: updated.prNumber ?? null,
          outcome: "finalized",
        },
      });
    } else if (nextState === "rejected") {
      await enqueueNotificationEvent(tx, {
        taskId,
        runId,
        kind: "failed",
        payload: {
          taskId,
          runId,
          outcome: "parent_rejected",
          reason: (normalizedReason ?? "").slice(0, 300),
        },
      });
    }

    const response = await saveIdempotencyResponse(tx, {
      userId,
      agentPrincipalId: run.agentPrincipalId,
      runId,
      operation: IDEMPOTENCY_OPERATIONS.review,
      requestKey: normalizedKey,
      requestHash,
      response: serializeRun(updated),
    });
    return { response, taskStatusChanged };
  });

  await publishTaskRunUpdated(taskId, runId, userId, result.response.state);
  // SPEC-kaneo-wavefix-v0-2 (T14): the API is the single chain authority.
  // Post-commit, best-effort: a failed advance is a durable failed
  // notification, never a finalized-run rollback.
  if (result.response.state === "finalized") {
    const { advanceChainAfterFinalize } = await import("./schedules");
    void advanceChainAfterFinalize({
      // taskStatusChanged is always set on the finalized path (it carries the
      // project id for the done transition).
      // biome-ignore lint/style/noNonNullAssertion: always set on the finalized path
      projectId: result.taskStatusChanged!.projectId,
      finalizedTaskId: taskId,
      finalizedRequestKey: normalizedKey,
    }).catch(() => {});
  }
  if (result.taskStatusChanged) {
    await publishEvent("task.status_changed", {
      taskId: result.taskStatusChanged.taskId,
      projectId: result.taskStatusChanged.projectId,
      userId,
      oldStatus: result.taskStatusChanged.oldStatus,
      newStatus: "done",
      title: result.taskStatusChanged.title,
      type: "status_changed",
    });
  }
  return result.response;
}

export function toTaskRunResponse(
  run: typeof taskRunTable.$inferSelect,
  leaseToken?: string | null,
) {
  return serializeRun(run, leaseToken);
}
