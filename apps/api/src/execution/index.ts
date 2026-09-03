import type { Context, Next } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import {
  agentPrincipalSchema,
  executionManifestSchema,
  taskRunEvidenceSchema,
  taskRunSchema,
} from "../schemas";
import { isInstanceAdmin } from "../utils/is-instance-admin";
import {
  hasWorkspacePermission,
  requireWorkspacePermission,
} from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import { listExecutionFlags, setExecutionFlag } from "./gates";
import {
  DEFAULT_NOTIFICATION_ROUTE,
  listDueNotificationEvents,
  updateNotificationDelivery,
} from "./outbox";
import {
  acknowledgeScheduleDispatch,
  cancelExecutionSchedule,
  createExecutionSchedule,
  dispatchScheduleOnce,
  getScheduleById,
  getTaskProjectId,
  listDueSchedules,
  updateExecutionSchedule,
} from "./schedules";
import {
  advancePreapprovedFallback,
  applyControlRequest,
  claimControlRequest,
  claimTaskRun,
  createAgentPrincipal,
  createControlRequest,
  createTaskRunCheckpoint,
  getExecutionManifest,
  getTaskRun,
  heartbeatTaskRun,
  listAgentPrincipals,
  listDueControlRequests,
  listPreapprovedFallbackCandidates,
  listTaskRunEvidence,
  listTaskRuns,
  reclaimStaleTaskRuns,
  releaseTaskRun,
  reportTaskRun,
  resumeTaskRun,
  reviewTaskRun,
  supervisorReportTaskRun,
  toTaskRunResponse,
  upsertExecutionManifest,
} from "./service";

type ExecutionApiKeyContext = {
  id?: string;
  userId?: string;
  permissions?: Record<string, string[]> | null;
};

function hasExecutionScope(c: Context, scopes: readonly string[]): boolean {
  const apiKey = c.get("apiKey") as ExecutionApiKeyContext | undefined;
  const granted = apiKey?.permissions?.execution;
  return (
    Array.isArray(granted) && granted.some((scope) => scopes.includes(scope))
  );
}

async function isInstanceAdminOrExecutionScope(
  c: Context,
  scopes: readonly string[],
): Promise<boolean> {
  return hasExecutionScope(c, scopes) || (await isInstanceAdmin(c));
}

function isTelegramControlKey(c: Context): boolean {
  return (
    hasExecutionScope(c, ["telegram_control"]) &&
    !hasExecutionScope(c, ["review"])
  );
}

/**
 * Parent review remains the only path to review/merge. A Telegram control key
 * may create only restricted control requests, after task-read workspace access
 * has already been established by workspaceAccess.fromTask().
 */
async function requireControlRequestPermission(c: Context, next: Next) {
  if (!isTelegramControlKey(c)) {
    return requireWorkspacePermission({ execution: ["review"] })(c, next);
  }
  if (!(await hasWorkspacePermission(c, { task: ["read"] }))) {
    throw new HTTPException(403, { message: "Insufficient permissions" });
  }
  return next();
}

const executionQueryLimit = v.optional(
  v.pipe(
    v.string(),
    v.transform((value) => Number(value)),
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(200),
  ),
);

const execution = new Hono<{
  Variables: {
    userId: string;
    workspaceId: string;
    apiKey?: { permissions?: Record<string, string[]> | null };
  };
}>()
  .get(
    "/flags",
    describeRoute({
      operationId: "listExecutionFlags",
      tags: ["Execution"],
      description: "List server-side execution kill-switch flags",
      responses: {
        200: {
          description: "Execution flags",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    name: v.string(),
                    enabled: v.boolean(),
                    updatedAt: v.nullable(v.date()),
                  }),
                ),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      if (!(await isInstanceAdmin(c))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      return c.json(await listExecutionFlags());
    },
  )
  .put(
    "/flags/:name",
    describeRoute({
      operationId: "setExecutionFlag",
      tags: ["Execution"],
      description: "Change one server-side execution kill-switch flag",
      responses: { 200: { description: "Execution flag updated" } },
    }),
    validator("param", v.object({ name: v.string() })),
    validator("json", v.object({ enabled: v.boolean() })),
    async (c) => {
      if (!(await isInstanceAdmin(c))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const { name } = c.req.valid("param");
      const { enabled } = c.req.valid("json");
      return c.json(await setExecutionFlag(name, enabled));
    },
  )
  .get(
    "/agents",
    describeRoute({
      operationId: "listExecutionAgentsGlobal",
      tags: ["Execution"],
      description: "List all execution principals owned by the current user",
      responses: {
        200: {
          description: "Execution principals",
          content: {
            "application/json": {
              schema: resolver(v.array(agentPrincipalSchema)),
            },
          },
        },
      },
    }),
    async (c) => c.json(await listAgentPrincipals(c.get("userId"))),
  )
  .get(
    "/fallback/due",
    describeRoute({
      operationId: "listPreapprovedFallbackCandidates",
      tags: ["Execution"],
      description:
        "List provider-blocked runs and unspawned declared fallback runs",
      responses: { 200: { description: "Fallback candidates" } },
    }),
    validator("query", v.object({ host: v.optional(v.string()) })),
    async (c) => {
      if (!(await isInstanceAdmin(c))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const apiKey = c.get("apiKey");
      if (apiKey && !apiKey.permissions?.execution?.includes("review")) {
        return c.json({ error: "Insufficient API key scope" }, 403);
      }
      const host = c.req.valid("query").host?.trim() || "prodesk-home";
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(host)) {
        return c.json({ error: "Invalid host binding" }, 400);
      }
      return c.json(await listPreapprovedFallbackCandidates(host));
    },
  )
  .post(
    "/watchdog/reclaim",
    describeRoute({
      operationId: "reclaimStaleExecutionRuns",
      tags: ["Execution"],
      description:
        "Revoke expired worker leases and record durable watchdog evidence",
      responses: {
        200: {
          description: "Stale runs reclaimed",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    id: v.string(),
                    taskId: v.string(),
                    leaseEpoch: v.number(),
                    lastHeartbeatAt: v.date(),
                  }),
                ),
              ),
            },
          },
        },
      },
    }),
    validator("json", v.object({ staleAfterSeconds: v.optional(v.number()) })),
    async (c) => {
      if (!(await isInstanceAdmin(c))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const apiKey = c.get("apiKey") as
        | { permissions?: Record<string, string[]> | null }
        | undefined;
      if (apiKey && !apiKey.permissions?.execution?.includes("review")) {
        return c.json({ error: "Insufficient API key scope" }, 403);
      }
      return c.json(await reclaimStaleTaskRuns(c.req.valid("json")));
    },
  )
  .get(
    "/project/:projectId/manifest",
    describeRoute({
      operationId: "getExecutionManifest",
      tags: ["Execution"],
      description: "Get the execution manifest for a project",
      responses: {
        200: {
          description: "Execution manifest",
          content: {
            "application/json": { schema: resolver(executionManifestSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    workspaceAccess.fromProject("projectId"),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const manifest = await getExecutionManifest(projectId);
      if (!manifest)
        return c.json({ error: "Execution manifest not found" }, 404);
      return c.json(manifest);
    },
  )
  .put(
    "/project/:projectId/manifest",
    describeRoute({
      operationId: "upsertExecutionManifest",
      tags: ["Execution"],
      description: "Create or update a project execution manifest",
      responses: {
        200: {
          description: "Execution manifest saved",
          content: {
            "application/json": { schema: resolver(executionManifestSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "json",
      v.object({
        baseBranch: v.string(),
        docs: v.optional(v.array(v.string())),
        verificationProfile: v.string(),
        allowedAgentIds: v.array(v.string()),
        policy: v.optional(v.record(v.string(), v.unknown())),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ project: ["update"] }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const manifest = await upsertExecutionManifest(
        projectId,
        c.req.valid("json"),
      );
      return c.json(manifest);
    },
  )
  .get(
    "/project/:projectId/agents",
    describeRoute({
      operationId: "listExecutionAgents",
      tags: ["Execution"],
      description: "List execution principals owned by the current user",
      responses: {
        200: {
          description: "Execution principals",
          content: {
            "application/json": {
              schema: resolver(v.array(agentPrincipalSchema)),
            },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    workspaceAccess.fromProject("projectId"),
    async (c) => {
      const { projectId } = c.req.valid("param");
      return c.json(await listAgentPrincipals(c.get("userId"), projectId));
    },
  )
  .post(
    "/project/:projectId/agents",
    describeRoute({
      operationId: "createExecutionAgent",
      tags: ["Execution"],
      description: "Register a server-side execution principal",
      responses: {
        200: {
          description: "Execution principal created",
          content: {
            "application/json": {
              schema: resolver(agentPrincipalSchema),
            },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "json",
      v.object({
        runtimeId: v.string(),
        hostId: v.string(),
        scopes: v.optional(v.array(v.string())),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ project: ["update"] }),
    async (c) => {
      const principal = await createAgentPrincipal(
        c.get("userId"),
        c.req.valid("json"),
      );
      return c.json(principal, 201);
    },
  )
  .get(
    "/task/:taskId/runs",
    describeRoute({
      operationId: "listTaskRuns",
      tags: ["Execution"],
      description: "List durable execution runs for a task",
      responses: {
        200: {
          description: "Task execution runs",
          content: {
            "application/json": { schema: resolver(v.array(taskRunSchema)) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string() })),
    workspaceAccess.fromTask("taskId"),
    async (c) => c.json(await listTaskRuns(c.req.valid("param").taskId)),
  )
  .get(
    "/task/:taskId/runs/:runId",
    describeRoute({
      operationId: "getTaskRun",
      tags: ["Execution"],
      description: "Get one durable execution run",
      responses: {
        200: {
          description: "Task execution run",
          content: {
            "application/json": { schema: resolver(taskRunSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string(), runId: v.string() })),
    workspaceAccess.fromTask("taskId"),
    async (c) => {
      const { taskId, runId } = c.req.valid("param");
      return c.json(await getTaskRun(taskId, runId));
    },
  )
  .get(
    "/task/:taskId/runs/:runId/evidence",
    describeRoute({
      operationId: "listTaskRunEvidence",
      tags: ["Execution"],
      description: "List append-only evidence records for a task run",
      responses: {
        200: {
          description: "Task run evidence",
          content: {
            "application/json": {
              schema: resolver(v.array(taskRunEvidenceSchema)),
            },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string(), runId: v.string() })),
    workspaceAccess.fromTask("taskId"),
    async (c) => {
      const { taskId, runId } = c.req.valid("param");
      return c.json(await listTaskRunEvidence(taskId, runId));
    },
  )
  .post(
    "/task/:taskId/runs/claim",
    describeRoute({
      operationId: "claimTaskRun",
      tags: ["Execution"],
      description: "Claim one fenced worker lease for a task",
      responses: {
        201: {
          description: "Task run claimed",
          content: {
            "application/json": { schema: resolver(taskRunSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string() })),
    validator(
      "json",
      v.object({
        agentPrincipalId: v.string(),
        scope: v.array(v.string()),
      }),
    ),
    workspaceAccess.fromTask("taskId"),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const { taskId } = c.req.valid("param");
      const { agentPrincipalId, scope } = c.req.valid("json");
      const result = await claimTaskRun({
        taskId,
        userId: c.get("userId"),
        agentPrincipalId,
        scope,
        requestKey,
      });
      return c.json(
        toTaskRunResponse(result.run, result.leaseToken),
        result.leaseToken ? 201 : 200,
      );
    },
  )
  .post(
    "/task/:taskId/runs/:runId/heartbeat",
    describeRoute({
      operationId: "heartbeatTaskRun",
      tags: ["Execution"],
      description: "Renew a task run lease using its fencing token",
      responses: {
        200: {
          description: "Lease renewed",
          content: {
            "application/json": { schema: resolver(taskRunSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string(), runId: v.string() })),
    validator("json", v.object({ leaseEpoch: v.number() })),
    workspaceAccess.fromTask("taskId"),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { taskId, runId } = c.req.valid("param");
      const { leaseEpoch } = c.req.valid("json");
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const leaseToken = c.req.header("X-Kaneo-Lease-Token")?.trim();
      if (!leaseToken) return c.json({ error: "Lease token is required" }, 401);
      const run = await heartbeatTaskRun({
        taskId,
        runId,
        userId: c.get("userId"),
        leaseEpoch,
        leaseToken,
        requestKey,
      });
      return c.json(run);
    },
  )
  .post(
    "/task/:taskId/runs/:runId/report",
    describeRoute({
      operationId: "reportTaskRun",
      tags: ["Execution"],
      description: "Report worker evidence without bypassing the parent gate",
      responses: {
        200: {
          description: "Task run report accepted",
          content: {
            "application/json": { schema: resolver(taskRunSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string(), runId: v.string() })),
    validator(
      "json",
      v.object({
        leaseEpoch: v.number(),
        state: v.string(),
        baseSha: v.optional(v.string()),
        commitSha: v.optional(v.string()),
        prNumber: v.optional(v.number()),
        prUrl: v.optional(v.string()),
        prState: v.optional(v.string()),
        evidence: v.optional(v.record(v.string(), v.unknown())),
        blocker: v.optional(v.string()),
        nextAction: v.optional(v.string()),
        failureKind: v.optional(v.string()),
        modelFailed: v.optional(v.string()),
        retryAt: v.optional(v.string()),
        expectedRunRevision: v.optional(v.number()),
      }),
    ),
    workspaceAccess.fromTask("taskId"),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { taskId, runId } = c.req.valid("param");
      const body = c.req.valid("json");
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const leaseToken = c.req.header("X-Kaneo-Lease-Token")?.trim();
      if (!leaseToken) return c.json({ error: "Lease token is required" }, 401);
      const run = await reportTaskRun({
        taskId,
        runId,
        userId: c.get("userId"),
        leaseEpoch: body.leaseEpoch,
        leaseToken,
        state: body.state,
        baseSha: body.baseSha,
        commitSha: body.commitSha,
        prNumber: body.prNumber,
        prUrl: body.prUrl,
        prState: body.prState,
        evidence: body.evidence,
        blocker: body.blocker,
        nextAction: body.nextAction,
        failureKind: body.failureKind,
        modelFailed: body.modelFailed,
        retryAt: body.retryAt,
        expectedRunRevision: body.expectedRunRevision,
        requestKey,
      });
      return c.json(run);
    },
  )
  .post(
    "/task/:taskId/runs/:runId/checkpoints",
    describeRoute({
      operationId: "createTaskRunCheckpoint",
      tags: ["Execution"],
      description:
        "Record a durable worker checkpoint backed by a fixed Git guard push receipt",
      responses: {
        200: {
          description: "Checkpoint accepted",
          content: {
            "application/json": { schema: resolver(taskRunSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string(), runId: v.string() })),
    validator(
      "json",
      v.object({
        leaseEpoch: v.number(),
        baseSha: v.optional(v.string()),
        headSha: v.string(),
        commitSha: v.string(),
        guardReceipt: v.record(v.string(), v.unknown()),
        commands: v.optional(v.array(v.string())),
        artifactHashes: v.optional(v.record(v.string(), v.unknown())),
        verifyResult: v.optional(v.record(v.string(), v.unknown())),
        expectedRunRevision: v.optional(v.number()),
      }),
    ),
    workspaceAccess.fromTask("taskId"),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { taskId, runId } = c.req.valid("param");
      const body = c.req.valid("json");
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const leaseToken = c.req.header("X-Kaneo-Lease-Token")?.trim();
      if (!leaseToken) return c.json({ error: "Lease token is required" }, 401);
      const run = await createTaskRunCheckpoint({
        taskId,
        runId,
        userId: c.get("userId"),
        leaseEpoch: body.leaseEpoch,
        leaseToken,
        baseSha: body.baseSha,
        headSha: body.headSha,
        commitSha: body.commitSha,
        guardReceipt: body.guardReceipt,
        commands: body.commands,
        artifactHashes: body.artifactHashes,
        verifyResult: body.verifyResult,
        expectedRunRevision: body.expectedRunRevision,
        requestKey,
      });
      return c.json(run);
    },
  )
  .post(
    "/task/:taskId/runs/:runId/supervisor-report",
    describeRoute({
      operationId: "supervisorReportTaskRun",
      tags: ["Execution"],
      description:
        "Dispatcher supervisor terminalizes a run from the structured worker terminal receipt",
      responses: {
        200: {
          description: "Supervisor report applied",
          content: {
            "application/json": { schema: resolver(taskRunSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string(), runId: v.string() })),
    validator(
      "json",
      v.object({
        agentPrincipalId: v.string(),
        occurrenceId: v.optional(v.string()),
        handoffHash: v.optional(v.string()),
        workerTerminalReceipt: v.record(v.string(), v.unknown()),
        expectedRunRevision: v.optional(v.number()),
      }),
    ),
    workspaceAccess.fromTask("taskId"),
    async (c, next) => {
      if (!(await isInstanceAdminOrExecutionScope(c, ["dispatch", "review"]))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      return next();
    },
    async (c) => {
      const { taskId, runId } = c.req.valid("param");
      const body = c.req.valid("json");
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const supervisorFence = c.req.header("X-Kaneo-Supervisor-Fence")?.trim();
      if (!supervisorFence) {
        return c.json({ error: "Supervisor fence is required" }, 401);
      }
      const run = await supervisorReportTaskRun({
        taskId,
        runId,
        userId: c.get("userId"),
        agentPrincipalId: body.agentPrincipalId,
        occurrenceId: body.occurrenceId,
        handoffHash: body.handoffHash,
        supervisorFence,
        workerTerminalReceipt: body.workerTerminalReceipt,
        expectedRunRevision: body.expectedRunRevision,
        requestKey,
      });
      return c.json(run);
    },
  )
  .post(
    "/task/:taskId/runs/:runId/review",
    describeRoute({
      operationId: "reviewTaskRun",
      tags: ["Execution"],
      description:
        "Approve or reject a worker run through the parent review and PR/merge gate",
      responses: {
        200: {
          description: "Parent review result",
          content: {
            "application/json": { schema: resolver(taskRunSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string(), runId: v.string() })),
    validator(
      "json",
      v.object({
        decision: v.picklist(["approve", "reject"]),
        action: v.optional(v.picklist(["none", "create_pr", "merge"])),
        reason: v.optional(v.string()),
        verification: v.optional(v.record(v.string(), v.unknown())),
        prResult: v.optional(v.record(v.string(), v.unknown())),
        expectedTaskRevision: v.optional(v.number()),
        expectedRunRevision: v.optional(v.number()),
        reviewHeadSha: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromTask("taskId"),
    requireWorkspacePermission({ execution: ["review"] }),
    async (c) => {
      const { taskId, runId } = c.req.valid("param");
      const body = c.req.valid("json");
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const run = await reviewTaskRun({
        taskId,
        runId,
        userId: c.get("userId"),
        decision: body.decision,
        action: body.action,
        reason: body.reason,
        verification: body.verification,
        prResult: body.prResult,
        expectedTaskRevision: body.expectedTaskRevision,
        expectedRunRevision: body.expectedRunRevision,
        reviewHeadSha: body.reviewHeadSha,
        requestKey,
      });
      return c.json(run);
    },
  )
  .post(
    "/task/:taskId/runs/:runId/resume",
    describeRoute({
      operationId: "resumeTaskRun",
      tags: ["Execution"],
      description:
        "Create a new fenced run on the original task branch after a blocked/stale run",
      responses: {
        201: {
          description: "Task run resumed",
          content: {
            "application/json": { schema: resolver(taskRunSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string(), runId: v.string() })),
    validator(
      "json",
      v.object({
        agentPrincipalId: v.string(),
        preferredModel: v.optional(v.nullable(v.string())),
        initiatedBy: v.optional(v.picklist(["telegram", "parent"])),
        contextNote: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromTask("taskId"),
    requireWorkspacePermission({ task: ["update"], execution: ["review"] }),
    async (c) => {
      const { taskId, runId } = c.req.valid("param");
      const body = c.req.valid("json");
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const result = await resumeTaskRun({
        taskId,
        sourceRunId: runId,
        userId: c.get("userId"),
        agentPrincipalId: body.agentPrincipalId,
        preferredModel: body.preferredModel,
        initiatedBy: body.initiatedBy,
        contextNote: body.contextNote,
        requestKey,
      });
      // Dispatch metadata (occurrence + one-time fence/ack) rides only on the
      // create response to the authorized dispatcher caller, mirroring the
      // schedule dispatch response contract.
      const payload = toTaskRunResponse(result.run, result.leaseToken);
      return c.json(
        result.dispatch ? { ...payload, dispatch: result.dispatch } : payload,
        result.leaseToken ? 201 : 200,
      );
    },
  )
  .post(
    "/task/:taskId/runs/:runId/fallback",
    describeRoute({
      operationId: "advancePreapprovedFallback",
      tags: ["Execution"],
      description:
        "Create the next declared fallback run after a provider-blocked run",
      responses: {
        201: {
          description: "Fallback run created",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  outcome: v.string(),
                  run: taskRunSchema,
                }),
              ),
            },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string(), runId: v.string() })),
    validator("json", v.object({ agentPrincipalId: v.string() })),
    async (c) => {
      if (!(await isInstanceAdmin(c))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const apiKey = c.get("apiKey");
      if (apiKey && !apiKey.permissions?.execution?.includes("review")) {
        return c.json({ error: "Insufficient API key scope" }, 403);
      }
      const { taskId, runId } = c.req.valid("param");
      const { agentPrincipalId } = c.req.valid("json");
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const result = await advancePreapprovedFallback({
        taskId,
        sourceRunId: runId,
        userId: c.get("userId"),
        agentPrincipalId,
        requestKey,
      });
      return c.json(
        { outcome: result.outcome, run: result.run },
        result.outcome === "created" ? 201 : 200,
      );
    },
  )
  .post(
    "/task/:taskId/runs/:runId/release",
    describeRoute({
      operationId: "releaseTaskRun",
      tags: ["Execution"],
      description: "Release a worker lease without finalizing the task",
      responses: {
        200: {
          description: "Task run lease released",
          content: {
            "application/json": { schema: resolver(taskRunSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string(), runId: v.string() })),
    validator(
      "json",
      v.object({ leaseEpoch: v.number(), state: v.optional(v.string()) }),
    ),
    workspaceAccess.fromTask("taskId"),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { taskId, runId } = c.req.valid("param");
      const body = c.req.valid("json");
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const leaseToken = c.req.header("X-Kaneo-Lease-Token")?.trim();
      if (!leaseToken) return c.json({ error: "Lease token is required" }, 401);
      const run = await releaseTaskRun({
        taskId,
        runId,
        userId: c.get("userId"),
        leaseEpoch: body.leaseEpoch,
        leaseToken,
        state: body.state,
        requestKey,
      });
      return c.json(run);
    },
  )
  .post(
    "/task/:taskId/schedules",
    describeRoute({
      operationId: "createExecutionSchedule",
      tags: ["Execution"],
      description:
        "Create a durable one-shot dispatch schedule for a task (SPEC-KANEO-MULTI-PI-4CMD T6)",
      responses: {
        201: {
          description: "Schedule created",
          content: {
            "application/json": {
              schema: resolver(v.object({ id: v.string() })),
            },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string() })),
    validator(
      "json",
      v.object({
        notBefore: v.pipe(
          v.string(),
          v.transform((value) => new Date(value)),
        ),
        host: v.optional(v.string()),
        preferredModel: v.optional(v.nullable(v.string())),
        fallbackMode: v.optional(v.string()),
        fallbackModels: v.optional(v.array(v.string())),
        maxRuntimeSeconds: v.number(),
        concurrencyKey: v.optional(v.string()),
        retryPolicy: v.optional(v.record(v.string(), v.unknown())),
        dependencyPolicy: v.optional(v.string()),
        notificationRoute: v.optional(v.string()),
        telegramQuotaResume: v.optional(v.string()),
        planHash: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromTask("taskId"),
    requireWorkspacePermission({ task: ["update"], execution: ["review"] }),
    async (c) => {
      const { taskId } = c.req.valid("param");
      const body = c.req.valid("json");
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const task = await getTaskProjectId(taskId);
      const schedule = await createExecutionSchedule({
        taskId,
        projectId: task.projectId,
        userId: c.get("userId"),
        requestKey,
        notBefore: body.notBefore,
        host: body.host,
        preferredModel: body.preferredModel ?? null,
        fallbackMode: body.fallbackMode,
        fallbackModels: body.fallbackModels,
        maxRuntimeSeconds: body.maxRuntimeSeconds,
        concurrencyKey: body.concurrencyKey,
        retryPolicy: body.retryPolicy,
        dependencyPolicy: body.dependencyPolicy,
        notificationRoute: body.notificationRoute,
        telegramQuotaResume: body.telegramQuotaResume,
        planHash: body.planHash,
      });
      return c.json({ id: schedule.id }, 201);
    },
  )
  .patch(
    "/schedules/:scheduleId",
    describeRoute({
      operationId: "updateExecutionSchedule",
      tags: ["Execution"],
      description:
        "Update a pending schedule with CAS (SPEC-kaneo-wavefix-v0-2 T4). Already-dispatched schedules are immutable.",
      responses: {
        200: {
          description: "Schedule updated",
          content: {
            "application/json": { schema: resolver(v.object({ id: v.string(), scheduleRevision: v.number() })) },
          },
        },
      },
    }),
    validator("param", v.object({ scheduleId: v.string() })),
    validator(
      "json",
      v.object({
        expectedScheduleRevision: v.number(),
        notBefore: v.optional(v.pipe(v.string(), v.transform((value) => new Date(value)))),
        preferredModel: v.optional(v.nullable(v.string())),
        maxRuntimeSeconds: v.optional(v.number()),
        notificationRoute: v.optional(v.string()),
        telegramQuotaResume: v.optional(v.string()),
        planHash: v.optional(v.string()),
      }),
    ),
    requireWorkspacePermission({ execution: ["review"] }),
    async (c) => {
      const { scheduleId } = c.req.valid("param");
      const body = c.req.valid("json");
      const updated = await updateExecutionSchedule({
        scheduleId,
        userId: c.get("userId"),
        expectedScheduleRevision: body.expectedScheduleRevision,
        notBefore: body.notBefore,
        preferredModel: body.preferredModel,
        maxRuntimeSeconds: body.maxRuntimeSeconds,
        notificationRoute: body.notificationRoute,
        telegramQuotaResume: body.telegramQuotaResume,
        planHash: body.planHash,
      });
      return c.json({ id: updated.id, scheduleRevision: updated.scheduleRevision });
    },
  )
  .post(
    "/schedules/:scheduleId/cancel",
    describeRoute({
      operationId: "cancelExecutionSchedule",
      tags: ["Execution"],
      description:
        "Cancel a pending schedule with CAS (SPEC-kaneo-wavefix-v0-2 T4). Idempotent on already-cancelled; 409 on already-dispatched.",
      responses: {
        200: {
          description: "Schedule cancelled",
          content: {
            "application/json": { schema: resolver(v.object({ id: v.string(), scheduleRevision: v.number() })) },
          },
        },
      },
    }),
    validator("param", v.object({ scheduleId: v.string() })),
    validator(
      "json",
      v.object({ expectedScheduleRevision: v.number() }),
    ),
    requireWorkspacePermission({ execution: ["review"] }),
    async (c) => {
      const { scheduleId } = c.req.valid("param");
      const body = c.req.valid("json");
      const cancelled = await cancelExecutionSchedule({
        scheduleId,
        userId: c.get("userId"),
        expectedScheduleRevision: body.expectedScheduleRevision,
      });
      return c.json({ id: cancelled.id, scheduleRevision: cancelled.scheduleRevision });
    },
  )
  .get(
    "/schedules/due",
    describeRoute({
      operationId: "listDueExecutionSchedules",
      tags: ["Execution"],
      description:
        "List due enabled schedules for a host (dispatcher poll; instance admin only)",
      responses: {
        200: {
          description: "Due schedules",
          content: {
            "application/json": {
              schema: resolver(
                v.array(
                  v.object({
                    id: v.string(),
                    taskId: v.string(),
                    projectId: v.string(),
                    notBefore: v.string(),
                    timezone: v.string(),
                    host: v.string(),
                    preferredModel: v.nullable(v.string()),
                    fallbackModels: v.array(v.string()),
                    fallbackMode: v.string(),
                    maxRuntimeSeconds: v.number(),
                    retryPolicy: v.record(v.string(), v.number()),
                    concurrencyKey: v.string(),
                    enabled: v.boolean(),
                    lastDispatchAt: v.nullable(v.string()),
                    nextDispatchAt: v.nullable(v.string()),
                  }),
                ),
              ),
            },
          },
        },
      },
    }),
    validator("query", v.object({ host: v.string() })),
    async (c) => {
      if (!(await isInstanceAdmin(c))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const apiKey = c.get("apiKey") as
        | { permissions?: Record<string, string[]> | null }
        | undefined;
      if (apiKey && !apiKey.permissions?.execution?.includes("review")) {
        return c.json({ error: "Insufficient API key scope" }, 403);
      }
      const schedules = await listDueSchedules({
        host: c.req.valid("query").host,
      });
      return c.json(schedules);
    },
  )
  .post(
    "/schedules/:scheduleId/dispatch",
    describeRoute({
      operationId: "dispatchExecutionSchedule",
      tags: ["Execution"],
      description:
        "Claim the occurrence and create the run exactly once (dispatcher or parent manual trigger; instance admin only)",
      responses: {
        200: {
          description: "Dispatch outcome",
          content: {
            "application/json": {
              schema: resolver(
                v.object({
                  scheduleId: v.string(),
                  occurrenceId: v.string(),
                  runId: v.nullable(v.string()),
                  outcome: v.string(),
                  reason: v.optional(v.string()),
                  ackToken: v.optional(v.string()),
                  runnerSupervisorFence: v.optional(v.string()),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("param", v.object({ scheduleId: v.string() })),
    validator(
      "json",
      v.object({
        scope: v.array(v.string()),
        agentPrincipalId: v.string(),
        noOpReason: v.optional(v.string()),
        expectedScheduleRevision: v.optional(v.number()),
      }),
    ),
    async (c) => {
      if (!(await isInstanceAdmin(c))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const apiKey = c.get("apiKey") as
        | { permissions?: Record<string, string[]> | null }
        | undefined;
      if (apiKey && !apiKey.permissions?.execution?.includes("review")) {
        return c.json({ error: "Insufficient API key scope" }, 403);
      }
      const { scheduleId } = c.req.valid("param");
      const body = c.req.valid("json");
      const schedule = await getScheduleById(scheduleId);
      const outcome = await dispatchScheduleOnce({
        schedule: {
          id: schedule.id,
          taskId: schedule.taskId,
          host: schedule.host,
          enabled: schedule.enabled,
          notBefore: schedule.notBefore,
          nextDispatchAt: schedule.nextDispatchAt,
          preferredModel: schedule.preferredModel,
          fallbackMode: schedule.fallbackMode,
          fallbackModels: schedule.fallbackModels,
          maxRuntimeSeconds: schedule.maxRuntimeSeconds,
          concurrencyKey: schedule.concurrencyKey,
          retryPolicy: schedule.retryPolicy as Record<string, number>,
        },
        dispatcherIdentity: {
          userId: c.get("userId"),
          agentPrincipalId: body.agentPrincipalId,
        },
        scope: body.scope,
        noOpReason: body.noOpReason,
        expectedScheduleRevision: body.expectedScheduleRevision,
      });
      return c.json(outcome);
    },
  )
  .post(
    "/schedules/:scheduleId/ack",
    describeRoute({
      operationId: "acknowledgeExecutionScheduleDispatch",
      tags: ["Execution"],
      description:
        "Acknowledge that the fixed host runner started; closes a one-shot schedule",
      responses: {
        200: {
          description: "Schedule acknowledged",
          content: {
            "application/json": {
              schema: resolver(v.object({ id: v.string() })),
            },
          },
        },
      },
    }),
    validator("param", v.object({ scheduleId: v.string() })),
    validator(
      "json",
      v.object({
        occurrenceId: v.string(),
        runId: v.string(),
        agentPrincipalId: v.string(),
        ackToken: v.string(),
      }),
    ),
    async (c) => {
      if (!(await isInstanceAdmin(c))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const apiKey = c.get("apiKey") as
        | { permissions?: Record<string, string[]> | null }
        | undefined;
      if (apiKey && !apiKey.permissions?.execution?.includes("review")) {
        return c.json({ error: "Insufficient API key scope" }, 403);
      }
      const { scheduleId } = c.req.valid("param");
      const body = c.req.valid("json");
      const schedule = await acknowledgeScheduleDispatch({
        scheduleId,
        occurrenceId: body.occurrenceId,
        runId: body.runId,
        userId: c.get("userId"),
        agentPrincipalId: body.agentPrincipalId,
        ackToken: body.ackToken,
      });
      return c.json({ id: schedule.id });
    },
  )
  .post(
    "/control-requests",
    describeRoute({
      operationId: "createExecutionControlRequest",
      tags: ["Execution"],
      description:
        "Create a structured control request (parent or Telegram actor derived from API key scope)",
      responses: {
        200: {
          description: "Control request created or replayed",
          content: {
            "application/json": {
              schema: resolver(v.record(v.string(), v.unknown())),
            },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        taskId: v.string(),
        runId: v.optional(v.string()),
        action: v.string(),
        eventId: v.optional(v.string()),
        deliveryId: v.optional(v.string()),
        payload: v.optional(v.record(v.string(), v.unknown())),
        expectedTaskRevision: v.optional(v.number()),
        expectedRunRevision: v.optional(v.number()),
        expiresInSeconds: v.optional(v.number()),
        host: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromTask("taskId"),
    requireControlRequestPermission,
    async (c) => {
      const body = c.req.valid("json");
      const requestKey = c.req.header("Idempotency-Key")?.trim() || "";
      const apiKey = c.get("apiKey") as ExecutionApiKeyContext | undefined;
      const isTelegram =
        Boolean(apiKey?.permissions?.execution?.includes("telegram_control")) &&
        !apiKey?.permissions?.execution?.includes("review");
      const actorType = isTelegram ? "telegram" : "parent";
      if (isTelegram && body.action === "create_dispatch_request") {
        // Telegram dispatch requests are always modelPolicy=inherit; the
        // payload cannot carry a preferred model.
        if (
          body.payload &&
          Object.keys(body.payload).some((key) =>
            ["preferredModel", "model", "modelPolicy"].includes(key),
          )
        ) {
          return c.json(
            { error: "Telegram dispatch requests cannot carry a model policy" },
            400,
          );
        }
      }
      const result = await createControlRequest({
        taskId: body.taskId,
        runId: body.runId,
        action: body.action,
        actorType,
        authenticatedPrincipalId: apiKey?.id ?? null,
        actorUserId: c.get("userId") || apiKey?.userId || null,
        route: isTelegram ? "prodesk-telegram" : null,
        host: body.host ?? (isTelegram ? "pi-prodesk" : null),
        eventId: body.eventId,
        deliveryId: body.deliveryId,
        payload: body.payload,
        expectedTaskRevision: body.expectedTaskRevision,
        expectedRunRevision: body.expectedRunRevision,
        expiresInSeconds: body.expiresInSeconds,
        requestKey,
      });
      return c.json(result);
    },
  )
  .get(
    "/control-requests/due",
    describeRoute({
      operationId: "listDueControlRequests",
      tags: ["Execution"],
      description: "Dispatcher view of pending control requests for a host",
      responses: {
        200: {
          description: "Pending control requests",
          content: {
            "application/json": {
              schema: resolver(v.record(v.string(), v.unknown())),
            },
          },
        },
      },
    }),
    validator(
      "query",
      v.object({ host: v.string(), limit: executionQueryLimit }),
    ),
    async (c) => {
      if (!(await isInstanceAdminOrExecutionScope(c, ["dispatch", "review"]))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const query = c.req.valid("query");
      const requests = await listDueControlRequests({
        host: query.host,
        limit: query.limit,
      });
      return c.json(requests);
    },
  )
  .post(
    "/control-requests/:id/claim",
    describeRoute({
      operationId: "claimExecutionControlRequest",
      tags: ["Execution"],
      description: "CAS claim a pending control request for a consumer",
      responses: {
        200: {
          description: "Claim outcome",
          content: {
            "application/json": {
              schema: resolver(v.record(v.string(), v.unknown())),
            },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        consumerId: v.string(),
        claimTtlSeconds: v.optional(v.number()),
      }),
    ),
    async (c) => {
      if (!(await isInstanceAdminOrExecutionScope(c, ["dispatch", "review"]))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await claimControlRequest({
        id,
        consumerId: body.consumerId,
        claimTtlSeconds: body.claimTtlSeconds,
      });
      return c.json(result);
    },
  )
  .post(
    "/control-requests/:id/apply",
    describeRoute({
      operationId: "applyExecutionControlRequest",
      tags: ["Execution"],
      description: "CAS apply a claimed control request outcome",
      responses: {
        200: {
          description: "Apply outcome",
          content: {
            "application/json": {
              schema: resolver(v.record(v.string(), v.unknown())),
            },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        consumerId: v.string(),
        outcome: v.picklist(["applied", "rejected"]),
        result: v.optional(v.record(v.string(), v.unknown())),
      }),
    ),
    async (c) => {
      if (!(await isInstanceAdminOrExecutionScope(c, ["dispatch", "review"]))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await applyControlRequest({
        id,
        consumerId: body.consumerId,
        outcome: body.outcome,
        result: body.result,
      });
      return c.json(result);
    },
  )
  .get(
    "/notification-events/due",
    describeRoute({
      operationId: "listDueNotificationEvents",
      tags: ["Execution"],
      description:
        "TelePi observer view of due notification events for a route",
      responses: {
        200: {
          description: "Due notification events with delivery rows",
          content: {
            "application/json": {
              schema: resolver(v.record(v.string(), v.unknown())),
            },
          },
        },
      },
    }),
    validator(
      "query",
      v.object({
        route: v.optional(v.string()),
        limit: executionQueryLimit,
      }),
    ),
    async (c) => {
      if (
        !(await isInstanceAdminOrExecutionScope(c, [
          "telegram_read",
          "telegram_control",
        ]))
      ) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const query = c.req.valid("query");
      const events = await listDueNotificationEvents({
        route: query.route ?? DEFAULT_NOTIFICATION_ROUTE,
        limit: query.limit,
      });
      return c.json(events);
    },
  )
  .post(
    "/notification-deliveries/:id",
    describeRoute({
      operationId: "updateNotificationDelivery",
      tags: ["Execution"],
      description: "Record delivery lifecycle state for a notification event",
      responses: {
        200: {
          description: "Delivery updated",
          content: {
            "application/json": {
              schema: resolver(v.record(v.string(), v.unknown())),
            },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        state: v.picklist([
          "pending",
          "sending",
          "sent",
          "send_unknown",
          "acked",
          "dead_letter",
        ]),
        route: v.optional(v.string()),
        telegramMessageIds: v.optional(v.array(v.number())),
        lastError: v.optional(v.string()),
      }),
    ),
    async (c) => {
      if (!(await isInstanceAdminOrExecutionScope(c, ["telegram_control"]))) {
        return c.json({ error: "Insufficient permissions" }, 403);
      }
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      try {
        const delivery = await updateNotificationDelivery({
          id,
          route: body.route,
          state: body.state,
          telegramMessageIds: body.telegramMessageIds,
          lastError: body.lastError,
        });
        return c.json(delivery);
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "unknown" },
          400,
        );
      }
    },
  );

export default execution;
