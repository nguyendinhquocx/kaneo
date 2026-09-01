import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import {
  getExecutionMetrics,
  resetExecutionMetricsForTests,
} from "../../apps/api/src/execution/gates";
import { createApp } from "../../apps/api/src/index";
import { handlePullRequestClosed } from "../../apps/api/src/plugins/github/webhooks/pull-request-closed";
import {
  mockAuthenticatedSession,
  mockAuthenticatedSessions,
} from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

type RunResponse = {
  id: string;
  taskId: string;
  agentPrincipalId: string;
  leaseEpoch: number;
  leaseToken?: string;
  leaseActive: boolean;
  state: string;
};

async function hashApiKeyForTest(key: string): Promise<string> {
  const hash = createHash("sha256").update(key).digest();
  return hash
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function createTaskFixture() {
  const member = await createWorkspaceMember({ role: "admin" });
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      userId: member.user.id,
      title: "Execution fencing task",
      status: "to-do",
      columnId: columns.todo.id,
      priority: "medium",
      number: 1,
      position: 1,
    })
    .returning();

  await db.insert(schema.githubIntegrationTable).values({
    projectId: project.id,
    repositoryOwner: "owner",
    repositoryName: "repository",
    isActive: true,
  });

  return { member, project, task };
}

async function createExecutionWorker(workspaceId: string) {
  const worker = await createWorkspaceMember({
    userName: "Execution Worker User",
    role: "admin",
  });
  await db.insert(schema.workspaceUserTable).values({
    workspaceId,
    userId: worker.user.id,
    role: "admin",
    joinedAt: new Date(),
  });
  return worker;
}

describe("API integration: execution Task 1", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    resetExecutionMetricsForTests();
  });

  it("records the authenticated API-key actor when Telegram creates a control request", async () => {
    const { member, task } = await createTaskFixture();
    const rawKey = `telegram_control_${randomUUID()}`;
    const now = new Date();
    const hashedKey = await hashApiKeyForTest(rawKey);
    const [apiKey] = await db
      .insert(schema.apikeyTable)
      .values({
        referenceId: member.user.id,
        userId: member.user.id,
        key: hashedKey,
        name: "telegram control test key",
        start: rawKey.slice(0, 12),
        prefix: "kaneo",
        createdAt: now,
        updatedAt: now,
        permissions: JSON.stringify({
          task: ["read"],
          execution: ["telegram_control"],
        }),
      })
      .returning({ id: schema.apikeyTable.id });

    const { app } = createApp();
    const response = await app.request("/api/execution/control-requests", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
        "Idempotency-Key": "telegram-control-actor-1",
      },
      body: JSON.stringify({
        taskId: task.id,
        action: "read_status",
        expiresInSeconds: 300,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: "created",
      request: {
        actorType: "telegram",
        authenticatedPrincipalId: apiKey?.id,
        actorUserId: member.user.id,
        taskId: task.id,
        action: "read_status",
        state: "pending",
      },
    });
  });

  it("serializes manifest, allows one concurrent claim, and fences stale takeover", async () => {
    const { member, project, task } = await createTaskFixture();
    const laptopWorker = await createExecutionWorker(member.workspace.id);
    const prodeskWorker = await createExecutionWorker(member.workspace.id);
    mockAuthenticatedSessions(member.user, {
      "laptop-worker-token": laptopWorker.user,
      "prodesk-worker-token": prodeskWorker.user,
      "parent-review-token": member.user,
    });
    const { app } = createApp();

    const createAgent = async (runtimeId: string, authorization: string) => {
      const response = await app.request(
        `/api/execution/project/${project.id}/agents`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: authorization,
          },
          body: JSON.stringify({ runtimeId, hostId: `${runtimeId}-host` }),
        },
      );
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };

    const laptop = await createAgent("pi-laptop", "Bearer laptop-worker-token");
    const prodesk = await createAgent(
      "pi-prodesk",
      "Bearer prodesk-worker-token",
    );

    const manifestResponse = await app.request(
      `/api/execution/project/${project.id}/manifest`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseBranch: "main",
          docs: ["README.md", "docs/execution.md"],
          verificationProfile: "kaneo-api-test",
          allowedAgentIds: [laptop.id, prodesk.id],
          policy: { merge: "parent", allowMerge: true },
        }),
      },
    );
    expect(manifestResponse.status).toBe(200);
    expect(await manifestResponse.json()).toMatchObject({
      repositoryOwner: "owner",
      repositoryName: "repository",
      protocolVersion: 1,
      manifestVersion: 1,
    });

    const claim = (
      agentPrincipalId: string,
      requestKey: string,
      authorization: string,
    ) =>
      app.request(`/api/execution/task/${task.id}/runs/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": requestKey,
          Authorization: authorization,
        },
        body: JSON.stringify({
          agentPrincipalId,
          scope: ["apps/api/src", "tests/api"],
        }),
      });

    const [firstResponse, secondResponse] = await Promise.all([
      claim(laptop.id, "claim-laptop-1", "Bearer laptop-worker-token"),
      claim(prodesk.id, "claim-prodesk-1", "Bearer prodesk-worker-token"),
    ]);
    const successful = [firstResponse, secondResponse].filter(
      (response) => response.status === 201,
    );
    const conflicts = [firstResponse, secondResponse].filter(
      (response) => response.status === 409,
    );
    expect(successful).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(getExecutionMetrics()).toMatchObject({ lease_conflict: 1 });

    const firstRun = (await successful[0].json()) as RunResponse;
    expect(firstRun.leaseToken).toBeTruthy();
    expect(firstRun.leaseEpoch).toBe(1);
    expect(firstRun.state).toBe("in_progress");
    const firstRuntimeId =
      firstRun.agentPrincipalId === laptop.id ? "pi-laptop" : "pi-prodesk";
    expect(firstRun.branchName).toMatch(
      new RegExp(`^${firstRuntimeId}/${task.id}-${firstRun.id}-[a-z0-9-]+$`),
    );

    const retryResponse = await claim(
      firstRun.agentPrincipalId,
      firstRun.agentPrincipalId === laptop.id
        ? "claim-laptop-1"
        : "claim-prodesk-1",
      firstRun.agentPrincipalId === laptop.id
        ? "Bearer laptop-worker-token"
        : "Bearer prodesk-worker-token",
    );
    expect(retryResponse.status).toBe(200);
    const retryRun = (await retryResponse.json()) as RunResponse;
    expect(retryRun.id).toBe(firstRun.id);
    expect(retryRun.leaseToken).toBeUndefined();

    await db
      .update(schema.taskRunTable)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.taskRunTable.id, firstRun.id));

    const takeoverAgentId =
      firstRun.agentPrincipalId === laptop.id ? prodesk.id : laptop.id;
    const takeoverResponse = await claim(
      takeoverAgentId,
      "claim-takeover-1",
      takeoverAgentId === laptop.id
        ? "Bearer laptop-worker-token"
        : "Bearer prodesk-worker-token",
    );
    expect(takeoverResponse.status).toBe(201);
    const takeoverRun = (await takeoverResponse.json()) as RunResponse;
    const takeoverAuthorization =
      takeoverRun.agentPrincipalId === laptop.id
        ? "Bearer laptop-worker-token"
        : "Bearer prodesk-worker-token";
    const firstRunAuthorization =
      firstRun.agentPrincipalId === laptop.id
        ? "Bearer laptop-worker-token"
        : "Bearer prodesk-worker-token";
    expect(takeoverRun.leaseEpoch).toBe(2);
    expect(takeoverRun.id).not.toBe(firstRun.id);

    const heartbeatPath = `/api/execution/task/${task.id}/runs/${takeoverRun.id}/heartbeat`;
    const heartbeatRequest = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "takeover-heartbeat-1",
        "X-Kaneo-Lease-Token": takeoverRun.leaseToken ?? "",
        Authorization: takeoverAuthorization,
      },
      body: JSON.stringify({ leaseEpoch: takeoverRun.leaseEpoch }),
    };
    const [heartbeatResponse, concurrentHeartbeatResponse] = await Promise.all([
      app.request(heartbeatPath, heartbeatRequest),
      app.request(heartbeatPath, heartbeatRequest),
    ]);
    expect(heartbeatResponse.status).toBe(200);
    expect(concurrentHeartbeatResponse.status).toBe(200);
    const heartbeatBody = await heartbeatResponse.json();
    expect(await concurrentHeartbeatResponse.json()).toEqual(heartbeatBody);
    const heartbeatReplay = await app.request(heartbeatPath, heartbeatRequest);
    expect(heartbeatReplay.status).toBe(200);
    expect(await heartbeatReplay.json()).toEqual(heartbeatBody);

    const staleHeartbeat = await app.request(
      `/api/execution/task/${task.id}/runs/${firstRun.id}/heartbeat`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "stale-heartbeat-1",
          "X-Kaneo-Lease-Token": firstRun.leaseToken ?? "",
          Authorization: firstRunAuthorization,
        },
        body: JSON.stringify({ leaseEpoch: firstRun.leaseEpoch }),
      },
    );
    expect(staleHeartbeat.status).toBe(409);
    expect(getExecutionMetrics()).toMatchObject({
      stale_fence_rejected: expect.any(Number),
    });

    const staleReport = await app.request(
      `/api/execution/task/${task.id}/runs/${firstRun.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "stale-report-1",
          "X-Kaneo-Lease-Token": firstRun.leaseToken ?? "",
          Authorization: firstRunAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: firstRun.leaseEpoch,
          state: "failed",
          blocker: "stale worker",
        }),
      },
    );
    expect(staleReport.status).toBe(409);
    expect(getExecutionMetrics().stale_fence_rejected).toBeGreaterThanOrEqual(
      2,
    );

    const forbiddenFinalization = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "forbidden-finalization-1",
          "X-Kaneo-Lease-Token": takeoverRun.leaseToken ?? "",
          Authorization: takeoverAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: takeoverRun.leaseEpoch,
          state: "done",
          evidence: { tests: "pass" },
        }),
      },
    );
    // Canonical validation rejects the legacy "done" run state outright.
    expect(forbiddenFinalization.status).toBe(400);

    const reviewReport = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "review-report-1",
          "X-Kaneo-Lease-Token": takeoverRun.leaseToken ?? "",
          Authorization: takeoverAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: takeoverRun.leaseEpoch,
          state: "in_review",
          baseSha: "a".repeat(40),
          commitSha: "b".repeat(40),
          prNumber: 41,
          prUrl: "https://github.com/owner/repository/pull/41",
          prState: "open",
          evidence: { tests: "pass" },
        }),
      },
    );
    expect(reviewReport.status).toBe(200);
    const reviewReplay = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "review-report-1",
          "X-Kaneo-Lease-Token": takeoverRun.leaseToken ?? "",
          Authorization: takeoverAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: takeoverRun.leaseEpoch,
          state: "in_review",
          baseSha: "a".repeat(40),
          commitSha: "b".repeat(40),
          prNumber: 41,
          prUrl: "https://github.com/owner/repository/pull/41",
          prState: "open",
          evidence: { tests: "pass" },
        }),
      },
    );
    expect(reviewReplay.status).toBe(200);

    const selfReview = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "parent-review-self-1",
          "X-Kaneo-Agent-Principal": prodesk.id,
          Authorization: takeoverAuthorization,
        },
        body: JSON.stringify({
          decision: "approve",
          verification: {
            verificationProfile: "kaneo-api-test",
            baseSha: "a".repeat(40),
            commitSha: "b".repeat(40),
            changedFiles: ["apps/api/src/execution/service.ts"],
            commands: ["pnpm test"],
            diffWithinScope: true,
            branchValid: true,
            testsPassed: true,
          },
        }),
      },
    );
    expect(selfReview.status).toBe(403);

    const missingReviewEvidence = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "parent-review-missing-evidence-1",
          Authorization: "Bearer parent-review-token",
        },
        body: JSON.stringify({
          decision: "approve",
          verification: {
            verificationProfile: "kaneo-api-test",
            baseSha: "a".repeat(40),
            commitSha: "b".repeat(40),
            changedFiles: ["apps/api/src/execution/service.ts"],
            commands: ["pnpm test"],
            diffWithinScope: true,
            branchValid: true,
            testsPassed: false,
          },
        }),
      },
    );
    expect(missingReviewEvidence.status).toBe(409);

    const missingCommitEvidence = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "parent-review-missing-commit-1",
          Authorization: "Bearer parent-review-token",
        },
        body: JSON.stringify({
          decision: "approve",
          verification: {
            verificationProfile: "kaneo-api-test",
            baseSha: "a".repeat(40),
            commitSha: "c".repeat(40),
            changedFiles: ["apps/api/src/execution/service.ts"],
            commands: ["pnpm test"],
            diffWithinScope: true,
            branchValid: true,
            testsPassed: true,
          },
        }),
      },
    );
    expect(missingCommitEvidence.status).toBe(409);

    const scopeEscape = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "parent-review-scope-escape-1",
          Authorization: "Bearer parent-review-token",
        },
        body: JSON.stringify({
          decision: "approve",
          verification: {
            verificationProfile: "kaneo-api-test",
            baseSha: "a".repeat(40),
            commitSha: "b".repeat(40),
            changedFiles: ["README.md"],
            commands: ["pnpm test"],
            diffWithinScope: true,
            branchValid: true,
            testsPassed: true,
          },
        }),
      },
    );
    expect(scopeEscape.status).toBe(409);

    const parentReview = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "parent-review-approve-1",
          Authorization: "Bearer parent-review-token",
        },
        body: JSON.stringify({
          decision: "approve",
          action: "merge",
          reviewHeadSha: "b".repeat(40),
          verification: {
            verificationProfile: "kaneo-api-test",
            baseSha: "a".repeat(40),
            commitSha: "b".repeat(40),
            changedFiles: ["apps/api/src/execution/service.ts"],
            commands: ["pnpm test"],
            diffWithinScope: true,
            branchValid: true,
            testsPassed: true,
          },
          prResult: {
            status: "PASS",
            operation: "merge",
            prNumber: 41,
            prUrl: "https://github.com/owner/repository/pull/41",
            prState: "merged",
            mergeCommitSha: "c".repeat(40),
          },
        }),
      },
    );
    expect(parentReview.status).toBe(200);
    expect(await parentReview.json()).toMatchObject({
      id: takeoverRun.id,
      state: "finalized",
      leaseActive: false,
      blocker: null,
    });
    const finalizedTask = await db
      .select({ status: schema.taskTable.status })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(finalizedTask[0]?.status).toBe("done");

    const parentReviewReplay = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "parent-review-approve-1",
          Authorization: "Bearer parent-review-token",
        },
        body: JSON.stringify({
          decision: "approve",
          action: "merge",
          reviewHeadSha: "b".repeat(40),
          verification: {
            verificationProfile: "kaneo-api-test",
            baseSha: "a".repeat(40),
            commitSha: "b".repeat(40),
            changedFiles: ["apps/api/src/execution/service.ts"],
            commands: ["pnpm test"],
            diffWithinScope: true,
            branchValid: true,
            testsPassed: true,
          },
          prResult: {
            status: "PASS",
            operation: "merge",
            prNumber: 41,
            prUrl: "https://github.com/owner/repository/pull/41",
            prState: "merged",
            mergeCommitSha: "c".repeat(40),
          },
        }),
      },
    );
    expect(parentReviewReplay.status).toBe(200);
    expect(await parentReviewReplay.json()).toMatchObject({
      id: takeoverRun.id,
      state: "finalized",
    });

    const evidenceResponse = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/evidence`,
    );
    expect(evidenceResponse.status).toBe(200);
    expect(await evidenceResponse.json()).toEqual([
      expect.objectContaining({
        runId: takeoverRun.id,
        kind: "worker_report",
        payload: expect.objectContaining({ state: "in_review" }),
      }),
      expect.objectContaining({
        runId: takeoverRun.id,
        kind: "parent_review",
        payload: expect.objectContaining({ decision: "approve" }),
      }),
    ]);

    const listResponse = await app.request(
      `/api/execution/task/${task.id}/runs`,
    );
    expect(listResponse.status).toBe(200);
    const listedRuns = (await listResponse.json()) as Array<
      Record<string, unknown>
    >;
    expect(listedRuns).toHaveLength(2);
    expect(listedRuns.every((run) => !("leaseTokenHash" in run))).toBe(true);
  });

  it("blocks PR actions when the host credential/policy gate is unavailable", async () => {
    const { member, project, task } = await createTaskFixture();
    const worker = await createExecutionWorker(member.workspace.id);
    mockAuthenticatedSessions(member.user, {
      "worker-token": worker.user,
      "parent-review-token": member.user,
    });
    const workerAuthorization = "Bearer worker-token";
    const parentAuthorization = "Bearer parent-review-token";
    const { app } = createApp();

    const agentResponse = await app.request(
      `/api/execution/project/${project.id}/agents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({ runtimeId: "pi-laptop", hostId: "pi-laptop" }),
      },
    );
    expect(agentResponse.status).toBe(201);
    const agent = (await agentResponse.json()) as { id: string };
    const manifestResponse = await app.request(
      `/api/execution/project/${project.id}/manifest`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({
          baseBranch: "main",
          verificationProfile: "kaneo-api-test",
          allowedAgentIds: [agent.id],
          policy: {},
        }),
      },
    );
    expect(manifestResponse.status).toBe(200);

    const claimResponse = await app.request(
      `/api/execution/task/${task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "credential-block-claim-1",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({
          agentPrincipalId: agent.id,
          scope: ["apps/api/src"],
        }),
      },
    );
    expect(claimResponse.status).toBe(201);
    const claimed = (await claimResponse.json()) as RunResponse;

    const reportResponse = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "credential-block-report-1",
          "X-Kaneo-Lease-Token": claimed.leaseToken ?? "",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: claimed.leaseEpoch,
          state: "in_review",
          baseSha: "a".repeat(40),
          commitSha: "b".repeat(40),
        }),
      },
    );
    expect(reportResponse.status).toBe(200);

    const directFinalization = await app.request(
      `/api/task/status/${task.id}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({ status: "done" }),
      },
    );
    expect(directFinalization.status).toBe(409);

    const blocked = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "credential-block-review-1",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({
          decision: "approve",
          action: "create_pr",
          verification: {
            verificationProfile: "kaneo-api-test",
            baseSha: "a".repeat(40),
            commitSha: "b".repeat(40),
            changedFiles: ["apps/api/src/execution/service.ts"],
            commands: ["pnpm test"],
            diffWithinScope: true,
            branchValid: true,
            testsPassed: true,
          },
        }),
      },
    );
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({
      id: claimed.id,
      // Canonical states: a blocked PR gate keeps the worker-terminal run
      // in_review instead of the legacy "blocked" state.
      state: "in_review",
      blocker: "credential_blocked",
      leaseActive: false,
    });
    const unchangedTask = await db
      .select({ status: schema.taskTable.status })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(unchangedTask[0]?.status).toBe("in-review");
  });

  it("records a host-adapter PR, keeps the human merge gate open, then finalizes after merge evidence", async () => {
    const { member, project, task } = await createTaskFixture();
    const worker = await createExecutionWorker(member.workspace.id);
    mockAuthenticatedSessions(member.user, {
      "worker-token": worker.user,
      "parent-review-token": member.user,
    });
    const workerAuthorization = "Bearer worker-token";
    const parentAuthorization = "Bearer parent-review-token";
    const { app } = createApp();

    const agentResponse = await app.request(
      `/api/execution/project/${project.id}/agents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({ runtimeId: "pi-laptop", hostId: "pi-laptop" }),
      },
    );
    expect(agentResponse.status).toBe(201);
    const agent = (await agentResponse.json()) as { id: string };
    const manifestResponse = await app.request(
      `/api/execution/project/${project.id}/manifest`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({
          baseBranch: "main",
          verificationProfile: "kaneo-api-test",
          allowedAgentIds: [agent.id],
          policy: { allowPrCreate: true, allowMerge: true },
        }),
      },
    );
    expect(manifestResponse.status).toBe(200);

    const claimResponse = await app.request(
      `/api/execution/task/${task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "pr-adapter-claim-1",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({
          agentPrincipalId: agent.id,
          scope: ["apps/api/src"],
        }),
      },
    );
    expect(claimResponse.status).toBe(201);
    const claimed = (await claimResponse.json()) as RunResponse;
    const verification = {
      verificationProfile: "kaneo-api-test",
      baseSha: "a".repeat(40),
      commitSha: "b".repeat(40),
      changedFiles: ["apps/api/src/execution/service.ts"],
      commands: ["pnpm test"],
      diffWithinScope: true,
      branchValid: true,
      testsPassed: true,
    };
    const reportResponse = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "pr-adapter-report-1",
          "X-Kaneo-Lease-Token": claimed.leaseToken ?? "",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: claimed.leaseEpoch,
          state: "in_review",
          baseSha: verification.baseSha,
          commitSha: verification.commitSha,
        }),
      },
    );
    expect(reportResponse.status).toBe(200);

    const createPr = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "pr-adapter-create-1",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({
          decision: "approve",
          action: "create_pr",
          verification,
          prResult: {
            status: "PASS",
            operation: "create_pr",
            prNumber: 41,
            prUrl: "https://github.com/owner/repository/pull/41",
            prState: "open",
          },
        }),
      },
    );
    expect(createPr.status).toBe(200);
    const createdRun = await createPr.json();
    expect(createdRun).toMatchObject({
      id: claimed.id,
      state: "in_review",
      prNumber: 41,
      prState: "open",
      leaseActive: false,
    });
    const afterCreate = await db
      .select({ status: schema.taskTable.status })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(afterCreate[0]?.status).toBe("in-review");

    const mismatchedMerge = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "pr-adapter-merge-mismatch-1",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({
          decision: "approve",
          action: "merge",
          verification,
          reviewHeadSha: verification.commitSha,
          prResult: {
            status: "PASS",
            operation: "merge",
            prNumber: 42,
            prUrl: "https://github.com/owner/repository/pull/42",
            prState: "merged",
            mergeCommitSha: "c".repeat(40),
          },
        }),
      },
    );
    expect(mismatchedMerge.status).toBe(409);

    const mergePr = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "pr-adapter-merge-1",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({
          decision: "approve",
          action: "merge",
          verification,
          reviewHeadSha: verification.commitSha,
          prResult: {
            status: "PASS",
            operation: "merge",
            prNumber: 41,
            prUrl: "https://github.com/owner/repository/pull/41",
            prState: "merged",
            mergeCommitSha: "c".repeat(40),
          },
        }),
      },
    );
    expect(mergePr.status).toBe(200);
    expect(await mergePr.clone().json()).toMatchObject({
      id: claimed.id,
      state: "finalized",
      prNumber: 41,
      prState: "merged",
      leaseActive: false,
    });
    const afterMerge = await db
      .select({ status: schema.taskTable.status })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(afterMerge[0]?.status).toBe("done");
  });

  it("does not let a merged GitHub pull request bypass the parent execution gate", async () => {
    const { member, project, task } = await createTaskFixture();
    mockAuthenticatedSession(member.user);

    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "github",
        config: JSON.stringify({
          repositoryOwner: "owner",
          repositoryName: "repository",
          statusTransitions: { onPRMerge: "done" },
        }),
        isActive: true,
      })
      .returning();
    expect(integration).toBeTruthy();

    const [externalLink] = await db
      .insert(schema.externalLinkTable)
      .values({
        taskId: task.id,
        integrationId: integration.id,
        resourceType: "pull_request",
        externalId: "41",
        url: "https://github.com/owner/repository/pull/41",
        title: "Execution PR",
        metadata: JSON.stringify({ state: "open" }),
      })
      .returning();
    expect(externalLink).toBeTruthy();

    await db.insert(schema.taskRunTable).values({
      taskId: task.id,
      manifestVersion: 1,
      protocolVersion: 1,
      repositoryOwner: "owner",
      repositoryName: "repository",
      baseBranch: "main",
      state: "in_review",
      role: "worker",
      hostId: "pi-laptop",
      branchName: "pi-laptop/run-branch",
      scope: ["apps/api/src"],
      requestKey: "webhook-gate-run-1",
      requestHash: "webhook-gate-hash-1",
      leaseEpoch: 1,
      leaseTokenHash: "webhook-gate-token-1",
      leaseActive: false,
      leaseExpiresAt: new Date(0),
      lastHeartbeatAt: new Date(0),
    });

    await handlePullRequestClosed({
      action: "closed",
      pull_request: {
        number: 41,
        title: "Execution PR",
        html_url: "https://github.com/owner/repository/pull/41",
        state: "closed",
        merged: true,
        merged_at: "2026-08-12T00:00:00Z",
        head: { ref: "pi-laptop/run-branch" },
      },
      repository: {
        owner: { login: "owner" },
        name: "repository",
      },
    });

    const [unchangedTask] = await db
      .select({ status: schema.taskTable.status })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(unchangedTask?.status).toBe("to-do");

    const [closedLink] = await db
      .select({ metadata: schema.externalLinkTable.metadata })
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.id, externalLink.id));
    expect(JSON.parse(closedLink?.metadata ?? "{}")).toMatchObject({
      state: "closed",
      merged: true,
    });
  });

  it("blocks direct, bulk, and move finalization outside the parent review gate", async () => {
    const { member, project, task } = await createTaskFixture();
    const destination = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Execution Destination",
    });
    const worker = await createExecutionWorker(member.workspace.id);
    mockAuthenticatedSessions(member.user, {
      "worker-token": worker.user,
      "parent-review-token": member.user,
    });
    const workerAuthorization = "Bearer worker-token";
    const parentAuthorization = "Bearer parent-review-token";
    const { app } = createApp();

    const agentResponse = await app.request(
      `/api/execution/project/${project.id}/agents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({ runtimeId: "pi-laptop", hostId: "pi-laptop" }),
      },
    );
    expect(agentResponse.status).toBe(201);
    const agent = (await agentResponse.json()) as { id: string };

    const manifestResponse = await app.request(
      `/api/execution/project/${project.id}/manifest`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({
          baseBranch: "main",
          verificationProfile: "kaneo-api-test",
          allowedAgentIds: [agent.id],
        }),
      },
    );
    expect(manifestResponse.status).toBe(200);

    const claimResponse = await app.request(
      `/api/execution/task/${task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "finalization-route-claim-1",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({
          agentPrincipalId: agent.id,
          scope: ["apps/api/src"],
        }),
      },
    );
    expect(claimResponse.status).toBe(201);
    const claimed = (await claimResponse.json()) as RunResponse;

    const reportResponse = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "finalization-route-report-1",
          "X-Kaneo-Lease-Token": claimed.leaseToken ?? "",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: claimed.leaseEpoch,
          state: "failed",
          blocker: "verify_failed",
        }),
      },
    );
    expect(reportResponse.status).toBe(200);

    const [customFinalColumn] = await db
      .insert(schema.columnTable)
      .values({
        projectId: project.id,
        name: "Custom Final",
        slug: "custom-final",
        position: 4,
        isFinal: true,
      })
      .returning();
    expect(customFinalColumn).toBeTruthy();

    const directCustomFinalization = await app.request(
      `/api/task/status/${task.id}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({ status: "custom-final" }),
      },
    );
    expect(directCustomFinalization.status).toBe(409);

    const directFinalization = await app.request(`/api/task/${task.id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Authorization: parentAuthorization,
      },
      body: JSON.stringify({
        title: task.title,
        description: "Updated description must not finalize",
        status: "done",
        projectId: project.id,
        priority: task.priority ?? "medium",
        position: task.position ?? 1,
        userId: task.userId ?? member.user.id,
      }),
    });
    expect(directFinalization.status).toBe(409);

    const bulkFinalization = await app.request("/api/task/bulk", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Authorization: parentAuthorization,
      },
      body: JSON.stringify({
        taskIds: [task.id],
        operation: "updateStatus",
        value: "done",
      }),
    });
    expect(bulkFinalization.status).toBe(409);

    const moveFinalization = await app.request(`/api/task/move/${task.id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Authorization: parentAuthorization,
      },
      body: JSON.stringify({
        destinationProjectId: destination.project.id,
        destinationStatus: "done",
      }),
    });
    expect(moveFinalization.status).toBe(409);

    const [unchangedTask] = await db
      .select({
        projectId: schema.taskTable.projectId,
        status: schema.taskTable.status,
      })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(unchangedTask).toMatchObject({
      projectId: project.id,
      status: "to-do",
    });
  });

  it("rejects parent review from in_progress or blocked runs and requires a reason", async () => {
    const { member, project, task } = await createTaskFixture();
    const worker = await createExecutionWorker(member.workspace.id);
    mockAuthenticatedSessions(member.user, {
      "worker-token": worker.user,
      "parent-review-token": member.user,
    });
    const workerAuthorization = "Bearer worker-token";
    const parentAuthorization = "Bearer parent-review-token";
    const { app } = createApp();

    const agentResponse = await app.request(
      `/api/execution/project/${project.id}/agents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({ runtimeId: "pi-laptop", hostId: "pi-laptop" }),
      },
    );
    expect(agentResponse.status).toBe(201);
    const agent = (await agentResponse.json()) as { id: string };

    const manifestResponse = await app.request(
      `/api/execution/project/${project.id}/manifest`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({
          baseBranch: "main",
          verificationProfile: "kaneo-api-test",
          allowedAgentIds: [agent.id],
        }),
      },
    );
    expect(manifestResponse.status).toBe(200);

    const claimResponse = await app.request(
      `/api/execution/task/${task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "reject-matrix-claim-1",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({
          agentPrincipalId: agent.id,
          scope: ["apps/api/src"],
        }),
      },
    );
    expect(claimResponse.status).toBe(201);
    const claimed = (await claimResponse.json()) as RunResponse;

    const approveInProgress = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "reject-matrix-approve-in-progress-1",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(approveInProgress.status).toBe(400);

    const rejectWithoutReason = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "reject-matrix-reject-no-reason-1",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({ decision: "reject" }),
      },
    );
    expect(rejectWithoutReason.status).toBe(400);

    const reportResponse = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "reject-matrix-report-blocked-1",
          "X-Kaneo-Lease-Token": claimed.leaseToken ?? "",
          Authorization: workerAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: claimed.leaseEpoch,
          state: "failed",
          baseSha: "a".repeat(40),
          commitSha: "b".repeat(40),
          blocker: "verify_failed",
        }),
      },
    );
    expect(reportResponse.status).toBe(200);

    const approveBlocked = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "reject-matrix-approve-blocked-1",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(approveBlocked.status).toBe(400);

    const rejectBlocked = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "reject-matrix-reject-blocked-1",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({
          decision: "reject",
          reason: "Scope is wrong",
          reviewHeadSha: "b".repeat(40),
        }),
      },
    );
    expect(rejectBlocked.status).toBe(200);
    expect(await rejectBlocked.json()).toMatchObject({
      id: claimed.id,
      state: "rejected",
      leaseActive: false,
      blocker: null,
      nextAction: null,
    });

    const [persistedTask] = await db
      .select({ status: schema.taskTable.status })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(persistedTask?.status).toBe("to-do");

    const rejectReplay = await app.request(
      `/api/execution/task/${task.id}/runs/${claimed.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "reject-matrix-reject-blocked-1",
          Authorization: parentAuthorization,
        },
        body: JSON.stringify({
          decision: "reject",
          reason: "Scope is wrong",
          reviewHeadSha: "b".repeat(40),
        }),
      },
    );
    expect(rejectReplay.status).toBe(200);
    expect(await rejectReplay.json()).toMatchObject({
      id: claimed.id,
      state: "rejected",
    });
  });

  it("rejects review of an older in-review run after a newer run is claimed", async () => {
    const { member, project, task } = await createTaskFixture();
    const worker = await createExecutionWorker(member.workspace.id);
    const secondWorker = await createExecutionWorker(member.workspace.id);
    mockAuthenticatedSessions(member.user, {
      "worker-token": worker.user,
      "second-worker-token": secondWorker.user,
      "parent-review-token": member.user,
    });
    const { app } = createApp();

    const createAgent = async (authorization: string, runtimeId: string) => {
      const response = await app.request(
        `/api/execution/project/${project.id}/agents`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: authorization,
          },
          body: JSON.stringify({ runtimeId, hostId: runtimeId }),
        },
      );
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };

    const firstAgent = await createAgent("Bearer worker-token", "pi-laptop");
    const secondAgent = await createAgent(
      "Bearer second-worker-token",
      "pi-prodesk",
    );
    const manifestResponse = await app.request(
      `/api/execution/project/${project.id}/manifest`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-review-token",
        },
        body: JSON.stringify({
          baseBranch: "main",
          verificationProfile: "kaneo-api-test",
          allowedAgentIds: [firstAgent.id, secondAgent.id],
        }),
      },
    );
    expect(manifestResponse.status).toBe(200);

    const claim = (agentId: string, authorization: string, key: string) =>
      app.request(`/api/execution/task/${task.id}/runs/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: authorization,
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          agentPrincipalId: agentId,
          scope: ["apps/api/src"],
        }),
      });

    const firstClaim = await claim(
      firstAgent.id,
      "Bearer worker-token",
      "latest-run-claim-1",
    );
    expect(firstClaim.status).toBe(201);
    const firstRun = (await firstClaim.json()) as RunResponse;

    const firstReport = await app.request(
      `/api/execution/task/${task.id}/runs/${firstRun.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer worker-token",
          "Idempotency-Key": "latest-run-report-1",
          "X-Kaneo-Lease-Token": firstRun.leaseToken ?? "",
        },
        body: JSON.stringify({
          leaseEpoch: firstRun.leaseEpoch,
          state: "in_review",
          baseSha: "a".repeat(40),
          commitSha: "b".repeat(40),
        }),
      },
    );
    expect(firstReport.status).toBe(200);

    const secondClaim = await claim(
      secondAgent.id,
      "Bearer second-worker-token",
      "latest-run-claim-2",
    );
    expect(secondClaim.status).toBe(201);
    const secondRun = (await secondClaim.json()) as RunResponse;
    expect(secondRun.leaseEpoch).toBe(2);

    const review = await app.request(
      `/api/execution/task/${task.id}/runs/${firstRun.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-review-token",
          "Idempotency-Key": "latest-run-review-1",
        },
        body: JSON.stringify({
          decision: "approve",
          verification: {
            verificationProfile: "kaneo-api-test",
            baseSha: "a".repeat(40),
            commitSha: "b".repeat(40),
            changedFiles: ["apps/api/src/execution/service.ts"],
            commands: ["pnpm test"],
            diffWithinScope: true,
            branchValid: true,
            testsPassed: true,
          },
        }),
      },
    );
    expect(review.status).toBe(409);
    await expect(review.text()).resolves.toBe(
      "Only the latest task run can be reviewed",
    );

    const [unchangedTask] = await db
      .select({ status: schema.taskTable.status })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(unchangedTask?.status).toBe("in-review");

    const [persistedSecondRun] = await db
      .select({
        state: schema.taskRunTable.state,
        leaseActive: schema.taskRunTable.leaseActive,
      })
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, secondRun.id));
    expect(persistedSecondRun).toMatchObject({
      state: "in_progress",
      leaseActive: true,
    });
  });

  it("keeps execution principals owned by the user and active", async () => {
    const { member, project } = await createTaskFixture();
    const foreignMember = await createWorkspaceMember({
      userName: "Foreign Execution User",
    });
    const [foreignPrincipal] = await db
      .insert(schema.agentPrincipalTable)
      .values({
        userId: foreignMember.user.id,
        runtimeId: "pi-foreign",
        hostId: "foreign-host",
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const createAgentResponse = await app.request(
      `/api/execution/project/${project.id}/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runtimeId: "pi-active", hostId: "laptop" }),
      },
    );
    expect(createAgentResponse.status).toBe(201);
    const activePrincipal = (await createAgentResponse.json()) as {
      id: string;
    };

    const [inactivePrincipal] = await db
      .insert(schema.agentPrincipalTable)
      .values({
        userId: member.user.id,
        runtimeId: "pi-inactive",
        hostId: "old-laptop",
        isActive: false,
      })
      .returning();

    const rejectedManifest = await app.request(
      `/api/execution/project/${project.id}/manifest`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseBranch: "main",
          verificationProfile: "kaneo-api-test",
          allowedAgentIds: [foreignPrincipal.id],
        }),
      },
    );
    expect(rejectedManifest.status).toBe(400);

    const acceptedManifest = await app.request(
      `/api/execution/project/${project.id}/manifest`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseBranch: "main",
          verificationProfile: "kaneo-api-test",
          allowedAgentIds: [activePrincipal.id],
        }),
      },
    );
    expect(acceptedManifest.status).toBe(200);

    const globalAgents = await app.request("/api/execution/agents");
    expect(globalAgents.status).toBe(200);
    expect(
      ((await globalAgents.json()) as Array<{ id: string }>).map(
        (agent) => agent.id,
      ),
    ).toEqual([activePrincipal.id]);

    const projectAgents = await app.request(
      `/api/execution/project/${project.id}/agents`,
    );
    expect(projectAgents.status).toBe(200);
    expect(
      ((await projectAgents.json()) as Array<{ id: string }>).map(
        (agent) => agent.id,
      ),
    ).toEqual([activePrincipal.id]);
    expect(inactivePrincipal.isActive).toBe(false);
  });
});
