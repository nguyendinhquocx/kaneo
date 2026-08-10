import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import {
  agentPrincipalSchema,
  executionManifestSchema,
  taskRunEvidenceSchema,
  taskRunSchema,
} from "../schemas";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import {
  claimTaskRun,
  createAgentPrincipal,
  getExecutionManifest,
  getTaskRun,
  heartbeatTaskRun,
  listAgentPrincipals,
  listTaskRunEvidence,
  listTaskRuns,
  releaseTaskRun,
  reportTaskRun,
  toTaskRunResponse,
  upsertExecutionManifest,
} from "./service";

const execution = new Hono<{
  Variables: {
    userId: string;
    workspaceId: string;
  };
}>()
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
        requestKey,
      });
      return c.json(run);
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
  );

export default execution;
