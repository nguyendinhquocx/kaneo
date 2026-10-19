import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function seedGoal(
  workspaceId: string,
  ownerUserId: string,
  overrides?: Partial<{
    name: string;
    visibility: string;
    projectId: string | null;
    archivedAt: Date;
    targetPerWeek: number;
    timezone: string;
  }>,
) {
  const [goal] = await db
    .insert(schema.goalTable)
    .values({
      workspaceId,
      ownerUserId,
      name: overrides?.name ?? "Make a video",
      visibility: overrides?.visibility ?? "private",
      projectId: overrides?.projectId ?? null,
      targetPerWeek: overrides?.targetPerWeek ?? null,
      timezone: overrides?.timezone ?? "Asia/Ho_Chi_Minh",
      archivedAt: overrides?.archivedAt,
    })
    .returning();
  if (!goal) {
    throw new Error("Failed to seed goal");
  }
  return goal;
}

describe("API integration: goals and check-ins", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("owner creates a private goal and only the owner can read it", async () => {
    const owner = await createWorkspaceMember({ role: "member" });
    const teammate = await createWorkspaceMember({ role: "member" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: owner.workspace.id,
      userId: teammate.user.id,
      role: "member",
      joinedAt: new Date(),
    });

    mockAuthenticatedSession(owner.user);
    const { app } = createApp();
    const created = await app.request("/api/goal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: owner.workspace.id,
        name: "Make a video",
        timezone: "Asia/Ho_Chi_Minh",
        targetPerWeek: 5,
      }),
    });
    expect(created.status).toBe(200);
    const goal = (await created.json()) as {
      id: string;
      visibility: string;
      timezone: string;
    };
    expect(goal.visibility).toBe("private");
    expect(goal.timezone).toBe("Asia/Ho_Chi_Minh");

    // Owner sees it in the list.
    const ownerList = await app.request(
      `/api/goal?workspaceId=${owner.workspace.id}`,
    );
    const ownerGoals = (await ownerList.json()) as Array<{ id: string }>;
    expect(ownerGoals).toHaveLength(1);

    // Teammate does not see the private goal.
    mockAuthenticatedSession(teammate.user);
    const { app: app2 } = createApp();
    const mateList = await app2.request(
      `/api/goal?workspaceId=${owner.workspace.id}`,
    );
    const mateGoals = (await mateList.json()) as Array<{ id: string }>;
    expect(mateGoals).toHaveLength(0);

    // Teammate cannot toggle or read the private goal either.
    const denied = await app2.request(`/api/goal/${goal.id}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-12" }),
    });
    expect(denied.status).toBe(404);
    const hiddenHistory = await app2.request(`/api/goal/${goal.id}/checkins`);
    expect(hiddenHistory.status).toBe(404);
  });

  it("check-in toggles with DATE values, keeps history and supports CAS notes", async () => {
    const owner = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: owner.workspace.id,
    });
    const goal = await seedGoal(owner.workspace.id, owner.user.id, {
      projectId: project.id,
      visibility: "workspace",
      targetPerWeek: 3,
    });

    mockAuthenticatedSession(owner.user);
    const { app } = createApp();

    // Toggle on.
    const on = await app.request(`/api/goal/${goal.id}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-12" }),
    });
    expect(on.status).toBe(200);
    const onRow = (await on.json()) as {
      id: string;
      completed: boolean;
      checkInDate: string;
      checkedByUserId: string;
      noteRevision: number;
    };
    expect(onRow.completed).toBe(true);
    // DATE boundary: the stored value is the same calendar date string.
    expect(onRow.checkInDate).toBe("2026-10-12");
    expect(onRow.checkedByUserId).toBe(owner.user.id);

    // Add a note with CAS.
    const noted = await app.request(`/api/goal/checkin/${onRow.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        note: "Recorded guitar take",
        noteRevision: 1,
      }),
    });
    expect(noted.status).toBe(200);
    const notedRow = (await noted.json()) as { noteRevision: number };
    expect(notedRow.noteRevision).toBe(2);

    // Stale note revision conflicts.
    const staleNote = await app.request(`/api/goal/checkin/${onRow.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        note: "Overwrite attempt",
        noteRevision: 1,
      }),
    });
    expect(staleNote.status).toBe(409);

    // Untick: completed=false, row and note survive.
    const off = await app.request(`/api/goal/${goal.id}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-12" }),
    });
    expect(off.status).toBe(200);
    const offRow = (await off.json()) as {
      completed: boolean;
      note: string;
    };
    expect(offRow.completed).toBe(false);
    expect(offRow.note).toBe("Recorded guitar take");

    // Range listing aggregates totals from rows (not a cached counter).
    const list = await app.request(
      `/api/goal?workspaceId=${owner.workspace.id}&from=2026-10-05&to=2026-10-11`,
    );
    const goals = (await list.json()) as Array<{
      id: string;
      totalCompleted: number;
      checkins: Array<{ checkInDate: string; completed: boolean }>;
    }>;
    const weekGoal = goals.find((g) => g.id === goal.id);
    expect(weekGoal).toBeDefined();
    // 2026-10-12 is outside 05-11, so the range list has zero completed days.
    expect(weekGoal?.totalCompleted).toBe(0);

    const list2 = await app.request(
      `/api/goal?workspaceId=${owner.workspace.id}&from=2026-10-05&to=2026-10-18`,
    );
    const goals2 = (await list2.json()) as Array<{
      id: string;
      totalCompleted: number;
      checkins: number;
    }>;
    const wideGoal = goals2.find((g) => g.id === goal.id);
    expect(wideGoal?.totalCompleted).toBe(0);
    expect(wideGoal?.checkins).toHaveLength(1);
  });

  it("reports all-time totals and exposes full note history without ticking note-only days", async () => {
    const owner = await createWorkspaceMember({ role: "member" });
    const goal = await seedGoal(owner.workspace.id, owner.user.id, {
      visibility: "workspace",
    });
    mockAuthenticatedSession(owner.user);
    const { app } = createApp();

    const postCheckin = (date: string, ensureOnly = false) =>
      app.request(`/api/goal/${goal.id}/checkin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date,
          ...(ensureOnly ? { ensureOnly: true } : {}),
        }),
      });

    // One completion in an earlier week and one in the viewed week.
    expect((await postCheckin("2026-10-05")).status).toBe(200);
    expect((await postCheckin("2026-10-12")).status).toBe(200);

    // A note-only row is idempotent and must not toggle a day to completed.
    const noteOnly = await postCheckin("2026-10-13", true);
    expect(noteOnly.status).toBe(200);
    expect(((await noteOnly.json()) as { completed: boolean }).completed).toBe(
      false,
    );
    const ensureExisting = await postCheckin("2026-10-13", true);
    expect(
      ((await ensureExisting.json()) as { completed: boolean }).completed,
    ).toBe(false);

    const rangeResponse = await app.request(
      `/api/goal?workspaceId=${owner.workspace.id}&from=2026-10-12&to=2026-10-18`,
    );
    const rangeGoals = (await rangeResponse.json()) as Array<{
      id: string;
      totalCompleted: number;
      totalAllTime: number;
    }>;
    const viewedGoal = rangeGoals.find((item) => item.id === goal.id);
    expect(viewedGoal?.totalCompleted).toBe(1);
    expect(viewedGoal?.totalAllTime).toBe(2);

    const history = await app.request(`/api/goal/${goal.id}/checkins`);
    expect(history.status).toBe(200);
    const rows = (await history.json()) as Array<{
      checkInDate: string;
      completed: boolean;
    }>;
    expect(rows.map((row) => [row.checkInDate, row.completed])).toEqual([
      ["2026-10-05", true],
      ["2026-10-12", true],
      ["2026-10-13", false],
    ]);
  });

  it("shared goal can be ticked by a collaborator with task:update but not a viewer", async () => {
    const owner = await createWorkspaceMember({ role: "admin" });
    const member = await createWorkspaceMember({ role: "member" });
    const viewer = await createWorkspaceMember({ role: "viewer" });
    for (const mate of [member, viewer]) {
      await db.insert(schema.workspaceUserTable).values({
        workspaceId: owner.workspace.id,
        userId: mate.user.id,
        role: mate === member ? "member" : "viewer",
        joinedAt: new Date(),
      });
    }
    const goal = await seedGoal(owner.workspace.id, owner.user.id, {
      visibility: "workspace",
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const tick = await app.request(`/api/goal/${goal.id}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-13" }),
    });
    expect(tick.status).toBe(200);

    mockAuthenticatedSession(viewer.user);
    const { app: app2 } = createApp();
    const denied = await app2.request(`/api/goal/${goal.id}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-13" }),
    });
    expect(denied.status).toBe(403);
  });

  it("concurrent toggles keep exactly one row per goal/day", async () => {
    const owner = await createWorkspaceMember({ role: "member" });
    const goal = await seedGoal(owner.workspace.id, owner.user.id, {
      visibility: "workspace",
    });

    mockAuthenticatedSession(owner.user);
    const { app } = createApp();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request(`/api/goal/${goal.id}/checkin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ date: "2026-10-12" }),
        }),
      ),
    );
    for (const response of results) {
      expect(response.status).toBe(200);
    }

    const rows = await db
      .select()
      .from(schema.goalCheckinTable)
      .where(eq(schema.goalCheckinTable.goalId, goal.id));
    expect(rows).toHaveLength(1);
  });

  it("archive hides the goal and blocks new writes while history remains", async () => {
    const owner = await createWorkspaceMember({ role: "member" });
    const goal = await seedGoal(owner.workspace.id, owner.user.id);
    mockAuthenticatedSession(owner.user);
    let { app } = createApp();

    const tick = await app.request(`/api/goal/${goal.id}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-12" }),
    });
    expect(tick.status).toBe(200);

    const archived = await app.request(`/api/goal/${goal.id}/archive`, {
      method: "PUT",
    });
    expect(archived.status).toBe(200);

    // Active list hides it; archived list shows it with history.
    ({ app } = createApp());
    const active = await app.request(
      `/api/goal?workspaceId=${owner.workspace.id}`,
    );
    const activeGoals = (await active.json()) as Array<{ id: string }>;
    expect(activeGoals.find((g) => g.id === goal.id)).toBeUndefined();

    const archivedList = await app.request(
      `/api/goal?workspaceId=${owner.workspace.id}&includeArchived=true`,
    );
    const archivedGoals = (await archivedList.json()) as Array<{
      id: string;
      archivedAt: string | null;
    }>;
    const found = archivedGoals.find((g) => g.id === goal.id);
    expect(found?.archivedAt).not.toBeNull();

    // Writes are blocked while archived.
    const blocked = await app.request(`/api/goal/${goal.id}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-14" }),
    });
    expect(blocked.status).toBe(409);

    // Restore brings it back to the active list.
    const restored = await app.request(`/api/goal/${goal.id}/unarchive`, {
      method: "PUT",
    });
    expect(restored.status).toBe(200);
    const activeAgain = await app.request(
      `/api/goal?workspaceId=${owner.workspace.id}`,
    );
    const activeAgainGoals = (await activeAgain.json()) as Array<{
      id: string;
    }>;
    expect(activeAgainGoals.find((g) => g.id === goal.id)).toBeDefined();
  });

  it("goal share link exposes check-ins of exactly that goal", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const goal = await seedGoal(admin.workspace.id, admin.user.id, {
      visibility: "workspace",
      name: "Practice guitar",
    });
    await db.insert(schema.goalCheckinTable).values({
      goalId: goal.id,
      checkInDate: "2026-10-12",
      completed: true,
      checkedByUserId: admin.user.id,
      note: "Fingerstyle practice",
      noteRevision: 1,
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const createResponse = await app.request("/api/share-manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "goal",
        resourceId: goal.id,
        permission: "view",
      }),
    });
    expect(createResponse.status).toBe(200);
    const link = (await createResponse.json()) as { token: string };

    mockAnonymousSession();
    ({ app } = createApp());
    const read = await app.request(`/api/share/goal/${link.token}`);
    expect(read.status).toBe(200);
    const payload = (await read.json()) as {
      id: string;
      name: string;
      checkins: Array<{ checkInDate: string; completed: boolean }>;
    };
    expect(payload.id).toBe(goal.id);
    expect(payload.name).toBe("Practice guitar");
    expect(payload.checkins).toHaveLength(1);
    expect(payload.checkins[0]?.checkInDate).toBe("2026-10-12");
  });

  it("R2-T6 goal delete: owner and task:delete admins can; task:update collaborators cannot", async () => {
    const owner = await createWorkspaceMember({ role: "member" });
    const teammate = await createWorkspaceMember({ role: "member" });
    const admin = await createWorkspaceMember({ role: "admin" });
    await db.insert(schema.workspaceUserTable).values([
      {
        workspaceId: owner.workspace.id,
        userId: teammate.user.id,
        role: "member",
        joinedAt: new Date(),
      },
      {
        workspaceId: owner.workspace.id,
        userId: admin.user.id,
        role: "admin",
        joinedAt: new Date(),
      },
    ]);
    const goal = await seedGoal(owner.workspace.id, owner.user.id, {
      visibility: "workspace",
    });
    await db.insert(schema.goalCheckinTable).values({
      goalId: goal.id,
      checkInDate: "2026-10-12",
      completed: true,
    });

    // Collaborator with task:update cannot hard-delete someone else's goal.
    mockAuthenticatedSession(teammate.user);
    const { app: teammateApp } = createApp();
    const denied = await teammateApp.request(`/api/goal/${goal.id}`, {
      method: "DELETE",
    });
    expect(denied.status).toBe(403);
    const stillThere = await db
      .select()
      .from(schema.goalTable)
      .where(eq(schema.goalTable.id, goal.id));
    expect(stillThere).toHaveLength(1);

    // Admin (task:delete) can; check-ins cascade.
    mockAuthenticatedSession(admin.user);
    const { app: adminApp } = createApp();
    const deleted = await adminApp.request(`/api/goal/${goal.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const goneGoal = await db
      .select()
      .from(schema.goalTable)
      .where(eq(schema.goalTable.id, goal.id));
    expect(goneGoal).toHaveLength(0);
    const goneCheckins = await db
      .select()
      .from(schema.goalCheckinTable)
      .where(eq(schema.goalCheckinTable.goalId, goal.id));
    expect(goneCheckins).toHaveLength(0);

    // Owner deletes their own goal without any workspace role gate.
    const ownGoal = await seedGoal(owner.workspace.id, owner.user.id, {
      name: "Second",
    });
    mockAuthenticatedSession(owner.user);
    const { app: ownerApp } = createApp();
    const own = await ownerApp.request(`/api/goal/${ownGoal.id}`, {
      method: "DELETE",
    });
    expect(own.status).toBe(200);

    // Unknown id 404s at the controller; the workspace-access middleware
    // fail-closes unresolvable ids earlier with 400.
    const missing = await ownerApp.request("/api/goal/does-not-exist", {
      method: "DELETE",
    });
    expect([400, 404]).toContain(missing.status);
  });
});
