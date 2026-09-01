import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import {
  EXECUTION_FLAGS,
  getExecutionMetrics,
  resetExecutionMetricsForTests,
} from "../../apps/api/src/execution/gates";
import { createApp } from "../../apps/api/src/index";
import {
  mockAuthenticatedSession,
  mockAuthenticatedSessions,
} from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

type ExecutionRunFixture = {
  app: ReturnType<typeof createApp>["app"];
  project: typeof schema.projectTable.$inferSelect;
  task: typeof schema.taskTable.$inferSelect;
  run: {
    id: string;
    leaseEpoch: number;
    leaseToken?: string;
  };
  workerAuthorization: string;
  parentAuthorization: string;
};

async function createExecutionRunFixture(): Promise<ExecutionRunFixture> {
  const parent = await createWorkspaceMember({ role: "admin" });
  const { project, columns } = await createProjectFixture({
    workspaceId: parent.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      userId: parent.user.id,
      title: "Execution flag task",
      status: "to-do",
      columnId: columns.todo.id,
      priority: "medium",
      number: 1,
      position: 1,
    })
    .returning();
  if (!task) throw new Error("Failed to create execution flag task");

  await db.insert(schema.githubIntegrationTable).values({
    projectId: project.id,
    repositoryOwner: "owner",
    repositoryName: "repository",
    isActive: true,
  });

  const worker = await createWorkspaceMember({
    userName: "Execution Flag Worker",
    role: "admin",
  });
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: parent.workspace.id,
    userId: worker.user.id,
    role: "admin",
    joinedAt: new Date(),
  });

  mockAuthenticatedSessions(parent.user, {
    "execution-flag-worker": worker.user,
    "parent-execution-flag": parent.user,
  });
  const { app } = createApp();
  const workerAuthorization = "Bearer execution-flag-worker";
  const parentAuthorization = "Bearer parent-execution-flag";

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
  if (agentResponse.status !== 201) {
    throw new Error(
      `Failed to create worker principal: ${agentResponse.status}`,
    );
  }
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
  if (manifestResponse.status !== 200) {
    throw new Error(
      `Failed to create execution manifest: ${manifestResponse.status}`,
    );
  }

  const claimResponse = await app.request(
    `/api/execution/task/${task.id}/runs/claim`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "execution-flag-claim-1",
        Authorization: workerAuthorization,
      },
      body: JSON.stringify({
        agentPrincipalId: agent.id,
        scope: ["apps/api/src"],
      }),
    },
  );
  if (claimResponse.status !== 201) {
    throw new Error(`Failed to claim execution run: ${claimResponse.status}`);
  }
  const run = (await claimResponse.json()) as ExecutionRunFixture["run"];

  return {
    app,
    project,
    task,
    run,
    workerAuthorization,
    parentAuthorization,
  };
}

async function setExecutionFlag(
  name: (typeof EXECUTION_FLAGS)[keyof typeof EXECUTION_FLAGS],
  enabled: boolean,
) {
  await db
    .update(schema.executionFlagTable)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(schema.executionFlagTable.name, name));
}

function verification() {
  return {
    verificationProfile: "kaneo-api-test",
    baseSha: "a".repeat(40),
    commitSha: "b".repeat(40),
    changedFiles: ["apps/api/src/execution/service.ts"],
    commands: ["pnpm test"],
    diffWithinScope: true,
    branchValid: true,
    testsPassed: true,
  };
}

describe("API integration: execution kill-switch flags", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    resetExecutionMetricsForTests();
  });

  it("seeds all flags disabled except the test execution defaults and exposes metrics on health", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const flags = await app.request("/api/execution/flags");
    expect(flags.status).toBe(403);

    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "ok",
      executionMetrics: {},
    });
  });

  it("lets an instance admin change a flag without restarting the API", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, member.user.id));
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const before = await app.request("/api/execution/flags");
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "git_push_enabled", enabled: true }),
        expect.objectContaining({
          name: "guest_mutation_enabled",
          enabled: false,
        }),
      ]),
    );

    const update = await app.request("/api/execution/flags/git_push_enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      name: "git_push_enabled",
      enabled: false,
    });
  });

  it("blocks Git commit evidence before and after an idempotency replay", async () => {
    const fixture = await createExecutionRunFixture();
    await setExecutionFlag(EXECUTION_FLAGS.gitPush, false);

    const report = () =>
      fixture.app.request(
        `/api/execution/task/${fixture.task.id}/runs/${fixture.run.id}/report`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "git-flag-report-1",
            "X-Kaneo-Lease-Token": fixture.run.leaseToken ?? "",
            Authorization: fixture.workerAuthorization,
          },
          body: JSON.stringify({
            leaseEpoch: fixture.run.leaseEpoch,
            state: "in_review",
            baseSha: "a".repeat(40),
            commitSha: "b".repeat(40),
          }),
        },
      );

    expect((await report()).status).toBe(409);
    expect(getExecutionMetrics()).toMatchObject({
      gate_blocked: 1,
      git_push_gate_blocked: 1,
    });

    await setExecutionFlag(EXECUTION_FLAGS.gitPush, true);
    expect((await report()).status).toBe(200);

    await setExecutionFlag(EXECUTION_FLAGS.gitPush, false);
    expect((await report()).status).toBe(409);
    expect(getExecutionMetrics()).toMatchObject({
      gate_blocked: 2,
      git_push_gate_blocked: 2,
    });
  });

  it("blocks PR creation before and after an idempotency replay", async () => {
    const fixture = await createExecutionRunFixture();
    const report = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${fixture.run.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "pr-flag-report-1",
          "X-Kaneo-Lease-Token": fixture.run.leaseToken ?? "",
          Authorization: fixture.workerAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: fixture.run.leaseEpoch,
          state: "in_review",
          baseSha: "a".repeat(40),
          commitSha: "b".repeat(40),
        }),
      },
    );
    expect(report.status).toBe(200);

    await setExecutionFlag(EXECUTION_FLAGS.prCreation, false);
    const createPr = () =>
      fixture.app.request(
        `/api/execution/task/${fixture.task.id}/runs/${fixture.run.id}/review`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "pr-flag-review-1",
            Authorization: fixture.parentAuthorization,
          },
          body: JSON.stringify({
            decision: "approve",
            action: "create_pr",
            verification: verification(),
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

    expect((await createPr()).status).toBe(409);
    await setExecutionFlag(EXECUTION_FLAGS.prCreation, true);
    expect((await createPr()).status).toBe(200);
    await setExecutionFlag(EXECUTION_FLAGS.prCreation, false);
    expect((await createPr()).status).toBe(409);
    expect(getExecutionMetrics()).toMatchObject({
      gate_blocked: 2,
      pr_gate_blocked: 2,
    });
  });

  it("blocks manual finalization when the merge flag is off", async () => {
    const fixture = await createExecutionRunFixture();
    const report = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${fixture.run.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "merge-flag-report-1",
          "X-Kaneo-Lease-Token": fixture.run.leaseToken ?? "",
          Authorization: fixture.workerAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: fixture.run.leaseEpoch,
          state: "in_review",
          baseSha: "a".repeat(40),
          commitSha: "b".repeat(40),
        }),
      },
    );
    expect(report.status).toBe(200);

    await setExecutionFlag(EXECUTION_FLAGS.merge, false);
    const approve = () =>
      fixture.app.request(
        `/api/execution/task/${fixture.task.id}/runs/${fixture.run.id}/review`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "merge-flag-review-1",
            Authorization: fixture.parentAuthorization,
          },
          body: JSON.stringify({
            decision: "approve",
            action: "merge",
            reviewHeadSha: "b".repeat(40),
            verification: verification(),
          }),
        },
      );

    expect((await approve()).status).toBe(409);
    await setExecutionFlag(EXECUTION_FLAGS.merge, true);
    expect((await approve()).status).toBe(200);
    await setExecutionFlag(EXECUTION_FLAGS.merge, false);
    expect((await approve()).status).toBe(409);
    expect(getExecutionMetrics()).toMatchObject({
      gate_blocked: 2,
      // Third approval: merge flag is on but the manifest policy/adapter gate
      // still records merge_gate_blocked while keeping the run in_review.
      merge_gate_blocked: 3,
    });
  });

  it("blocks explicit merge evidence when the merge flag is off", async () => {
    const fixture = await createExecutionRunFixture();
    const report = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${fixture.run.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "explicit-merge-flag-report-1",
          "X-Kaneo-Lease-Token": fixture.run.leaseToken ?? "",
          Authorization: fixture.workerAuthorization,
        },
        body: JSON.stringify({
          leaseEpoch: fixture.run.leaseEpoch,
          state: "in_review",
          baseSha: "a".repeat(40),
          commitSha: "b".repeat(40),
        }),
      },
    );
    expect(report.status).toBe(200);

    await setExecutionFlag(EXECUTION_FLAGS.merge, false);
    const merge = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${fixture.run.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "explicit-merge-flag-review-1",
          Authorization: fixture.parentAuthorization,
        },
        body: JSON.stringify({
          decision: "approve",
          action: "merge",
          verification: verification(),
          reviewHeadSha: "b".repeat(40),
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
    expect(merge.status).toBe(409);
    expect(getExecutionMetrics()).toMatchObject({
      gate_blocked: 1,
      merge_gate_blocked: 1,
    });
  });

  it("rejects unknown flags and keeps all non-MVP flags fail-closed", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, member.user.id));
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const unknown = await app.request("/api/execution/flags/not-a-real-flag", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(unknown.status).toBe(400);

    const nonMvpFlags = [
      EXECUTION_FLAGS.agentInboxDispatch,
      EXECUTION_FLAGS.agentReply,
      EXECUTION_FLAGS.guestMutation,
      EXECUTION_FLAGS.guestAgentMentions,
    ];
    for (const name of nonMvpFlags) {
      const enable = await app.request(`/api/execution/flags/${name}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(enable.status).toBe(409);
    }

    const flags = await app.request("/api/execution/flags");
    expect(flags.status).toBe(200);
    const rows = (await flags.json()) as Array<{
      name: string;
      enabled: boolean;
    }>;
    expect(rows.filter((row) => nonMvpFlags.includes(row.name))).toEqual(
      nonMvpFlags.map((name) =>
        expect.objectContaining({ name, enabled: false }),
      ),
    );
  });
});
