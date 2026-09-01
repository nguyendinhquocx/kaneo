import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { stableHash } from "../../apps/api/src/execution/validation";
import { createApp } from "../../apps/api/src/index";
import { handleExecutionRunUpdated } from "../../apps/api/src/plugins/telegram/events";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const WORKER_SCOPES = [
  "agent:read",
  "agent:comment",
  "run:claim",
  "run:heartbeat",
  "run:report",
];

async function createScheduleFixture(options?: {
  taskStatus?: string;
  hostId?: string;
  preferredModel?: string | null;
  allowedModels?: string[];
}) {
  const member = await createWorkspaceMember({ role: "admin" });
  await db
    .update(schema.userTable)
    .set({ role: "admin" })
    .where(eq(schema.userTable.id, member.user.id));

  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      userId: member.user.id,
      title: "Scheduled execution task",
      description: JSON.stringify({
        files: ["apps/api/src/execution/service.ts"],
        laptop_only: false,
      }),
      status: options?.taskStatus ?? "ready",
      columnId: columns.todo.id,
      priority: "medium",
      number: 1,
      position: 1,
    })
    .returning();
  if (!task) throw new Error("Failed to create schedule task");

  await db.insert(schema.githubIntegrationTable).values({
    projectId: project.id,
    repositoryOwner: "owner",
    repositoryName: "repository",
    isActive: true,
  });

  const [principal] = await db
    .insert(schema.agentPrincipalTable)
    .values({
      userId: member.user.id,
      runtimeId: "pi-prodesk",
      hostId: options?.hostId ?? "prodesk-home",
      scopes: WORKER_SCOPES,
    })
    .returning();
  if (!principal) throw new Error("Failed to create schedule principal");

  await db.insert(schema.executionManifestTable).values({
    projectId: project.id,
    repositoryOwner: "owner",
    repositoryName: "repository",
    baseBranch: "main",
    verificationProfile: "kaneo-api-test",
    allowedAgentIds: [principal.id],
    policy: options?.allowedModels
      ? { allowedModels: options.allowedModels }
      : {},
  });

  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  return { app, member, project, task, principal };
}

async function createSchedule(
  app: ReturnType<typeof createApp>["app"],
  taskId: string,
  body?: Record<string, unknown>,
  requestKey = "schedule-fixture-1",
) {
  return app.request(`/api/execution/task/${taskId}/schedules`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": requestKey,
    },
    body: JSON.stringify({
      notBefore: new Date(Date.now() - 1_000).toISOString(),
      maxRuntimeSeconds: 3600,
      ...body,
    }),
  });
}

describe("API integration: execution schedules (T6)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("creates one durable schedule and one occurrence/run across retries", async () => {
    const fixture = await createScheduleFixture();
    const notBefore = new Date(Date.now() - 1_000).toISOString();
    const first = await createSchedule(fixture.app, fixture.task.id, {
      notBefore,
      retryPolicy: { maxAttempts: 2, backoffSeconds: 15 },
    });
    expect(first.status).toBe(201);
    const scheduleId = ((await first.json()) as { id: string }).id;

    const replay = await createSchedule(fixture.app, fixture.task.id, {
      notBefore,
      retryPolicy: { maxAttempts: 2, backoffSeconds: 15 },
    });
    expect(replay.status).toBe(201);
    expect((await replay.json()).id).toBe(scheduleId);

    const dueBefore = await fixture.app.request(
      "/api/execution/schedules/due?host=prodesk-home",
    );
    expect(dueBefore.status).toBe(200);
    expect(await dueBefore.json()).toEqual([
      expect.not.objectContaining({ requestKey: expect.anything() }),
    ]);

    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(200);
    const dispatchBody = (await dispatch.json()) as {
      outcome: string;
      ackToken?: string;
      runnerSupervisorFence?: string;
    };
    expect(dispatchBody).toMatchObject({ outcome: "dispatched" });
    expect(dispatchBody.ackToken).toEqual(expect.any(String));
    expect(dispatchBody.runnerSupervisorFence).toEqual(expect.any(String));

    const retry = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as {
      outcome: string;
      ackToken?: string;
      runnerSupervisorFence?: string;
    };
    expect(retryBody).toMatchObject({
      outcome: "reconciled_existing_run",
    });
    expect(retryBody.ackToken).toEqual(expect.any(String));
    expect(retryBody.runnerSupervisorFence).toEqual(expect.any(String));

    const [occurrence] = await db
      .select()
      .from(schema.executionScheduleOccurrenceTable);
    const runs = await db.select().from(schema.taskRunTable);
    expect(occurrence).toMatchObject({
      scheduleId,
      state: "dispatched",
      runId: runs[0]?.id,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.scheduleId).toBe(scheduleId);
    expect(runs[0]?.attempt).toBe(1);
    expect(runs[0]?.maxAttempts).toBe(2);

    // Dispatch syncs the Kanban card and emits exactly one "started"
    // notification (worker-received acknowledgment for Telegram).
    const [taskAfterDispatch] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, fixture.task.id));
    expect(taskAfterDispatch?.status).toBe("in-progress");
    const notificationEvents = await db
      .select()
      .from(schema.executionNotificationEventTable);
    expect(notificationEvents).toHaveLength(1);
    expect(notificationEvents[0]).toMatchObject({
      taskId: fixture.task.id,
      runId: runs[0]?.id,
      kind: "started",
    });

    const workerAdoption = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "worker-adoption-after-dispatch",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          scope: ["apps/api/src/execution/service.ts"],
        }),
      },
    );
    expect(workerAdoption.status).toBe(201);
    expect((await workerAdoption.json()).id).toBe(runs[0]?.id);

    await db
      .update(schema.taskRunTable)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.taskRunTable.id, runs[0]?.id ?? ""));
    const recovered = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(recovered.status).toBe(200);
    const recoveredBody = (await recovered.json()) as {
      outcome: string;
      runId?: string;
      ackToken?: string;
      runnerSupervisorFence?: string;
    };
    expect(recoveredBody).toMatchObject({
      outcome: "reconciled_existing_run",
      runId: runs[0]?.id,
    });
    expect(recoveredBody.ackToken).toEqual(expect.any(String));
    expect(recoveredBody.runnerSupervisorFence).toEqual(expect.any(String));
    expect(await db.select().from(schema.taskRunTable)).toHaveLength(1);

    const invalidAck = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/ack`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          occurrenceId: occurrence?.id,
          runId: runs[0]?.id,
          agentPrincipalId: fixture.principal.id,
          ackToken: "wrong-token",
        }),
      },
    );
    expect(invalidAck.status).toBe(401);

    const ack = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/ack`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          occurrenceId: occurrence?.id,
          runId: runs[0]?.id,
          agentPrincipalId: fixture.principal.id,
          ackToken: recoveredBody.ackToken,
        }),
      },
    );
    expect(ack.status).toBe(200);
    const due = await fixture.app.request(
      "/api/execution/schedules/due?host=prodesk-home",
    );
    expect(due.status).toBe(200);
    expect(await due.json()).toEqual([]);
  });

  it("accepts a supervisor report addressed with the principal row ID", async () => {
    const fixture = await createScheduleFixture();
    const created = await createSchedule(fixture.app, fixture.task.id);
    expect(created.status).toBe(201);
    const scheduleId = ((await created.json()) as { id: string }).id;
    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(200);
    const [occurrence] = await db
      .select()
      .from(schema.executionScheduleOccurrenceTable)
      .where(
        eq(schema.executionScheduleOccurrenceTable.scheduleId, scheduleId),
      );
    const [run] = await db
      .select()
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.scheduleId, scheduleId));
    if (!occurrence || !run) throw new Error("scheduled run fixture missing");

    // The real dispatcher keeps the raw fence in its local handoff file. The
    // test swaps only the stored hash so it can exercise the HTTP contract
    // without exposing a production fence in test code.
    const supervisorFence = "fixture-supervisor-fence";
    await db
      .update(schema.executionScheduleOccurrenceTable)
      .set({ supervisorFenceHash: stableHash(supervisorFence) })
      .where(eq(schema.executionScheduleOccurrenceTable.id, occurrence.id));

    const report = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${run.id}/supervisor-report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "supervisor-report-principal-row-id",
          "X-Kaneo-Supervisor-Fence": supervisorFence,
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          occurrenceId: occurrence.id,
          expectedRunRevision: run.runRevision,
          workerTerminalReceipt: {
            schemaVersion: "1",
            taskId: fixture.task.id,
            runId: run.id,
            stopReason: "process_exit",
            finalState: "failed",
            failureKind: "worker_crash",
          },
        }),
      },
    );
    expect(report.status).toBe(200);
    expect((await report.json()) as { state: string }).toMatchObject({
      state: "failed",
    });
  });

  it("refuses to override an in_review run from the supervisor sweep", async () => {
    // Regression (ProDesk run tszq17): the worker reported in_review with a
    // guarded commit, then the dispatcher crash sweep classified exit 0 as
    // failed/test_failure and clobbered the worker report. The supervisor
    // report must never override a worker-terminal or fully-terminal run.
    const fixture = await createScheduleFixture();
    const created = await createSchedule(fixture.app, fixture.task.id);
    expect(created.status).toBe(201);
    const scheduleId = ((await created.json()) as { id: string }).id;
    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(200);
    const [occurrence] = await db
      .select()
      .from(schema.executionScheduleOccurrenceTable)
      .where(
        eq(schema.executionScheduleOccurrenceTable.scheduleId, scheduleId),
      );
    const [run] = await db
      .select()
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.scheduleId, scheduleId));
    if (!occurrence || !run) throw new Error("scheduled run fixture missing");

    // Simulate the worker having reported in_review (worker-terminal).
    await db
      .update(schema.taskRunTable)
      .set({ state: "in_review", runRevision: run.runRevision + 1 })
      .where(eq(schema.taskRunTable.id, run.id));

    const supervisorFence = "fixture-supervisor-fence-in-review";
    await db
      .update(schema.executionScheduleOccurrenceTable)
      .set({ supervisorFenceHash: stableHash(supervisorFence) })
      .where(eq(schema.executionScheduleOccurrenceTable.id, occurrence.id));

    const report = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${run.id}/supervisor-report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "supervisor-report-in-review-guard",
          "X-Kaneo-Supervisor-Fence": supervisorFence,
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          occurrenceId: occurrence.id,
          workerTerminalReceipt: {
            schemaVersion: "1",
            taskId: fixture.task.id,
            runId: run.id,
            stopReason: "process_exit",
            finalState: "failed",
            failureKind: "test_failure",
          },
        }),
      },
    );
    expect(report.status).toBe(409);
    const [after] = await db
      .select()
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, run.id));
    expect(after?.state).toBe("in_review");
  });

  it("does not let a normal claim adopt an unscheduled active run", async () => {
    const fixture = await createScheduleFixture();
    const scope = ["apps/api/src/execution/service.ts"];
    const firstClaim = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "manual-active-run-1",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          scope,
        }),
      },
    );
    expect(firstClaim.status).toBe(201);

    const secondClaim = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "manual-active-run-2",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          scope,
        }),
      },
    );
    expect(secondClaim.status).toBe(409);
    expect(await db.select().from(schema.taskRunTable)).toHaveLength(1);
  });

  it("lets concurrent dispatchers share one occurrence and one run", async () => {
    const fixture = await createScheduleFixture();
    const created = await createSchedule(fixture.app, fixture.task.id);
    const scheduleId = ((await created.json()) as { id: string }).id;
    const dispatch = () =>
      fixture.app.request(`/api/execution/schedules/${scheduleId}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      });

    const responses = await Promise.all([dispatch(), dispatch()]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const outcomes = await Promise.all(
      responses.map(
        (response) => response.json() as Promise<{ outcome: string }>,
      ),
    );
    const outcomeValues = outcomes.map((result) => result.outcome);
    expect(
      outcomeValues.filter((outcome) => outcome === "dispatched"),
    ).toHaveLength(1);
    expect(
      outcomeValues.every((outcome) =>
        [
          "dispatched",
          "reconciled_existing_run",
          "already_dispatched",
        ].includes(outcome),
      ),
    ).toBe(true);
    expect(
      await db.select().from(schema.executionScheduleOccurrenceTable),
    ).toHaveLength(1);
    expect(await db.select().from(schema.taskRunTable)).toHaveLength(1);
  });

  it("does not create a second lease when manual claim races the dispatcher", async () => {
    const fixture = await createScheduleFixture();
    const created = await createSchedule(fixture.app, fixture.task.id);
    const scheduleId = ((await created.json()) as { id: string }).id;
    const scope = ["apps/api/src/execution/service.ts"];
    const dispatch = fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, agentPrincipalId: fixture.principal.id }),
      },
    );
    const manualClaim = fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "manual-race-claim-1",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          scope,
        }),
      },
    );

    const [dispatchResponse, claimResponse] = await Promise.all([
      dispatch,
      manualClaim,
    ]);
    expect(dispatchResponse.status).toBe(200);
    expect([201, 409]).toContain(claimResponse.status);
    expect(await db.select().from(schema.taskRunTable)).toHaveLength(1);
  });

  it("serializes different schedules sharing one concurrency key", async () => {
    const fixture = await createScheduleFixture();
    const [secondTask] = await db
      .insert(schema.taskTable)
      .values({
        projectId: fixture.project.id,
        userId: fixture.member.user.id,
        title: "Second scheduled execution task",
        description: JSON.stringify({
          files: ["apps/api/src/execution/service.ts"],
          laptop_only: false,
        }),
        status: "ready",
        columnId: (
          await db
            .select({ id: schema.columnTable.id })
            .from(schema.columnTable)
            .where(eq(schema.columnTable.projectId, fixture.project.id))
            .limit(1)
        )[0]?.id,
        priority: "medium",
        number: 2,
        position: 2,
      })
      .returning();
    if (!secondTask) throw new Error("Failed to create second schedule task");

    const firstSchedule = await createSchedule(fixture.app, fixture.task.id);
    const firstScheduleId = ((await firstSchedule.json()) as { id: string }).id;
    const secondSchedule = await createSchedule(
      fixture.app,
      secondTask.id,
      {},
      "schedule-fixture-2",
    );
    const secondScheduleId = ((await secondSchedule.json()) as { id: string })
      .id;
    const dispatch = (scheduleId: string) =>
      fixture.app.request(`/api/execution/schedules/${scheduleId}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      });

    const responses = await Promise.all([
      dispatch(firstScheduleId),
      dispatch(secondScheduleId),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const outcomes = await Promise.all(
      responses.map(
        (response) => response.json() as Promise<{ outcome: string }>,
      ),
    );
    expect(
      outcomes.filter((result) => result.outcome === "dispatched"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.outcome === "no_op"),
    ).toHaveLength(1);
    expect(await db.select().from(schema.taskRunTable)).toHaveLength(1);
  });

  it("retries transient lease conflicts with a bounded backoff", async () => {
    // SPEC v0.1 dependencyPolicy=reject: requires_no_active_run rejects the
    // FIRST dispatch while another run holds the lease — no occurrence, and
    // the schedule is disabled with the gate reason instead of retrying.
    const fixture = await createScheduleFixture();
    const scope = ["apps/api/src/execution/service.ts"];
    const manualScope = ["apps/api/src/execution/validation.ts"];
    const manualClaim = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "retry-policy-manual-run",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          scope: manualScope,
        }),
      },
    );
    expect(manualClaim.status).toBe(201);

    const created = await createSchedule(fixture.app, fixture.task.id, {
      retryPolicy: { maxAttempts: 2, backoffSeconds: 15 },
    });
    const scheduleId = ((await created.json()) as { id: string }).id;

    const firstDispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope,
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(firstDispatch.status).toBe(200);
    expect(await firstDispatch.json()).toMatchObject({
      outcome: "no_op",
      reason: expect.stringContaining("dependency_gate_failed"),
    });

    const [afterFirst] = await db
      .select()
      .from(schema.executionScheduleTable)
      .where(eq(schema.executionScheduleTable.id, scheduleId));
    // Gate failure creates no occurrence and disables the schedule with the
    // typed reason so the parent can fix the dependency and re-schedule.
    expect(
      await db.select().from(schema.executionScheduleOccurrenceTable),
    ).toEqual([]);
    expect(afterFirst?.enabled).toBe(false);
    expect(afterFirst?.disableReason).toContain("requires_no_active_run");
    expect(
      await fixture.app
        .request("/api/execution/schedules/due?host=prodesk-home")
        .then((response) => response.json()),
    ).toEqual([]);

    await db
      .update(schema.executionScheduleTable)
      .set({ nextDispatchAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.executionScheduleTable.id, scheduleId));
    const secondDispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope,
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(secondDispatch.status).toBe(409);
    const [afterSecond] = await db
      .select()
      .from(schema.executionScheduleTable)
      .where(eq(schema.executionScheduleTable.id, scheduleId));
    expect(afterSecond?.enabled).toBe(false);
  });

  it("retires a dispatched occurrence when its run is missing", async () => {
    const fixture = await createScheduleFixture();
    const created = await createSchedule(fixture.app, fixture.task.id);
    const scheduleId = ((await created.json()) as { id: string }).id;
    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    const dispatchBody = (await dispatch.json()) as { runId?: string };
    expect(dispatchBody.runId).toEqual(expect.any(String));

    await db
      .delete(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, dispatchBody.runId ?? ""));
    const retry = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ outcome: "no_op" });
    const [occurrence] = await db
      .select()
      .from(schema.executionScheduleOccurrenceTable);
    const [schedule] = await db
      .select()
      .from(schema.executionScheduleTable)
      .where(eq(schema.executionScheduleTable.id, scheduleId));
    expect(occurrence?.state).toBe("failed");
    expect(schedule?.enabled).toBe(false);
  });

  it("reports provider quota as a released blocked run and resumes its branch", async () => {
    const fixture = await createScheduleFixture();
    const claim = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "t7-quota-run",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          scope: ["apps/api/src/execution/service.ts"],
        }),
      },
    );
    const claimed = (await claim.json()) as {
      id: string;
      leaseEpoch: number;
      leaseToken: string;
      branchName: string;
    };
    const report = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${claimed.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "t7-quota-report",
          "X-Kaneo-Lease-Token": claimed.leaseToken,
        },
        body: JSON.stringify({
          leaseEpoch: claimed.leaseEpoch,
          state: "blocked_quota",
          baseSha: "1111111111111111111111111111111111111111",
          commitSha: "2222222222222222222222222222222222222222",
          evidence: {
            failureKind: "provider_quota",
            modelFailed: "openai-codex/gpt-5.6-luna",
            retryAfter: "2026-08-25T04:00:00.000Z",
          },
          blocker: "provider quota exhausted",
          nextAction: "Parent chooses a model and resume time",
        }),
      },
    );
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({
      state: "blocked_quota",
      leaseActive: false,
      branchName: claimed.branchName,
      commitSha: "2222222222222222222222222222222222222222",
    });

    const resume = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${claimed.id}/resume`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "t7-quota-resume",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          preferredModel: "zai/glm-5.3",
        }),
      },
    );
    expect(resume.status).toBe(201);
    const resumed = (await resume.json()) as {
      id: string;
      branchName: string;
      baseSha: string;
      commitSha: string;
      evidence: Record<string, unknown>;
    };
    expect(resumed.id).not.toBe(claimed.id);
    expect(resumed.branchName).not.toBe(claimed.branchName);
    expect(resumed.branchName).toContain(resumed.id);
    expect(resumed.baseSha).toBe("1111111111111111111111111111111111111111");
    expect(resumed.commitSha).toBe("2222222222222222222222222222222222222222");
    expect(resumed.evidence).toMatchObject({
      resume: { fromRunId: claimed.id, branchName: resumed.branchName },
    });
    const replay = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${claimed.id}/resume`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "t7-quota-resume",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          preferredModel: "zai/glm-5.3",
        }),
      },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe(resumed.id);
    expect(await db.select().from(schema.taskRunTable)).toHaveLength(2);
  });

  it("uses the stored schedule retry budget for Telegram quota resume", async () => {
    const fixture = await createScheduleFixture();
    const created = await createSchedule(fixture.app, fixture.task.id, {
      preferredModel: "zai/glm-5.3",
      telegramQuotaResume: "allowed_same_model_after_reset",
      retryPolicy: { maxAttempts: 2, backoffSeconds: 15 },
    });
    expect(created.status).toBe(201);
    const scheduleId = ((await created.json()) as { id: string }).id;
    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(200);
    const dispatched = (await dispatch.json()) as { runId: string | null };
    expect(dispatched.runId).toEqual(expect.any(String));

    const [source] = await db
      .select()
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, dispatched.runId ?? ""));
    expect(source).toBeDefined();
    await db
      .update(schema.taskRunTable)
      .set({
        state: "blocked_quota",
        leaseActive: false,
        leaseExpiresAt: new Date(0),
        retryAt: new Date(Date.now() - 1_000),
        maxAttempts: 1,
        failureKind: "provider_quota",
        evidence: {
          schedule: {
            scheduleId,
            preferredModel: "zai/glm-5.3",
            maxRuntimeSeconds: 3600,
            retryPolicy: { maxAttempts: 2, backoffSeconds: 15 },
          },
        },
      })
      .where(eq(schema.taskRunTable.id, dispatched.runId ?? ""));

    const resumed = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${dispatched.runId}/resume`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "telegram-quota-resume-budget-1",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          initiatedBy: "telegram",
        }),
      },
    );
    expect(resumed.status).toBe(201);
    expect(await resumed.json()).toMatchObject({
      attempt: 2,
      maxAttempts: 2,
      parentRunId: dispatched.runId,
      scheduleId,
    });
  });

  it("binds dispatch fencing to a Telegram resume so the host can spawn it", async () => {
    const fixture = await createScheduleFixture();
    const created = await createSchedule(fixture.app, fixture.task.id, {
      preferredModel: "zai/glm-5.3",
      telegramQuotaResume: "allowed_same_model_after_reset",
      retryPolicy: { maxAttempts: 2, backoffSeconds: 15 },
    });
    expect(created.status).toBe(201);
    const scheduleId = ((await created.json()) as { id: string }).id;
    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(200);
    const dispatched = (await dispatch.json()) as { runId: string | null };

    await db
      .update(schema.taskRunTable)
      .set({
        state: "blocked_quota",
        leaseActive: false,
        leaseExpiresAt: new Date(0),
        retryAt: new Date(Date.now() - 1_000),
        maxAttempts: 1,
        failureKind: "provider_quota",
        logicalSessionId: "logical-session-1",
        evidence: {
          schedule: {
            scheduleId,
            preferredModel: "zai/glm-5.3",
            maxRuntimeSeconds: 3600,
            retryPolicy: { maxAttempts: 2, backoffSeconds: 15 },
          },
        },
      })
      .where(eq(schema.taskRunTable.id, dispatched.runId ?? ""));

    const resumed = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${dispatched.runId}/resume`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "telegram-resume-dispatch-1",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          initiatedBy: "telegram",
        }),
      },
    );
    expect(resumed.status).toBe(201);
    const resumedBody = (await resumed.json()) as {
      id: string;
      parentRunId: string | null;
      scheduleId: string | null;
      logicalSessionId: string | null;
      dispatch?: {
        scheduleId: string;
        occurrenceId: string;
        ackToken: string;
        runnerSupervisorFence: string;
        preferredModel: string | null;
        maxRuntimeSeconds: number;
      };
    };
    expect(resumedBody.parentRunId).toBe(dispatched.runId);
    expect(resumedBody.scheduleId).toBe(scheduleId);
    expect(resumedBody.logicalSessionId).toBe("logical-session-1");
    expect(resumedBody.dispatch).toMatchObject({
      scheduleId,
      preferredModel: "zai/glm-5.3",
      maxRuntimeSeconds: 3600,
    });
    expect(resumedBody.dispatch?.ackToken).toEqual(expect.any(String));
    expect(resumedBody.dispatch?.runnerSupervisorFence).toEqual(
      expect.any(String),
    );

    const [occurrence] = await db
      .select()
      .from(schema.executionScheduleOccurrenceTable)
      .where(
        eq(
          schema.executionScheduleOccurrenceTable.occurrenceKey,
          `${scheduleId}:resume:${resumedBody.id}`,
        ),
      );
    expect(occurrence?.state).toBe("dispatched");
    expect(occurrence?.runId).toBe(resumedBody.id);
    expect(occurrence?.supervisorFenceHash).toBe(
      stableHash(resumedBody.dispatch?.runnerSupervisorFence ?? ""),
    );

    const ack = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/ack`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          occurrenceId: resumedBody.dispatch?.occurrenceId,
          runId: resumedBody.id,
          agentPrincipalId: fixture.principal.id,
          ackToken: resumedBody.dispatch?.ackToken,
        }),
      },
    );
    expect(ack.status).toBe(200);

    const replay = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${dispatched.runId}/resume`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "telegram-resume-dispatch-1",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          initiatedBy: "telegram",
        }),
      },
    );
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      id: string;
      dispatch?: unknown;
    };
    expect(replayBody.id).toBe(resumedBody.id);
    expect(replayBody.dispatch).toBeUndefined();
  });

  it("reclaims stale leases with durable watchdog evidence", async () => {
    const fixture = await createScheduleFixture();
    const created = await createSchedule(fixture.app, fixture.task.id);
    const scheduleId = ((await created.json()) as { id: string }).id;
    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    const dispatchBody = (await dispatch.json()) as { runId?: string };
    expect(dispatchBody.runId).toEqual(expect.any(String));
    await db
      .update(schema.taskRunTable)
      .set({
        lastHeartbeatAt: new Date(Date.now() - 3_600_000),
        leaseExpiresAt: new Date(Date.now() - 3_599_000),
      })
      .where(eq(schema.taskRunTable.id, dispatchBody.runId ?? ""));

    const watchdog = await fixture.app.request(
      "/api/execution/watchdog/reclaim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ staleAfterSeconds: 60 }),
      },
    );
    expect(watchdog.status).toBe(200);
    expect(await watchdog.json()).toHaveLength(1);
    const [run] = await db
      .select()
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, dispatchBody.runId ?? ""));
    expect(run).toMatchObject({
      state: "orphaned",
      leaseActive: false,
      blocker: "watchdog_stale_lease",
    });
    const evidence = await db
      .select()
      .from(schema.taskRunEvidenceTable)
      .where(eq(schema.taskRunEvidenceTable.runId, dispatchBody.runId ?? ""));
    expect(evidence.some((item) => item.kind === "watchdog_stale_lease")).toBe(
      true,
    );
    const replay = await fixture.app.request(
      "/api/execution/watchdog/reclaim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ staleAfterSeconds: 60 }),
      },
    );
    expect(await replay.json()).toEqual([]);
  });

  it("does not let a manual dispatch bypass a future fire time", async () => {
    const fixture = await createScheduleFixture();
    const created = await createSchedule(fixture.app, fixture.task.id, {
      notBefore: new Date(Date.now() + 60_000).toISOString(),
    });
    const scheduleId = ((await created.json()) as { id: string }).id;

    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(409);
    expect(
      await db.select().from(schema.executionScheduleOccurrenceTable),
    ).toHaveLength(0);
  });

  it("records a durable no-op and disables a permanently ineligible schedule", async () => {
    const fixture = await createScheduleFixture({ taskStatus: "published" });
    const created = await createSchedule(fixture.app, fixture.task.id);
    const scheduleId = ((await created.json()) as { id: string }).id;

    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(200);
    expect(await dispatch.json()).toMatchObject({ outcome: "no_op" });

    const [occurrence] = await db
      .select()
      .from(schema.executionScheduleOccurrenceTable);
    const [schedule] = await db
      .select()
      .from(schema.executionScheduleTable)
      .where(eq(schema.executionScheduleTable.id, scheduleId));
    expect(occurrence?.state).toBe("failed");
    expect(occurrence?.failureReason).toMatch(/ready or queued/);
    expect(schedule?.enabled).toBe(false);
    expect(await db.select().from(schema.taskRunTable)).toHaveLength(0);
  });

  it("rejects an implicit default model when the manifest has an allowlist", async () => {
    const fixture = await createScheduleFixture({
      allowedModels: ["zai/glm-5.3"],
    });
    const created = await createSchedule(fixture.app, fixture.task.id);
    const scheduleId = ((await created.json()) as { id: string }).id;

    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(200);
    expect(await dispatch.json()).toMatchObject({ outcome: "no_op" });
    expect(await db.select().from(schema.taskRunTable)).toHaveLength(0);
  });

  it("advances declared preapproved fallbacks without duplicating the task", async () => {
    const fixture = await createScheduleFixture({
      allowedModels: ["openai-codex/gpt-5.6-luna", "zai/glm-5.3"],
    });
    const created = await createSchedule(fixture.app, fixture.task.id, {
      preferredModel: "openai-codex/gpt-5.6-luna",
      fallbackMode: "preapproved",
      fallbackModels: ["zai/glm-5.3"],
    });
    expect(created.status).toBe(201);
    const scheduleId = ((await created.json()) as { id: string }).id;
    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(200);
    const dispatched = (await dispatch.json()) as { runId: string };
    const claim = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "preapproved-initial-claim",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          scope: ["apps/api/src/execution/service.ts"],
        }),
      },
    );
    const claimed = (await claim.json()) as {
      id: string;
      leaseEpoch: number;
      leaseToken: string;
    };
    expect(claimed.id).toBe(dispatched.runId);
    const report = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${claimed.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "preapproved-quota-report",
          "X-Kaneo-Lease-Token": claimed.leaseToken,
        },
        body: JSON.stringify({
          leaseEpoch: claimed.leaseEpoch,
          state: "blocked_quota",
          evidence: {
            failureKind: "provider_quota",
            model: "openai-codex/gpt-5.6-luna",
          },
          blocker: "provider quota exhausted",
        }),
      },
    );
    expect(report.status).toBe(200);

    const candidates = await fixture.app.request(
      "/api/execution/fallback/due?host=prodesk-home",
    );
    expect(candidates.status).toBe(200);
    expect(await candidates.json()).toMatchObject([
      {
        runId: claimed.id,
        nextModel: "zai/glm-5.3",
        failureKind: "provider_quota",
      },
    ]);

    const fallback = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${claimed.id}/fallback`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "preapproved-fallback-1",
        },
        body: JSON.stringify({ agentPrincipalId: fixture.principal.id }),
      },
    );
    expect(fallback.status).toBe(201);
    const fallbackBody = (await fallback.json()) as {
      outcome: string;
      run: {
        id: string;
        scheduleId: string;
        evidence: Record<string, unknown>;
      };
    };
    expect(fallbackBody.outcome).toBe("created");
    expect(fallbackBody.run.scheduleId).toBe(scheduleId);
    expect(fallbackBody.run.evidence).toMatchObject({
      fallback: {
        fromRunId: claimed.id,
        model: "zai/glm-5.3",
        fallbackIndex: 0,
      },
    });
    const reconcileCandidates = await fixture.app.request(
      "/api/execution/fallback/due?host=prodesk-home",
    );
    expect(await reconcileCandidates.json()).toMatchObject([
      {
        action: "spawn",
        runId: fallbackBody.run.id,
        currentModel: "zai/glm-5.3",
      },
    ]);

    const replay = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${claimed.id}/fallback`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "preapproved-fallback-1",
        },
        body: JSON.stringify({ agentPrincipalId: fixture.principal.id }),
      },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).run.id).toBe(fallbackBody.run.id);

    const fallbackClaim = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "preapproved-fallback-claim",
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          scope: ["apps/api/src/execution/service.ts"],
        }),
      },
    );
    const fallbackLease = (await fallbackClaim.json()) as {
      id: string;
      leaseEpoch: number;
      leaseToken: string;
    };
    expect(fallbackLease.id).toBe(fallbackBody.run.id);
    const fallbackReport = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${fallbackLease.id}/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "preapproved-fallback-quota-report",
          "X-Kaneo-Lease-Token": fallbackLease.leaseToken,
        },
        body: JSON.stringify({
          leaseEpoch: fallbackLease.leaseEpoch,
          state: "blocked_quota",
          evidence: {
            failureKind: "provider_quota",
            model: "zai/glm-5.3",
          },
        }),
      },
    );
    expect(fallbackReport.status).toBe(200);
    const exhausted = await fixture.app.request(
      `/api/execution/task/${fixture.task.id}/runs/${fallbackLease.id}/fallback`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "preapproved-fallback-2",
        },
        body: JSON.stringify({ agentPrincipalId: fixture.principal.id }),
      },
    );
    expect(exhausted.status).toBe(200);
    expect(await exhausted.json()).toMatchObject({
      outcome: "exhausted",
      run: { id: fallbackBody.run.id, state: "failed" },
    });
    expect(await db.select().from(schema.taskRunTable)).toHaveLength(2);
  });

  it("sends execution blockers through the active Telegram alert handler", async () => {
    const fixture = await createScheduleFixture();
    const token = `123456789:${"A".repeat(35)}`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await handleExecutionRunUpdated(
      {
        taskId: fixture.task.id,
        projectId: fixture.project.id,
        runId: "run-provider-quota",
        userId: fixture.member.user.id,
        state: "blocked_quota",
      },
      {
        integrationId: "telegram-fixture",
        projectId: fixture.project.id,
        config: {
          botToken: token,
          chatId: "-1001234567890",
          events: { executionRunUpdated: true },
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://api.telegram.org/bot");
    const payload = JSON.parse(String(init.body)) as {
      chat_id: string;
      text: string;
    };
    expect(payload.chat_id).toBe("-1001234567890");
    expect(payload.text).toContain("provider quota");
    expect(payload.text).not.toContain(token);
  });

  it("enforces the host binding and manifest model allowlist before run creation", async () => {
    const fixture = await createScheduleFixture({
      hostId: "laptop",
      allowedModels: ["zai/glm-5.3"],
    });
    const created = await createSchedule(fixture.app, fixture.task.id, {
      host: "prodesk-home",
      preferredModel: "openai-codex/gpt-5.6-luna",
    });
    const scheduleId = ((await created.json()) as { id: string }).id;

    const dispatch = await fixture.app.request(
      `/api/execution/schedules/${scheduleId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: ["apps/api/src/execution/service.ts"],
          agentPrincipalId: fixture.principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(200);
    expect(await dispatch.json()).toMatchObject({ outcome: "no_op" });
    expect(await db.select().from(schema.taskRunTable)).toHaveLength(0);
  });
});
