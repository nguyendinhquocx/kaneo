import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
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

describe("API integration: execution Task 1", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("serializes manifest, allows one concurrent claim, and fences stale takeover", async () => {
    const { member, project, task } = await createTaskFixture();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const createAgent = async (runtimeId: string) => {
      const response = await app.request(
        `/api/execution/project/${project.id}/agents`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runtimeId, hostId: `${runtimeId}-host` }),
        },
      );
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };

    const laptop = await createAgent("pi-laptop");
    const prodesk = await createAgent("pi-prodesk");

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
          policy: { merge: "parent" },
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

    const claim = (agentPrincipalId: string, requestKey: string) =>
      app.request(`/api/execution/task/${task.id}/runs/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": requestKey,
        },
        body: JSON.stringify({
          agentPrincipalId,
          scope: ["apps/api/src", "tests/api"],
        }),
      });

    const [firstResponse, secondResponse] = await Promise.all([
      claim(laptop.id, "claim-laptop-1"),
      claim(prodesk.id, "claim-prodesk-1"),
    ]);
    const successful = [firstResponse, secondResponse].filter(
      (response) => response.status === 201,
    );
    const conflicts = [firstResponse, secondResponse].filter(
      (response) => response.status === 409,
    );
    expect(successful).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

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
    const takeoverResponse = await claim(takeoverAgentId, "claim-takeover-1");
    expect(takeoverResponse.status).toBe(201);
    const takeoverRun = (await takeoverResponse.json()) as RunResponse;
    expect(takeoverRun.leaseEpoch).toBe(2);
    expect(takeoverRun.id).not.toBe(firstRun.id);

    const heartbeatPath = `/api/execution/task/${task.id}/runs/${takeoverRun.id}/heartbeat`;
    const heartbeatRequest = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "takeover-heartbeat-1",
        "X-Kaneo-Lease-Token": takeoverRun.leaseToken ?? "",
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
        },
        body: JSON.stringify({ leaseEpoch: firstRun.leaseEpoch }),
      },
    );
    expect(staleHeartbeat.status).toBe(409);

    const forbiddenFinalization = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "forbidden-finalization-1",
          "X-Kaneo-Lease-Token": takeoverRun.leaseToken ?? "",
        },
        body: JSON.stringify({
          leaseEpoch: takeoverRun.leaseEpoch,
          state: "done",
          evidence: { tests: "pass" },
        }),
      },
    );
    expect(forbiddenFinalization.status).toBe(403);

    const reviewReport = await app.request(
      `/api/execution/task/${task.id}/runs/${takeoverRun.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "review-report-1",
          "X-Kaneo-Lease-Token": takeoverRun.leaseToken ?? "",
        },
        body: JSON.stringify({
          leaseEpoch: takeoverRun.leaseEpoch,
          state: "in_review",
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
        },
        body: JSON.stringify({
          leaseEpoch: takeoverRun.leaseEpoch,
          state: "in_review",
          evidence: { tests: "pass" },
        }),
      },
    );
    expect(reviewReplay.status).toBe(200);

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
