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

// SPEC-2026-11-10 UAT bug A (iss_20261116113108): multi-field subtask update
// (priority + startDate + dueDate) must behave like single-field updates and
// must never surface a raw 500 for bad client input.

async function bindCard(
  app: ReturnType<typeof createApp>["app"],
  taskId: string,
  userId: string,
) {
  const [principal] = await db
    .insert(schema.agentPrincipalTable)
    .values({
      userId,
      runtimeId: `pi-subtask-${Math.random().toString(36).slice(2, 8)}`,
      hostId: "test-host",
      scopes: ["run:claim"],
      isActive: true,
    })
    .returning();
  if (!principal) throw new Error("Principal fixture failed to create");
  const response = await app.request("/api/agent-session/bindings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId,
      agentPrincipalId: principal.id,
      sessionId: "pi-subtask-session",
    }),
  });
  if (response.status !== 200) {
    throw new Error(
      `bind failed ${response.status}: '${await response.text()}'`,
    );
  }
  return (await response.json()) as {
    bindingId: string;
    bindingGeneration: number;
  };
}

async function setupBoundSubtask() {
  const admin = await createWorkspaceMember({ role: "admin" });
  const { project } = await createProjectFixture({
    workspaceId: admin.workspace.id,
  });
  const [root] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Subtask update root",
      status: "to-do",
      number: null,
    })
    .returning();
  if (!root) throw new Error("Root fixture failed to create");

  mockAuthenticatedSession(admin.user);
  const { app } = createApp();
  const binding = await bindCard(app, root.id, admin.user.id);
  const ctx = {
    bindingId: binding.bindingId,
    sessionId: "pi-subtask-session",
    generation: binding.bindingGeneration,
  };

  const created = await app.request("/api/agent-session/card/subtasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...ctx,
      title: "Fresh subtask",
      expectedParentContentRevision: 1,
    }),
  });
  expect(created.status).toBe(200);
  const createBody = (await created.json()) as {
    subtask: { id: string; contentRevision: number };
    parentContentRevision: number;
  };

  const updateSubtask = async (
    patch: Record<string, unknown>,
    expectedContentRevision: number,
  ) => {
    const response = await app.request(
      `/api/agent-session/card/subtasks/${createBody.subtask.id}/update`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...ctx, patch, expectedContentRevision }),
      },
    );
    const bodyText = await response.text();
    let body: Record<string, unknown> | string;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      // HTTPException errors are plain-text responses by contract.
      body = bodyText;
    }
    return {
      status: response.status,
      body,
      bodyText,
    };
  };

  return {
    subtaskId: createBody.subtask.id,
    initialRevision: createBody.subtask.contentRevision,
    updateSubtask,
    root,
  };
}

describe("API integration: agent session subtask update (UAT bug A)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("updates priority, startDate and dueDate in one patch", async () => {
    const { subtaskId, updateSubtask, initialRevision } =
      await setupBoundSubtask();

    const combo = await updateSubtask(
      {
        priority: "high",
        startDate: "2026-11-20",
        dueDate: "2026-11-25",
      },
      initialRevision,
    );

    expect(combo.status).toBe(200);
    expect(combo.body).toMatchObject({ contentRevision: initialRevision + 1 });

    const [row] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, subtaskId))
      .limit(1);

    // The combined write must persist every field, not partially.
    expect(row?.priority).toBe("high");
    expect(row?.startDate?.toISOString()).toContain("2026-11-20");
    expect(row?.dueDate?.toISOString()).toContain("2026-11-25");
  });

  it("still accepts single-field updates (baseline for the regression)", async () => {
    const { updateSubtask, initialRevision } = await setupBoundSubtask();

    const priorityOnly = await updateSubtask(
      { priority: "urgent" },
      initialRevision,
    );
    expect(priorityOnly.status).toBe(200);

    const datesOnly = await updateSubtask(
      { startDate: "2026-12-01", dueDate: "2026-12-05" },
      initialRevision + 1,
    );
    expect(datesOnly.status).toBe(200);
  });

  it("clears dates with null and keeps the other fields", async () => {
    const { updateSubtask, initialRevision } = await setupBoundSubtask();

    const set = await updateSubtask(
      { priority: "low", startDate: "2026-11-20", dueDate: "2026-11-25" },
      initialRevision,
    );
    expect(set.status).toBe(200);

    const cleared = await updateSubtask(
      { startDate: null, dueDate: null },
      initialRevision + 1,
    );
    expect(cleared.status).toBe(200);
  });

  it("rejects an unparsable date with 400 and does not partially apply", async () => {
    const { subtaskId, updateSubtask, initialRevision } =
      await setupBoundSubtask();

    const bad = await updateSubtask(
      {
        priority: "medium",
        startDate: "20/11/2026",
        dueDate: "25/11/2026",
      },
      initialRevision,
    );

    expect(bad.status).toBe(400);
    expect(bad.bodyText).toContain("startDate");

    // Nothing from the bad patch may be applied.
    const [row] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, subtaskId))
      .limit(1);
    expect(row?.priority).toBe("no-priority");
    expect(row?.contentRevision).toBe(initialRevision);
  });

  it("rejects an unparsable date even in a single-field patch with 400", async () => {
    const { updateSubtask, initialRevision } = await setupBoundSubtask();

    const badSingle = await updateSubtask(
      { dueDate: "31/12/2026" },
      initialRevision,
    );

    expect(badSingle.status).toBe(400);
    expect(badSingle.bodyText).toContain("dueDate");
  });

  // SPEC-2026-11-18-kaneo-glanceable-progress: the bound agent sets native
  // ⭕/✅ marker cues on subtasks so the board reads at a glance. The patch
  // field mirrors the root work-markers route: normalized map + CAS revision.
  it("persists workMarkerCounts and returns the fresh revision", async () => {
    const { subtaskId, updateSubtask, initialRevision } =
      await setupBoundSubtask();

    const inProgress = await updateSubtask(
      { workMarkerCounts: { redCircle: 3 } },
      initialRevision,
    );

    expect(inProgress.status).toBe(200);
    expect(inProgress.body).toMatchObject({
      contentRevision: initialRevision + 1,
    });

    const [row] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, subtaskId))
      .limit(1);
    expect(row?.workMarkerCounts).toMatchObject({ redCircle: 3 });

    const done = await updateSubtask(
      { workMarkerCounts: { greenCheck: 3 } },
      initialRevision + 1,
    );
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ contentRevision: initialRevision + 2 });

    const [after] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, subtaskId))
      .limit(1);
    expect(after?.workMarkerCounts).toMatchObject({
      greenCheck: 3,
      redCircle: 0,
    });
  });

  it("rejects a stale revision for a marker-only patch with 409", async () => {
    const { updateSubtask, initialRevision } = await setupBoundSubtask();

    const first = await updateSubtask(
      { workMarkerCounts: { redCircle: 3 } },
      initialRevision,
    );
    expect(first.status).toBe(200);

    const stale = await updateSubtask(
      { workMarkerCounts: { greenCheck: 3 } },
      initialRevision,
    );
    expect(stale.status).toBe(409);
  });

  it("normalizes unknown marker keys instead of persisting them", async () => {
    const { subtaskId, updateSubtask, initialRevision } =
      await setupBoundSubtask();

    const weird = await updateSubtask(
      {
        workMarkerCounts: {
          redCircle: 2,
          nonsense: 9,
        },
      },
      initialRevision,
    );

    expect(weird.status).toBe(200);
    const [row] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, subtaskId))
      .limit(1);
    const counts = row?.workMarkerCounts as Record<string, number>;
    expect(counts.redCircle).toBe(2);
    expect(Object.keys(counts).sort()).toEqual(
      ["boxedRedCross", "greenCheck", "redCircle", "redCross"].sort(),
    );
  });
});
