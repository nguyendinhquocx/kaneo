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
    });
    expect(first.status).toBe(201);
    const scheduleId = ((await first.json()) as { id: string }).id;

    const replay = await createSchedule(fixture.app, fixture.task.id, {
      notBefore,
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
    };
    expect(dispatchBody).toMatchObject({ outcome: "dispatched" });
    expect(dispatchBody.ackToken).toEqual(expect.any(String));

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
    };
    expect(retryBody).toMatchObject({
      outcome: "reconciled_existing_run",
    });
    expect(retryBody.ackToken).toEqual(expect.any(String));

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
    };
    expect(recoveredBody).toMatchObject({
      outcome: "reconciled_existing_run",
      runId: runs[0]?.id,
    });
    expect(recoveredBody.ackToken).toEqual(expect.any(String));
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
    expect(await firstDispatch.json()).toMatchObject({ outcome: "no_op" });

    const [afterFirst] = await db
      .select()
      .from(schema.executionScheduleTable)
      .where(eq(schema.executionScheduleTable.id, scheduleId));
    const [firstOccurrence] = await db
      .select()
      .from(schema.executionScheduleOccurrenceTable);
    expect(firstOccurrence?.state).toBe("failed");
    expect(afterFirst?.enabled).toBe(true);
    expect(afterFirst?.nextDispatchAt?.getTime()).toBeGreaterThan(Date.now());
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
    expect(secondDispatch.status).toBe(200);
    expect(await secondDispatch.json()).toMatchObject({ outcome: "no_op" });
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

  it("rejects preapproved fallback until the quota worker can execute it", async () => {
    const fixture = await createScheduleFixture();
    const created = await createSchedule(fixture.app, fixture.task.id, {
      preferredModel: "zai/glm-5.3",
      fallbackMode: "preapproved",
      fallbackModels: ["openai-codex/gpt-5.6-luna"],
    });
    expect(created.status).toBe(400);
    expect(await created.text()).toMatch(/preapproved fallback/);
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
