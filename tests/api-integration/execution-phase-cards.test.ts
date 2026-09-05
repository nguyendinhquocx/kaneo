import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import {
  canonicalSha256,
  computeGraphId,
  createLeaseToken,
  validatePhaseMapInput,
  computeSourcePhaseMapHash,
} from "../../apps/api/src/execution/validation";
import { mockAuthenticatedSessions } from "./helpers/auth";
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

const PHASE_FILES = ["src/one.mjs", "src/two.mjs", "src/three.mjs"];
const UNION_FILES = [...PHASE_FILES].sort();
const SHA_A = "a".repeat(40);

function sha40(prefix: string) {
  return (prefix + "0".repeat(64)).slice(0, 40);
}

async function hashApiKeyForTest(key: string): Promise<string> {
  const hash = createHash("sha256").update(key).digest();
  return hash
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function workerContractDescription(specId: string) {
  const contract = {
    schema: 1,
    agent: "pi-prodesk",
    repo: "owner/repository",
    path: ".",
    state: "ready",
    spec_id: specId,
    task_id: "FULL",
    files: UNION_FILES,
    scope: UNION_FILES,
    writes: UNION_FILES,
  };
  const phaseMap = {
    execution_mode: "full_run",
    phases: ["P1", "P2", "P3"].map((phaseId, index) => ({
      phase_id: phaseId,
      parser_task_id: `T${index + 1}`,
      ordinal: index + 1,
      required: true,
      title: `Phase ${index + 1}`,
      files: [PHASE_FILES[index]],
      verify: [`node --check ${PHASE_FILES[index]}`],
    })),
  };
  return `${JSON.stringify(contract)}\n${JSON.stringify(phaseMap)}`;
}

function graphPublishBody(overrides?: Record<string, unknown>) {
  return {
    planHash: canonicalSha256({ plan: "fixture" }),
    expectedProjectRevision: 1,
    changeSetId: "cs-fixture-1",
    specId: "SPEC-kaneo-phase-cards-fixture",
    specSha256: canonicalSha256({ spec: "fixture" }),
    sourcePhaseMapSha256: computeSourcePhaseMapHash(
      validatePhaseMapInput([0, 1, 2].map((index) => ({
        phaseId: `P${index + 1}`,
        parserTaskId: `T${index + 1}`,
        ordinal: index + 1,
        required: true,
        title: `Phase ${index + 1}`,
        files: [PHASE_FILES[index]],
        verify: [`node --check ${PHASE_FILES[index]}`],
      }))),
    ),
    baseBranch: "main",
    full: {
      title: "FULL: server authority fixture",
      description: workerContractDescription("SPEC-kaneo-phase-cards-fixture"),
      scope: UNION_FILES,
      verify: ["pnpm test"],
      taskExecutionState: "published",
    },
    phases: [0, 1, 2].map((index) => ({
      phaseId: `P${index + 1}`,
      parserTaskId: `T${index + 1}`,
      ordinal: index + 1,
      required: true,
      title: `Phase ${index + 1}`,
      description: `Do phase ${index + 1}`,
      files: [PHASE_FILES[index]],
      verify: [`node --check ${PHASE_FILES[index]}`],
      status: "to-do",
    })),
    ...overrides,
  };
}

type Fixture = Awaited<ReturnType<typeof buildFullRunFixture>>;

async function buildFullRunFixture() {
  const workerOwner = await createWorkspaceMember({
    userName: "Phase Worker Owner",
    role: "admin",
  });
  const parentUser = await createWorkspaceMember({
    userName: "Phase Parent",
    role: "admin",
  });
  await db
    .update(schema.userTable)
    .set({ role: "admin" })
    .where(eq(schema.userTable.id, workerOwner.user.id));
  await db
    .update(schema.userTable)
    .set({ role: "admin" })
    .where(eq(schema.userTable.id, parentUser.user.id));
  const { project, columns } = await createProjectFixture({
    workspaceId: workerOwner.workspace.id,
  });

  await db.insert(schema.githubIntegrationTable).values({
    projectId: project.id,
    repositoryOwner: "owner",
    repositoryName: "repository",
    isActive: true,
  });

  const [principal] = await db
    .insert(schema.agentPrincipalTable)
    .values({
      userId: workerOwner.user.id,
      runtimeId: "pi-prodesk",
      hostId: "prodesk-home",
      scopes: WORKER_SCOPES,
    })
    .returning();
  if (!principal) throw new Error("principal fixture missing");

  await db.insert(schema.executionManifestTable).values({
    projectId: project.id,
    repositoryOwner: "owner",
    repositoryName: "repository",
    baseBranch: "main",
    verificationProfile: "kaneo-api-test",
    allowedAgentIds: [principal.id],
    policy: { allowMerge: true, allowPrCreate: true },
  });

  const { app } = createApp();
  mockAuthenticatedSessions(workerOwner.user, {
    "worker-owner-token": workerOwner.user,
    "parent-token": parentUser.user,
  });

  // Parent publishes the graph transactionally.
  const publish = await app.request(
    `/api/execution/project/${project.id}/full-run-graphs`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer parent-token",
        "Idempotency-Key": "graph-key-1",
        "X-Kaneo-Change-Set": "cs-fixture-1",
      },
      body: JSON.stringify(graphPublishBody()),
    },
  );
  expect(publish.status).toBe(200);
  const receipt = (await publish.json()) as {
    schemaVersion: number;
    graphId: string;
    projectId: string;
    projectRevision: number;
    fullTaskId: string;
    phaseCards: Array<{
      phaseId: string;
      parserTaskId: string;
      childTaskId: string;
      ordinal: number;
      required: boolean;
    }>;
    sourcePhaseMapSha256: string;
    graphMapSha256: string;
    specSha256: string;
    changeSetId: string;
    planHash: string;
    taskRevision: number;
    receiptSha256: string;
  };

  // Parent readies the graph (CAS published -> ready).
  const ready = await app.request(
    `/api/execution/project/${project.id}/full-run-graphs/${receipt.graphId}/ready`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer parent-token",
        "Idempotency-Key": "ready-key-1",
      },
      body: JSON.stringify({
        planHash: receipt.planHash,
        expectedProjectRevision: receipt.projectRevision,
        expectedTaskRevision: receipt.taskRevision,
      }),
    },
  );
  expect(ready.status).toBe(200);

  // Worker claims the FULL task (normal claim; column CAS now passes).
  const claim = await app.request(
    `/api/execution/task/${receipt.fullTaskId}/runs/claim`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer worker-owner-token",
        "Idempotency-Key": `claim-${randomUUID()}`,
      },
      body: JSON.stringify({
        agentPrincipalId: principal.id,
        scope: UNION_FILES,
      }),
    },
  );
  expect(claim.status).toBe(201);
  const run = (await claim.json()) as {
    id: string;
    taskId: string;
    leaseEpoch: number;
    leaseToken: string;
    leaseActive: boolean;
    state: string;
    branchName: string;
    baseSha: string | null;
  };

  return {
    app,
    project,
    columns,
    principal,
    workerOwner,
    parentUser,
    receipt,
    run,
  };
}

function baseHeaders(fixture: Fixture, key: string, token?: string) {
  return {
    "content-type": "application/json",
    Authorization: "Bearer worker-owner-token",
    ...(token ? { "X-Kaneo-Lease-Token": token } : {}),
    "Idempotency-Key": key,
  };
}

function postPhaseProgress(
  fixture: Fixture,
  body: Record<string, unknown>,
  key: string,
  token = fixture.run.leaseToken,
  epoch = fixture.run.leaseEpoch,
) {
  return fixture.app.request(
    `/api/execution/task/${fixture.receipt.fullTaskId}/runs/${fixture.run.id}/phase-progress`,
    {
      method: "POST",
      headers: baseHeaders(fixture, key, token),
      body: JSON.stringify({ leaseEpoch: epoch, ...body }),
    },
  );
}

async function createPhaseCheckpointApi(
  fixture: Fixture,
  phaseId: string,
  commitSha: string,
  baseSha: string,
  key: string,
  token = fixture.run.leaseToken,
  epoch = fixture.run.leaseEpoch,
) {
  return fixture.app.request(
    `/api/execution/task/${fixture.receipt.fullTaskId}/runs/${fixture.run.id}/phase-checkpoints`,
    {
      method: "POST",
      headers: baseHeaders(fixture, key, token),
      body: JSON.stringify({
        leaseEpoch: epoch,
        phaseId,
        headSha: commitSha,
        commitSha,
        baseSha,
        guardReceipt: {
          receiptId: `receipt-${phaseId}`,
          remoteRef: fixture.run.branchName,
          headSha: commitSha,
          commitSha,
          receiptHash: "hash",
        },
        commands: ["pnpm test"],
        artifactHashes: {},
      }),
    },
  );
}

async function createAgentApiKeyFixture(member: typeof schema.userTable.$inferSelect) {
  const rawKey = `agent_key_${randomUUID()}`;
  const now = new Date();
  const hashedKey = await hashApiKeyForTest(rawKey);
  await db.insert(schema.apikeyTable).values({
    referenceId: member.id,
    userId: member.id,
    key: hashedKey,
    name: "agent key",
    start: rawKey.slice(0, 12),
    prefix: "kaneo",
    createdAt: now,
    updatedAt: now,
    permissions: JSON.stringify({
      task: ["create", "update", "delete", "read"],
      label: ["create", "update", "delete"],
    }),
  });
  return rawKey;
}

describe("API integration: FULL-run phase cards (SPEC-kaneo-phase-cards-full-run-server-v0-1)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("publishes the graph transactionally with a self-hashing receipt and replays it idempotently", async () => {
    const fixture = await buildFullRunFixture();
    const { receipt, project } = fixture;

    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.graphId).toBe(
      computeGraphId({
        projectId: project.id,
        changeSetId: "cs-fixture-1",
        planHash: receipt.planHash,
      }),
    );
    const { receiptSha256, ...rest } = receipt;
    expect(canonicalSha256(rest)).toBe(receiptSha256);
    expect(receipt.phaseCards).toHaveLength(3);
    expect(receipt.phaseCards.map((card) => card.phaseId)).toEqual([
      "P1",
      "P2",
      "P3",
    ]);

    const tasks = await db
      .select({
        id: schema.taskTable.id,
        executionState: schema.taskTable.executionState,
        title: schema.taskTable.title,
      })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    expect(tasks).toHaveLength(4); // 1 FULL + 3 children, no orphans

    const cards = await db.select().from(schema.executionPhaseCardTable);
    expect(cards).toHaveLength(3);
    expect(
      cards.every((card) => card.fullTaskId === receipt.fullTaskId),
    ).toBe(true);

    const ledger = await db
      .select()
      .from(schema.executionPhaseProgressTable)
      .where(
        eq(
          schema.executionPhaseProgressTable.fullTaskId,
          receipt.fullTaskId,
        ),
      );
    expect(ledger).toHaveLength(3);
    expect(ledger.every((row) => row.state === "pending")).toBe(true);

    const relations = await db
      .select()
      .from(schema.taskRelationTable)
      .where(
        eq(schema.taskRelationTable.sourceTaskId, receipt.fullTaskId),
      );
    expect(relations).toHaveLength(3);
    expect(
      relations.every((relation) => relation.relationType === "subtask"),
    ).toBe(true);

    // Retry with the same key + payload replays the stored receipt.
    const retry = await fixture.app.request(
      `/api/execution/project/${project.id}/full-run-graphs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
          "Idempotency-Key": "graph-key-1",
          "X-Kaneo-Change-Set": "cs-fixture-1",
        },
        body: JSON.stringify(graphPublishBody()),
      },
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(receipt);
    expect(
      await db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.projectId, project.id)),
    ).toHaveLength(4);

    // Same key, different payload -> 409.
    const conflict = await fixture.app.request(
      `/api/execution/project/${project.id}/full-run-graphs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
          "Idempotency-Key": "graph-key-1",
          "X-Kaneo-Change-Set": "cs-fixture-1",
        },
        body: JSON.stringify(
          graphPublishBody({ changeSetId: "cs-fixture-1", planHash: "other" }),
        ),
      },
    );
    expect(conflict.status).toBe(409);

    // GET by graphId and by requestKey both return the bounded receipt.
    const byGraph = await fixture.app.request(
      `/api/execution/project/${project.id}/full-run-graphs/${receipt.graphId}`,
      { headers: { Authorization: "Bearer parent-token" } },
    );
    expect(byGraph.status).toBe(200);
    expect(await byGraph.json()).toEqual(receipt);
    const byRequest = await fixture.app.request(
      `/api/execution/project/${project.id}/full-run-graphs/by-request?requestKey=graph-key-1`,
      { headers: { Authorization: "Bearer parent-token" } },
    );
    expect(byRequest.status).toBe(200);
    expect(await byRequest.json()).toEqual(receipt);
  });

  it("rejects a bad source phase map hash and the 31st phase without creating rows", async () => {
    const { workerOwner, parentUser } = await buildFullRunFixture();
    const { project } = await (async () => ({
      project: (
        await db
          .select()
          .from(schema.projectTable)
          .where(eq(schema.projectTable.workspaceId, workerOwner.workspace.id))
          .limit(1)
      )[0]!,
    }))();
    const { app } = createApp();
    mockAuthenticatedSessions(workerOwner.user, {
      "parent-token": parentUser.user,
    });
    const badHash = await app.request(
      `/api/execution/project/${project.id}/full-run-graphs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
          "Idempotency-Key": "graph-bad-hash",
          "X-Kaneo-Change-Set": "cs-x",
        },
        body: JSON.stringify(
          graphPublishBody(
            { changeSetId: "cs-x" },
          ),
        ),
      },
    );
    // changeSet header mismatch is rejected first (header must equal body).
    expect([400, 409]).toContain(badHash.status);
    const tooMany = await app.request(
      `/api/execution/project/${project.id}/full-run-graphs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
          "Idempotency-Key": "graph-too-many",
          "X-Kaneo-Change-Set": "cs-many",
        },
        body: JSON.stringify(
          graphPublishBody({
            changeSetId: "cs-many",
            phases: Array.from({ length: 31 }, (_, index) => ({
              phaseId: `P${index + 1}`,
              parserTaskId: `T${index + 1}`,
              ordinal: index + 1,
              required: true,
              title: `Phase ${index + 1}`,
              files: [`src/p${index + 1}.mjs`],
              verify: [`node --check src/p${index + 1}.mjs`],
              status: "to-do",
            })),
          }),
        ),
      },
    );
    expect(tooMany.status).toBe(409);
    expect(await tooMany.text()).toContain("phase_count_exceeds_limit");
  });

  it("blocks dispatch and claim while the FULL graph is published and passes after ready-CAS", async () => {
    const workerOwner = await createWorkspaceMember({
      userName: "Elig Worker",
      role: "admin",
    });
    const parentUser = await createWorkspaceMember({
      userName: "Elig Parent",
      role: "admin",
    });
    await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, workerOwner.user.id));
    await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, parentUser.user.id));
    const { project } = await createProjectFixture({
      workspaceId: workerOwner.workspace.id,
    });
    await db.insert(schema.githubIntegrationTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repository",
      isActive: true,
    });
    const [principal] = await db
      .insert(schema.agentPrincipalTable)
      .values({
        userId: workerOwner.user.id,
        runtimeId: "pi-prodesk",
        hostId: "prodesk-home",
        scopes: WORKER_SCOPES,
      })
      .returning();
    if (!principal) throw new Error("principal fixture missing");
    await db.insert(schema.executionManifestTable).values({
      projectId: project.id,
      repositoryOwner: "owner",
      repositoryName: "repository",
      baseBranch: "main",
      verificationProfile: "kaneo-api-test",
      allowedAgentIds: [principal.id],
      policy: { allowMerge: true, allowPrCreate: true },
    });
    const { app } = createApp();
    mockAuthenticatedSessions(workerOwner.user, {
      "worker-owner-token": workerOwner.user,
      "parent-token": parentUser.user,
    });

    const publish = await app.request(
      `/api/execution/project/${project.id}/full-run-graphs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
          "Idempotency-Key": "graph-elig",
          "X-Kaneo-Change-Set": "cs-elig",
        },
        body: JSON.stringify(
          graphPublishBody({ changeSetId: "cs-elig" }),
        ),
      },
    );
    expect(publish.status).toBe(200);
    const receipt = (await publish.json()) as {
      graphId: string;
      fullTaskId: string;
      projectRevision: number;
      taskRevision: number;
      planHash: string;
    };

    // Still published: claim is blocked by the execution_state column CAS.
    const earlyClaim = await app.request(
      `/api/execution/task/${receipt.fullTaskId}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer worker-owner-token",
          "Idempotency-Key": `claim-early-${randomUUID()}`,
        },
        body: JSON.stringify({
          agentPrincipalId: principal.id,
          scope: UNION_FILES,
        }),
      },
    );
    expect(earlyClaim.status).toBe(409);
    expect(await earlyClaim.text()).toContain("full_run_not_ready");

    // Scheduled dispatch of a published FULL is a durable no-op.
    const createSchedule = await app.request(
      `/api/execution/task/${receipt.fullTaskId}/schedules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer worker-owner-token",
          "Idempotency-Key": "sched-elig-1",
        },
        body: JSON.stringify({
          notBefore: new Date(Date.now() - 1_000).toISOString(),
          maxRuntimeSeconds: 3600,
        }),
      },
    );
    expect(createSchedule.status).toBe(201);
    const schedule = (await createSchedule.json()) as { id: string };
    const dispatch = await app.request(
      `/api/execution/schedules/${schedule.id}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: UNION_FILES,
          agentPrincipalId: principal.id,
        }),
      },
    );
    expect(dispatch.status).toBe(200);
    const dispatchBody = (await dispatch.json()) as {
      outcome: string;
      reason?: string;
    };
    expect(dispatchBody.outcome).toBe("no_op");
    expect(dispatchBody.reason).toContain("schedule_eligibility");

    // Ready-CAS flips the column; dispatch then passes.
    const ready = await app.request(
      `/api/execution/project/${project.id}/full-run-graphs/${receipt.graphId}/ready`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
          "Idempotency-Key": "ready-elig",
        },
        body: JSON.stringify({
          planHash: receipt.planHash,
          expectedProjectRevision: receipt.projectRevision,
          expectedTaskRevision: receipt.taskRevision,
        }),
      },
    );
    expect(ready.status).toBe(200);

    const readyDrift = await app.request(
      `/api/execution/project/${project.id}/full-run-graphs/${receipt.graphId}/ready`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
          "Idempotency-Key": `ready-drift-${randomUUID()}`,
        },
        body: JSON.stringify({
          planHash: receipt.planHash,
          expectedProjectRevision: 1,
          expectedTaskRevision: 1,
        }),
      },
    );
    expect(readyDrift.status).toBe(409);

    const schedule2 = await app.request(
      `/api/execution/task/${receipt.fullTaskId}/schedules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer worker-owner-token",
          "Idempotency-Key": `sched-elig-2-${randomUUID()}`,
        },
        body: JSON.stringify({
          notBefore: new Date(Date.now() - 1_000).toISOString(),
          maxRuntimeSeconds: 3600,
        }),
      },
    );
    expect(schedule2.status).toBe(201);
    const schedule2Body = (await schedule2.json()) as { id: string };
    const dispatch2 = await app.request(
      `/api/execution/schedules/${schedule2Body.id}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: UNION_FILES,
          agentPrincipalId: principal.id,
        }),
      },
    );
    expect(dispatch2.status).toBe(200);
    expect(await dispatch2.json()).toMatchObject({ outcome: "dispatched" });
  });

  it("runs fenced begin/complete in order with one-active, idempotency and checkpoint lineage", async () => {
    const fixture = await buildFullRunFixture();
    const fullTaskId = fixture.receipt.fullTaskId;
    let token = fixture.run.leaseToken;
    let epoch = fixture.run.leaseEpoch;

    // Stale token is a read-only rejection: nothing mutates.
    const stale = await postPhaseProgress(
      fixture,
      { phaseId: "P1", action: "begin" },
      `begin-stale-${randomUUID()}`,
      "wrong-token",
    );
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("stale_fence");
    const [runAfterStale] = await db
      .select()
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, fixture.run.id));
    expect(runAfterStale?.state).toBe("in_progress");
    expect(runAfterStale?.leaseEpoch).toBe(fixture.run.leaseEpoch);

    // Predecessor order: P3 cannot begin before P1/P2.
    const skip = await postPhaseProgress(
      fixture,
      { phaseId: "P3", action: "begin" },
      `begin-skip-${randomUUID()}`,
    );
    expect(skip.status).toBe(409);
    expect(await skip.text()).toContain("phase_progress_predecessor");

    // Begin P1.
    const begin1 = await postPhaseProgress(
      fixture,
      { phaseId: "P1", action: "begin" },
      "phase-begin:begin-p1",
    );
    expect(begin1.status).toBe(200);
    expect(await begin1.json()).toMatchObject({
      phaseId: "P1",
      state: "in_progress",
    });

    // Checkpoint P1 at the current epoch, then simulate a same-row lease
    // renewal (epoch bump) — the older-epoch checkpoint still proves.
    const checkpoint = await createPhaseCheckpointApi(
      fixture,
      "P1",
      sha40("b1"),
      SHA_A,
      `phase-checkpoint:p1-${randomUUID()}`,
    );
    expect(checkpoint.status).toBe(200);
    const checkpointBody = (await checkpoint.json()) as {
      checkpointId: string;
      phaseId: string;
    };
    expect(checkpointBody.checkpointId).toBeTruthy();

    const renewed = createLeaseToken();
    epoch += 1;
    token = renewed.raw;
    await db
      .update(schema.taskRunTable)
      .set({
        leaseEpoch: epoch,
        leaseTokenHash: renewed.hash,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(schema.taskRunTable.id, fixture.run.id));

    // Wrong-phase checkpoint never proves (P1 still in_progress).
    const wrongCk = await createPhaseCheckpointApi(
      fixture,
      "P2",
      sha40("b2"),
      SHA_A,
      `phase-checkpoint:wrong-${randomUUID()}`,
      token,
      epoch,
    );
    expect(wrongCk.status).toBe(200);
    const wrongCkBody = (await wrongCk.json()) as { checkpointId: string };
    const complete1WithP2Ck = await postPhaseProgress(
      fixture,
      {
        phaseId: "P1",
        action: "complete",
        checkpointId: wrongCkBody.checkpointId,
      },
      `phase-complete:mismatch-${randomUUID()}`,
      token,
      epoch,
    );
    expect(complete1WithP2Ck.status).toBe(409);
    expect(await complete1WithP2Ck.text()).toContain("phase_checkpoint_mismatch");

    // Complete P1 with the epoch-1 checkpoint from the epoch-2 lease.
    const complete1 = await postPhaseProgress(
      fixture,
      {
        phaseId: "P1",
        action: "complete",
        checkpointId: checkpointBody.checkpointId,
      },
      `phase-complete:p1-${randomUUID()}`,
      token,
      epoch,
    );
    expect(complete1.status).toBe(200);
    expect(await complete1.json()).toMatchObject({
      phaseId: "P1",
      state: "done",
      checkpointId: checkpointBody.checkpointId,
    });

    // One-active: with P1 done and a non-required P2 in_progress, P3 cannot
    // begin (only one phase may be in_progress per FULL run).
    await db
      .update(schema.executionPhaseCardTable)
      .set({ required: false })
      .where(
        and(
          eq(schema.executionPhaseCardTable.fullTaskId, fullTaskId),
          eq(schema.executionPhaseCardTable.phaseId, "P2"),
        ),
      );
    const begin2Optional = await postPhaseProgress(
      fixture,
      { phaseId: "P2", action: "begin" },
      `phase-begin:p2-opt-${randomUUID()}`,
      token,
      epoch,
    );
    expect(begin2Optional.status).toBe(200);
    const begin3WhileActive = await postPhaseProgress(
      fixture,
      { phaseId: "P3", action: "begin" },
      `phase-begin:p3-active-${randomUUID()}`,
      token,
      epoch,
    );
    expect(begin3WhileActive.status).toBe(409);
    expect(await begin3WhileActive.text()).toContain("phase_progress_one_active");
    await db
      .update(schema.executionPhaseCardTable)
      .set({ required: true })
      .where(
        and(
          eq(schema.executionPhaseCardTable.fullTaskId, fullTaskId),
          eq(schema.executionPhaseCardTable.phaseId, "P2"),
        ),
      );

    // Complete without checkpoint id is a 400.
    const missingCheckpoint = await postPhaseProgress(
      fixture,
      { phaseId: "P2", action: "complete" },
      `phase-complete:missing-${randomUUID()}`,
      token,
      epoch,
    );
    expect(missingCheckpoint.status).toBe(400);

    // Complete P2 properly (its earlier optional begin already made it
    // in_progress; the checkpoint chain continues at b2 with base b1).
    const checkpoint2 = await createPhaseCheckpointApi(
      fixture,
      "P2",
      sha40("b2"),
      sha40("b1"),
      `phase-checkpoint:p2-${randomUUID()}`,
      token,
      epoch,
    );
    expect(checkpoint2.status).toBe(200);
    const checkpoint2Body = (await checkpoint2.json()) as {
      checkpointId: string;
    };

    // Broken ancestry: a P2 checkpoint claiming base SHA_A (instead of the
    // proven P1 commit) is rejected at complete time.
    const badAncestry = await createPhaseCheckpointApi(
      fixture,
      "P2",
      sha40("f2"),
      SHA_A,
      `phase-checkpoint:bad-ancestry-${randomUUID()}`,
      token,
      epoch,
    );
    expect(badAncestry.status).toBe(200);
    const badAncestryBody = (await badAncestry.json()) as {
      checkpointId: string;
    };
    const complete2Bad = await postPhaseProgress(
      fixture,
      {
        phaseId: "P2",
        action: "complete",
        checkpointId: badAncestryBody.checkpointId,
      },
      `phase-complete:p2-bad-${randomUUID()}`,
      token,
      epoch,
    );
    expect(complete2Bad.status).toBe(409);
    expect(await complete2Bad.text()).toContain("phase_checkpoint_mismatch");

    const complete2 = await postPhaseProgress(
      fixture,
      {
        phaseId: "P2",
        action: "complete",
        checkpointId: checkpoint2Body.checkpointId,
      },
      `phase-complete:p2-${randomUUID()}`,
      token,
      epoch,
    );
    expect(complete2.status).toBe(200);

    // Idempotency: pre-seed an EMPTY stored response (crash between reserve
    // and save) and verify re-execution instead of an empty replay.
    const emptyKey = `phase-begin:p3-empty-${randomUUID()}`;
    await db.insert(schema.executionIdempotencyTable).values({
      userId: fixture.workerOwner.user.id,
      runId: fixture.run.id,
      operation: "execution.phase_progress",
      requestKey: emptyKey,
      requestHash: canonicalSha256({
        action: "begin",
        taskId: fullTaskId,
        phaseId: "P3",
        failureKind: null,
        retryAt: null,
      }),
      response: {},
    });
    const begin3 = await postPhaseProgress(
      fixture,
      { phaseId: "P3", action: "begin" },
      emptyKey,
      token,
      epoch,
    );
    expect(begin3.status).toBe(200);
    const begin3Body = (await begin3.json()) as Record<string, unknown>;
    expect(begin3Body).toMatchObject({ phaseId: "P3", state: "in_progress" });
    expect(Object.keys(begin3Body).length).toBeGreaterThan(0);

    // Deterministic replay: same key + payload returns the stored response
    // even with a different epoch (fence/audit fields are not identity).
    const begin3Replay = await postPhaseProgress(
      fixture,
      { phaseId: "P3", action: "begin" },
      emptyKey,
      token,
      epoch,
    );
    expect(begin3Replay.status).toBe(200);
    expect(await begin3Replay.json()).toEqual(begin3Body);
  });

  it("blocks atomically and keeps the stale fence read-only after the lease dies", async () => {
    const fixture = await buildFullRunFixture();
    const begin1 = await postPhaseProgress(
      fixture,
      { phaseId: "P1", action: "begin" },
      `phase-begin:${randomUUID()}`,
    );
    expect(begin1.status).toBe(200);

    const block = await postPhaseProgress(
      fixture,
      {
        phaseId: "P1",
        action: "block",
        failureKind: "malformed_phase_map",
        reason: "phase map diverged from the source spec",
      },
      `phase-block:${randomUUID()}`,
    );
    expect(block.status).toBe(200);
    expect(await block.json()).toMatchObject({
      phaseId: "P1",
      state: "blocked",
      runState: "blocked_input",
      failureKind: "malformed_phase_map",
    });

    // Run blocked, lease inactive, evidence recorded — one transaction.
    const [run] = await db
      .select()
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, fixture.run.id));
    expect(run?.state).toBe("blocked_input");
    expect(run?.leaseActive).toBe(false);
    const evidence = await db
      .select()
      .from(schema.taskRunEvidenceTable)
      .where(eq(schema.taskRunEvidenceTable.runId, fixture.run.id));
    expect(
      evidence.some((row) => row.kind === "phase_block"),
    ).toBe(true);
    const [phase1] = await db
      .select()
      .from(schema.executionPhaseProgressTable)
      .where(
        and(
          eq(
            schema.executionPhaseProgressTable.fullTaskId,
            fixture.receipt.fullTaskId,
          ),
          eq(schema.executionPhaseProgressTable.phaseId, "P1"),
        ),
      );
    expect(phase1?.state).toBe("blocked");
    expect(phase1?.failureKind).toBe("malformed_phase_map");

    // The old token is stale; the read-only fence must not resurrect the run.
    const staleBegin = await postPhaseProgress(
      fixture,
      { phaseId: "P1", action: "begin" },
      `phase-begin:stale-${randomUUID()}`,
    );
    expect(staleBegin.status).toBe(409);
    const [runAfter] = await db
      .select()
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, fixture.run.id));
    expect(runAfter?.state).toBe("blocked_input");
    expect(runAfter?.leaseActive).toBe(false);

    // Blocked recovery: a fresh run on the same task opens the blocked phase.
    const claim = await fixture.app.request(
      `/api/execution/task/${fixture.receipt.fullTaskId}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer worker-owner-token",
          "Idempotency-Key": `claim-recovery-${randomUUID()}`,
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          scope: UNION_FILES,
        }),
      },
    );
    expect(claim.status).toBe(201);
    const recoveryRun = (await claim.json()) as {
      id: string;
      leaseToken: string;
      leaseEpoch: number;
      parentRunId: string | null;
    };
    const begin1Recovery = await fixture.app.request(
      `/api/execution/task/${fixture.receipt.fullTaskId}/runs/${recoveryRun.id}/phase-progress`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer worker-owner-token",
          "X-Kaneo-Lease-Token": recoveryRun.leaseToken,
          "Idempotency-Key": `phase-begin:recovery-${randomUUID()}`,
        },
        body: JSON.stringify({
          leaseEpoch: recoveryRun.leaseEpoch,
          phaseId: "P1",
          action: "begin",
        }),
      },
    );
    expect(begin1Recovery.status).toBe(200);
    expect(await begin1Recovery.json()).toMatchObject({
      phaseId: "P1",
      state: "in_progress",
    });
  });

  it("denies every generic worker bypass on the FULL mapped run", async () => {
    const fixture = await buildFullRunFixture();
    const taskId = fixture.receipt.fullTaskId;
    const runPath = `/api/execution/task/${taskId}/runs/${fixture.run.id}`;

    // report(blocked_*) -> use_phase_progress
    const reportBlocked = await fixture.app.request(`${runPath}/report`, {
      method: "POST",
      headers: baseHeaders(fixture, `report-${randomUUID()}`, fixture.run.leaseToken),
      body: JSON.stringify({
        leaseEpoch: fixture.run.leaseEpoch,
        state: "blocked_quota",
        failureKind: "provider_quota",
        blocker: "quota exhausted",
      }),
    });
    expect(reportBlocked.status).toBe(409);
    expect(await reportBlocked.text()).toContain("use_phase_progress");

    // report(in_review) before required phases are done -> 409, lease alive.
    const reportReview = await fixture.app.request(`${runPath}/report`, {
      method: "POST",
      headers: baseHeaders(fixture, `report-${randomUUID()}`, fixture.run.leaseToken),
      body: JSON.stringify({
        leaseEpoch: fixture.run.leaseEpoch,
        state: "in_review",
      }),
    });
    expect(reportReview.status).toBe(409);
    expect(await reportReview.text()).toContain("phase_progress_incomplete");
    const [runAfterReview] = await db
      .select()
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, fixture.run.id));
    expect(runAfterReview?.leaseActive).toBe(true);
    expect(runAfterReview?.state).toBe("in_progress");

    // release -> use_phase_progress
    const release = await fixture.app.request(`${runPath}/release`, {
      method: "POST",
      headers: baseHeaders(fixture, `release-${randomUUID()}`, fixture.run.leaseToken),
      body: JSON.stringify({
        leaseEpoch: fixture.run.leaseEpoch,
        state: "failed",
      }),
    });
    expect(release.status).toBe(409);
    expect(await release.text()).toContain("use_phase_progress");

    // generic checkpoint -> use_phase_checkpoint
    const genericCheckpoint = await fixture.app.request(
      `${runPath}/checkpoints`,
      {
        method: "POST",
        headers: baseHeaders(
          fixture,
          `checkpoint-${randomUUID()}`,
          fixture.run.leaseToken,
        ),
        body: JSON.stringify({
          leaseEpoch: fixture.run.leaseEpoch,
          headSha: sha40("c1"),
          commitSha: sha40("c1"),
          guardReceipt: {
            receiptId: "r",
            remoteRef: fixture.run.branchName,
            headSha: sha40("c1"),
            commitSha: sha40("c1"),
            receiptHash: "hash",
          },
        }),
      },
    );
    expect(genericCheckpoint.status).toBe(409);
    expect(await genericCheckpoint.text()).toContain("use_phase_checkpoint");

    // resume -> use_phase_progress (run put into a resumable state first)
    await db
      .update(schema.taskRunTable)
      .set({ state: "blocked_quota", leaseActive: false })
      .where(eq(schema.taskRunTable.id, fixture.run.id));
    const resume = await fixture.app.request(`${runPath}/resume`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer worker-owner-token",
        "Idempotency-Key": `resume-${randomUUID()}`,
      },
      body: JSON.stringify({ agentPrincipalId: fixture.principal.id }),
    });
    expect(resume.status).toBe(409);
    expect(await resume.text()).toContain("use_phase_progress");

    // fallback -> use_phase_progress
    const fallback = await fixture.app.request(`${runPath}/fallback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer worker-owner-token",
        "Idempotency-Key": `fallback-${randomUUID()}`,
      },
      body: JSON.stringify({ agentPrincipalId: fixture.principal.id }),
    });
    expect(fallback.status).toBe(409);
    expect(await fallback.text()).toContain("use_phase_progress");

    // Heartbeat stays open on FULL mapped runs (keep-alive) and renews.
    await db
      .update(schema.taskRunTable)
      .set({
        state: "in_progress",
        leaseActive: true,
        leaseEpoch: fixture.run.leaseEpoch,
        leaseTokenHash: (await db
          .select({ hash: schema.taskRunTable.leaseTokenHash })
          .from(schema.taskRunTable)
          .where(eq(schema.taskRunTable.id, fixture.run.id)))[0]?.hash,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(schema.taskRunTable.id, fixture.run.id));
    const heartbeat = await fixture.app.request(`${runPath}/heartbeat`, {
      method: "POST",
      headers: baseHeaders(
        fixture,
        `heartbeat-${randomUUID()}`,
        fixture.run.leaseToken,
      ),
      body: JSON.stringify({ leaseEpoch: fixture.run.leaseEpoch }),
    });
    expect(heartbeat.status).toBe(200);
    const [afterHeartbeat] = await db
      .select()
      .from(schema.taskRunTable)
      .where(eq(schema.taskRunTable.id, fixture.run.id));
    expect(afterHeartbeat?.leaseActive).toBe(true);
  });

  it("guards phase children and agent FULL-task mutations across REST surfaces (and therefore MCP)", async () => {
    const fixture = await buildFullRunFixture();
    const childId = fixture.receipt.phaseCards[0].childTaskId;
    const fullId = fixture.receipt.fullTaskId;

    // Claim a phase child (normal) -> 409.
    const claimChild = await fixture.app.request(
      `/api/execution/task/${childId}/runs/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer worker-owner-token",
          "Idempotency-Key": `claim-child-${randomUUID()}`,
        },
        body: JSON.stringify({
          agentPrincipalId: fixture.principal.id,
          scope: [PHASE_FILES[0]],
        }),
      },
    );
    expect(claimChild.status).toBe(409);
    expect(await claimChild.text()).toContain("phase_card_guard");

    // Schedule a phase child -> 409.
    const scheduleChild = await fixture.app.request(
      `/api/execution/task/${childId}/schedules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer worker-owner-token",
          "Idempotency-Key": `sched-child-${randomUUID()}`,
        },
        body: JSON.stringify({
          notBefore: new Date(Date.now() - 1_000).toISOString(),
          maxRuntimeSeconds: 3600,
        }),
      },
    );
    expect(scheduleChild.status).toBe(409);

    // Task status mutation on a child -> 409.
    const statusChild = await fixture.app.request(`/api/task/status/${childId}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer worker-owner-token",
      },
      body: JSON.stringify({ status: "done" }),
    });
    expect(statusChild.status).toBe(409);

    // Comment on a child -> 409.
    const commentChild = await fixture.app.request(`/api/comment/${childId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer worker-owner-token",
      },
      body: JSON.stringify({ content: "forge a comment" }),
    });
    expect(commentChild.status).toBe(409);

    // Relation forging to a child -> 409.
    const relation = await fixture.app.request(`/api/task-relation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer worker-owner-token",
      },
      body: JSON.stringify({
        sourceTaskId: fullId,
        targetTaskId: childId,
        relationType: "subtask",
      }),
    });
    expect(relation.status).toBe(409);

    // Label attach on a child -> 409.
    const [label] = await db
      .insert(schema.labelTable)
      .values({
        name: "agent-label",
        color: "#111111",
        workspaceId: fixture.workerOwner.workspace.id,
      })
      .returning();
    const attachLabel = await fixture.app.request(
      `/api/label/${label?.id}/task`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer worker-owner-token",
        },
        body: JSON.stringify({ taskId: childId }),
      },
    );
    expect(attachLabel.status).toBe(409);

    // Bulk operation touching a child -> 409.
    const bulk = await fixture.app.request(`/api/task/bulk`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer worker-owner-token",
      },
      body: JSON.stringify({
        taskIds: [childId],
        operation: "updatePriority",
        value: "high",
      }),
    });
    expect(bulk.status).toBe(409);

    // Agent principal (API key) status mutation on the FULL task -> 409.
    const agentKey = await createAgentApiKeyFixture(fixture.workerOwner.user);
    const agentStatus = await fixture.app.request(`/api/task/status/${fullId}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-api-key": agentKey,
      },
      body: JSON.stringify({ status: "in-progress" }),
    });
    expect(agentStatus.status).toBe(409);
    expect(await agentStatus.text()).toContain("use_phase_progress");

    // Agent create_task while the FULL graph is active -> 409.
    const agentCreate = await fixture.app.request(
      `/api/task/${fixture.project.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": agentKey,
        },
        body: JSON.stringify({
          title: "smuggled task",
          description: "bypass",
          priority: "low",
          status: "to-do",
        }),
      },
    );
    expect(agentCreate.status).toBe(409);

    // Human session create_task still works (parent authority unaffected).
    const humanCreate = await fixture.app.request(
      `/api/task/${fixture.project.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
        },
        body: JSON.stringify({
          title: "human task",
          description: "parent-owned",
          priority: "low",
          status: "to-do",
        }),
      },
    );
    expect(humanCreate.status).toBe(200);

    // Agent import into a project with an active FULL graph -> 409.
    const agentImport = await fixture.app.request(
      `/api/task/import/${fixture.project.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": agentKey,
        },
        body: JSON.stringify({
          tasks: [{ title: "imported", status: "to-do" }],
        }),
      },
    );
    expect(agentImport.status).toBe(409);
  });

  it("reconciles projections idempotently and renders markers from structured receipts", async () => {
    const fixture = await buildFullRunFixture();
    const childId = fixture.receipt.phaseCards[0].childTaskId;

    const begin1 = await postPhaseProgress(
      fixture,
      { phaseId: "P1", action: "begin" },
      `phase-begin:${randomUUID()}`,
    );
    expect(begin1.status).toBe(200);
    const checkpoint = await createPhaseCheckpointApi(
      fixture,
      "P1",
      sha40("b1"),
      SHA_A,
      `phase-checkpoint:${randomUUID()}`,
    );
    const checkpointBody = (await checkpoint.json()) as { checkpointId: string };
    const complete1 = await postPhaseProgress(
      fixture,
      {
        phaseId: "P1",
        action: "complete",
        checkpointId: checkpointBody.checkpointId,
      },
      `phase-complete:${randomUUID()}`,
    );
    expect(complete1.status).toBe(200);

    // Outbox rows pending before reconcile.
    const pending = await db
      .select()
      .from(schema.executionPhaseProjectionTable)
      .where(
        and(
          eq(
            schema.executionPhaseProjectionTable.fullTaskId,
            fixture.receipt.fullTaskId,
          ),
          eq(schema.executionPhaseProjectionTable.state, "pending"),
        ),
      );
    expect(pending.length).toBeGreaterThan(0);

    const reconcile = await fixture.app.request(
      `/api/execution/task/${fixture.receipt.fullTaskId}/phase-projections/reconcile`,
      {
        method: "POST",
        headers: { Authorization: "Bearer parent-token" },
      },
    );
    expect(reconcile.status).toBe(200);
    const reconcileBody = (await reconcile.json()) as { applied: number };
    expect(reconcileBody.applied).toBeGreaterThan(0);

    // Child card now done + marker comment exists.
    const [child] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, childId));
    expect(child?.status).toBe("done");
    const markers = await db
      .select()
      .from(schema.activityTable)
      .where(eq(schema.activityTable.taskId, childId));
    const markerTexts = markers.map((marker) => marker.content);
    expect(markerTexts.some((text) => text?.includes("[⭕ DOING] P1"))).toBe(
      true,
    );
    expect(markerTexts.some((text) => text?.includes("[✅ DONE] P1"))).toBe(
      true,
    );

    // Reconcile is idempotent: no duplicate markers.
    const reconcile2 = await fixture.app.request(
      `/api/execution/task/${fixture.receipt.fullTaskId}/phase-projections/reconcile`,
      { method: "POST", headers: { Authorization: "Bearer parent-token" } },
    );
    expect(reconcile2.status).toBe(200);
    const markersAfter = await db
      .select()
      .from(schema.activityTable)
      .where(eq(schema.activityTable.taskId, childId));
    expect(markersAfter).toHaveLength(markers.length);
  });

  it("blocks finalization without complete phase proof and resets the ledger on parent reject", async () => {
    const fixture = await buildFullRunFixture();
    const fullTaskId = fixture.receipt.fullTaskId;

    // Complete all three phases with a valid checkpoint chain.
    let token = fixture.run.leaseToken;
    let epoch = fixture.run.leaseEpoch;
    let previousBase = SHA_A;
    for (const [index, card] of fixture.receipt.phaseCards.entries()) {
      const commitSha = sha40(`b${index + 1}`);
      const begin = await postPhaseProgress(
        fixture,
        { phaseId: card.phaseId, action: "begin" },
        `phase-begin:${card.phaseId}-${randomUUID()}`,
        token,
        epoch,
      );
      expect(begin.status).toBe(200);
      const checkpoint = await createPhaseCheckpointApi(
        fixture,
        card.phaseId,
        commitSha,
        previousBase,
        `phase-checkpoint:${card.phaseId}-${randomUUID()}`,
        token,
        epoch,
      );
      expect(checkpoint.status).toBe(200);
      const checkpointBody = (await checkpoint.json()) as {
        checkpointId: string;
      };
      const complete = await postPhaseProgress(
        fixture,
        {
          phaseId: card.phaseId,
          action: "complete",
          checkpointId: checkpointBody.checkpointId,
        },
        `phase-complete:${card.phaseId}-${randomUUID()}`,
        token,
        epoch,
      );
      expect(complete.status).toBe(200);
      previousBase = commitSha;
    }

    // All required phases done: in_review is now allowed (lease deactivates).
    const reportReview = await fixture.app.request(
      `/api/execution/task/${fullTaskId}/runs/${fixture.run.id}/report`,
      {
        method: "POST",
        headers: baseHeaders(
          fixture,
          `report-final-${randomUUID()}`,
          token,
        ),
        body: JSON.stringify({
          leaseEpoch: epoch,
          state: "in_review",
          commitSha: sha40("b3"),
          baseSha: SHA_A,
        }),
      },
    );
    expect(reportReview.status).toBe(200);

    // Parent reject resets the whole ledger to pending atomically.
    const reject = await fixture.app.request(
      `/api/execution/task/${fullTaskId}/runs/${fixture.run.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
          "Idempotency-Key": `reject-${randomUUID()}`,
        },
        body: JSON.stringify({
          decision: "reject",
          reason: "scope drifted",
          reviewHeadSha: sha40("b3"),
        }),
      },
    );
    expect(reject.status).toBe(200);
    const ledger = await db
      .select()
      .from(schema.executionPhaseProgressTable)
      .where(
        eq(schema.executionPhaseProgressTable.fullTaskId, fullTaskId),
      );
    expect(ledger).toHaveLength(3);
    expect(ledger.every((row) => row.state === "pending")).toBe(true);
    expect(
      ledger.every(
        (row) => row.checkpointId === null && row.commitSha === null,
      ),
    ).toBe(true);
    const [resetTask] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, fullTaskId));
    expect(resetTask?.executionState).toBe("ready");
  });

  it("rejects finalization when a required phase lacks checkpoint proof", async () => {
    const fixture = await buildFullRunFixture();
    const fullTaskId = fixture.receipt.fullTaskId;

    // Only P1 completes; P2/P3 stay pending. Force the run in_review so the
    // review route reaches the finalization gate.
    const begin1 = await postPhaseProgress(
      fixture,
      { phaseId: "P1", action: "begin" },
      `phase-begin:${randomUUID()}`,
    );
    expect(begin1.status).toBe(200);
    const checkpoint = await createPhaseCheckpointApi(
      fixture,
      "P1",
      sha40("b1"),
      SHA_A,
      `phase-checkpoint:${randomUUID()}`,
    );
    const checkpointBody = (await checkpoint.json()) as { checkpointId: string };
    const complete1 = await postPhaseProgress(
      fixture,
      {
        phaseId: "P1",
        action: "complete",
        checkpointId: checkpointBody.checkpointId,
      },
      `phase-complete:${randomUUID()}`,
    );
    expect(complete1.status).toBe(200);
    await db
      .update(schema.taskRunTable)
      .set({
        state: "in_review",
        leaseActive: false,
        baseSha: SHA_A,
        commitSha: sha40("b1"),
      })
      .where(eq(schema.taskRunTable.id, fixture.run.id));

    const approve = await fixture.app.request(
      `/api/execution/task/${fullTaskId}/runs/${fixture.run.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
          "Idempotency-Key": `approve-${randomUUID()}`,
        },
        body: JSON.stringify({
          decision: "approve",
          action: "merge",
          reviewHeadSha: sha40("b1"),
          verification: {
            verificationProfile: "kaneo-api-test",
            baseSha: SHA_A,
            commitSha: sha40("b1"),
            changedFiles: UNION_FILES,
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
            mergeCommitSha: sha40("c1"),
          },
        }),
      },
    );
    expect(approve.status).toBe(409);
    expect(await approve.text()).toContain("phase_progress_incomplete");
    const [task] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, fullTaskId));
    expect(task?.status).not.toBe("done");
  });

  it("finalizes the FULL run once every phase is proven and the parent merges", async () => {
    const fixture = await buildFullRunFixture();
    const fullTaskId = fixture.receipt.fullTaskId;
    const token = fixture.run.leaseToken;
    const epoch = fixture.run.leaseEpoch;
    let previousBase = SHA_A;
    for (const [index, card] of fixture.receipt.phaseCards.entries()) {
      const commitSha = sha40(`b${index + 1}`);
      await postPhaseProgress(
        fixture,
        { phaseId: card.phaseId, action: "begin" },
        `phase-begin:${card.phaseId}-${randomUUID()}`,
        token,
        epoch,
      );
      const checkpoint = await createPhaseCheckpointApi(
        fixture,
        card.phaseId,
        commitSha,
        previousBase,
        `phase-checkpoint:${card.phaseId}-${randomUUID()}`,
        token,
        epoch,
      );
      const checkpointBody = (await checkpoint.json()) as {
        checkpointId: string;
      };
      await postPhaseProgress(
        fixture,
        {
          phaseId: card.phaseId,
          action: "complete",
          checkpointId: checkpointBody.checkpointId,
        },
        `phase-complete:${card.phaseId}-${randomUUID()}`,
        token,
        epoch,
      );
      previousBase = commitSha;
    }

    const reportReview = await fixture.app.request(
      `/api/execution/task/${fullTaskId}/runs/${fixture.run.id}/report`,
      {
        method: "POST",
        headers: baseHeaders(fixture, `report-final-${randomUUID()}`, token),
        body: JSON.stringify({
          leaseEpoch: epoch,
          state: "in_review",
          commitSha: sha40("b3"),
          baseSha: SHA_A,
        }),
      },
    );
    expect(reportReview.status).toBe(200);

    const approve = await fixture.app.request(
      `/api/execution/task/${fullTaskId}/runs/${fixture.run.id}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer parent-token",
          "Idempotency-Key": `approve-final-${randomUUID()}`,
        },
        body: JSON.stringify({
          decision: "approve",
          action: "merge",
          reviewHeadSha: sha40("b3"),
          verification: {
            verificationProfile: "kaneo-api-test",
            baseSha: SHA_A,
            commitSha: sha40("b3"),
            changedFiles: UNION_FILES,
            commands: ["pnpm test"],
            diffWithinScope: true,
            branchValid: true,
            testsPassed: true,
          },
          prResult: {
            status: "PASS",
            operation: "merge",
            prNumber: 42,
            prUrl: "https://github.com/owner/repository/pull/42",
            prState: "merged",
            mergeCommitSha: sha40("c9"),
          },
        }),
      },
    );
    expect(approve.status).toBe(200);
    expect(await approve.json()).toMatchObject({
      id: fixture.run.id,
      state: "finalized",
    });
    const [task] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, fullTaskId));
    expect(task?.status).toBe("done");
    expect(task?.executionState).toBe("done");
    const ledger = await db
      .select()
      .from(schema.executionPhaseProgressTable)
      .where(eq(schema.executionPhaseProgressTable.fullTaskId, fullTaskId));
    expect(ledger.every((row) => row.state === "done")).toBe(true);
  });
});
