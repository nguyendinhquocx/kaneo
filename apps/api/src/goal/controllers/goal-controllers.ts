import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";
import { hasUserWorkspacePermission } from "../../utils/require-workspace-permission";

// SPEC-2026-10-08-kaneo-workspace-collaboration T5: goals are workspace-level
// recurring trackers — not tasks, not video records. Check-ins use DATE
// strings (YYYY-MM-DD), never timestamps, so a stored day never shifts when
// read from another timezone.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDateString(value: string): string {
  if (!DATE_RE.test(value)) {
    throw new HTTPException(400, {
      message: "Date must be a calendar date formatted YYYY-MM-DD",
    });
  }
  return value;
}

export type GoalRow = typeof schema.goalTable.$inferSelect;

export async function createGoal(input: {
  workspaceId: string;
  ownerUserId: string;
  name: string;
  visibility: string;
  projectId?: string | null;
  targetPerWeek?: number | null;
  timezone: string;
  position?: number;
}) {
  const [goal] = await db
    .insert(schema.goalTable)
    .values({
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      name: input.name,
      visibility: input.visibility,
      projectId: input.projectId ?? null,
      targetPerWeek: input.targetPerWeek ?? null,
      timezone: input.timezone,
      position: input.position ?? 0,
    })
    .returning();

  if (!goal) {
    throw new HTTPException(500, { message: "Failed to create goal" });
  }
  return goal;
}

// Private goals are visible to their owner only; workspace-shared goals are
// readable by every workspace member (membership already verified upstream).
export function canReadGoal(goal: GoalRow, userId: string): boolean {
  return goal.visibility !== "private" || goal.ownerUserId === userId;
}

// Write access: the owner always can; collaborators with task:update can write
// workspace-shared goals (role matrix stays untouched).
export async function canWriteGoal(
  goal: GoalRow,
  userId: string,
): Promise<boolean> {
  if (goal.ownerUserId === userId) {
    return true;
  }
  if (goal.visibility !== "workspace") {
    return false;
  }
  return hasUserWorkspacePermission(userId, goal.workspaceId, {
    task: ["update"],
  });
}

export function assertNotArchived(goal: GoalRow) {
  if (goal.archivedAt !== null) {
    throw new HTTPException(409, {
      message: "Goal is archived; restore it to record check-ins",
    });
  }
}

export async function getGoal(goalId: string): Promise<GoalRow> {
  const [goal] = await db
    .select()
    .from(schema.goalTable)
    .where(eq(schema.goalTable.id, goalId))
    .limit(1);
  if (!goal) {
    throw new HTTPException(404, { message: "Goal not found" });
  }
  return goal;
}

export async function listGoalsForWorkspace(
  workspaceId: string,
  userId: string,
  options?: { includeArchived?: boolean },
) {
  const goals = await db
    .select()
    .from(schema.goalTable)
    .where(eq(schema.goalTable.workspaceId, workspaceId))
    .orderBy(asc(schema.goalTable.position), asc(schema.goalTable.createdAt));

  return goals.filter((goal) => {
    if (!canReadGoal(goal, userId)) {
      return false;
    }
    if (!options?.includeArchived && goal.archivedAt !== null) {
      return false;
    }
    return true;
  });
}

export async function getCheckinsInRange(
  goalIds: string[],
  from: string,
  to: string,
) {
  if (goalIds.length === 0) {
    return new Map<
      string,
      Array<typeof schema.goalCheckinTable.$inferSelect>
    >();
  }
  const rows = await db
    .select()
    .from(schema.goalCheckinTable)
    .where(
      and(
        inArray(schema.goalCheckinTable.goalId, goalIds),
        gte(schema.goalCheckinTable.checkInDate, from),
        lte(schema.goalCheckinTable.checkInDate, to),
      ),
    )
    .orderBy(asc(schema.goalCheckinTable.checkInDate));

  const byGoal = new Map<
    string,
    Array<typeof schema.goalCheckinTable.$inferSelect>
  >();
  for (const row of rows) {
    const list = byGoal.get(row.goalId) ?? [];
    list.push(row);
    byGoal.set(row.goalId, list);
  }
  return byGoal;
}

export async function updateGoal(
  goalId: string,
  updates: Partial<{
    name: string;
    visibility: string;
    projectId: string | null;
    targetPerWeek: number | null;
    timezone: string;
    position: number;
  }>,
) {
  const [updated] = await db
    .update(schema.goalTable)
    .set(updates)
    .where(eq(schema.goalTable.id, goalId))
    .returning();
  if (!updated) {
    throw new HTTPException(404, { message: "Goal not found" });
  }
  return updated;
}

export async function setGoalArchived(goalId: string, archived: boolean) {
  const [updated] = await db
    .update(schema.goalTable)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(schema.goalTable.id, goalId))
    .returning();
  if (!updated) {
    throw new HTTPException(404, { message: "Goal not found" });
  }
  return updated;
}

// Toggle semantics: existing row flips completed, missing row is created as
// completed. The row is never deleted, so history (and the note) survives.
// Concurrent submits are serialized with SELECT ... FOR UPDATE; both requests
// succeed and exactly one row exists afterwards.
export async function toggleCheckin(
  goalId: string,
  checkInDate: string,
  userId: string,
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.goalCheckinTable)
      .where(
        and(
          eq(schema.goalCheckinTable.goalId, goalId),
          eq(schema.goalCheckinTable.checkInDate, checkInDate),
        ),
      )
      .for("update")
      .limit(1);

    if (existing) {
      const [updated] = await tx
        .update(schema.goalCheckinTable)
        .set({
          completed: !existing.completed,
          checkedByUserId: userId,
        })
        .where(eq(schema.goalCheckinTable.id, existing.id))
        .returning();
      return { row: updated, toggledOff: existing.completed === true };
    }

    const [inserted] = await tx
      .insert(schema.goalCheckinTable)
      .values({
        goalId,
        checkInDate,
        completed: true,
        checkedByUserId: userId,
        note: "",
        noteRevision: 1,
      })
      .onConflictDoNothing({
        target: [
          schema.goalCheckinTable.goalId,
          schema.goalCheckinTable.checkInDate,
        ],
      })
      .returning();

    if (inserted) {
      return { row: inserted, toggledOff: false };
    }

    // Lost a race with a concurrent insert: fall back to a locked re-read.
    const [raced] = await tx
      .select()
      .from(schema.goalCheckinTable)
      .where(
        and(
          eq(schema.goalCheckinTable.goalId, goalId),
          eq(schema.goalCheckinTable.checkInDate, checkInDate),
        ),
      )
      .for("update")
      .limit(1);
    if (!raced) {
      throw new HTTPException(500, { message: "Check-in race lost" });
    }
    const [updated] = await tx
      .update(schema.goalCheckinTable)
      .set({
        completed: !raced.completed,
        checkedByUserId: userId,
      })
      .where(eq(schema.goalCheckinTable.id, raced.id))
      .returning();
    return { row: updated, toggledOff: raced.completed === true };
  });
}

export async function getGoalCheckin(checkinId: string) {
  const [checkin] = await db
    .select()
    .from(schema.goalCheckinTable)
    .where(eq(schema.goalCheckinTable.id, checkinId))
    .limit(1);
  if (!checkin) {
    throw new HTTPException(404, { message: "Check-in not found" });
  }
  return checkin;
}

export async function updateCheckinNote(
  checkinId: string,
  note: string,
  expectedRevision: number,
) {
  const [updated] = await db
    .update(schema.goalCheckinTable)
    .set({
      note,
      noteRevision: expectedRevision + 1,
    })
    .where(
      and(
        eq(schema.goalCheckinTable.id, checkinId),
        eq(schema.goalCheckinTable.noteRevision, expectedRevision),
      ),
    )
    .returning();

  if (!updated) {
    throw new HTTPException(409, {
      message: "Note was modified by someone else",
    });
  }
  return updated;
}
