import { and, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { isProjectAgentControlled } from "../project/controllers/public-project-dto";
import { claimTaskNumber } from "../task/controllers/claim-task-numbers";
import {
  assertValidPriority,
  assertValidTaskStatus,
} from "../task/validate-task-fields";
import {
  appendShareActionAudit,
  type ResolvedShareLink,
} from "./resolve-share-link";

// SPEC-2026-10-08-kaneo-workspace-collaboration T7: anonymous writes through
// capability links. Bearer permission by design — every mutation is audited
// by share-link ID and the action surface is the minimum viable: basic task
// fields, document content CAS, goal check-in toggle/note. No deletes, no
// assignment, no settings, no agent control.

function agentControlledRefusal() {
  return new HTTPException(403, {
    message:
      "This project is agent-controlled and does not accept public edits. Ask the owner for a workspace invite.",
  });
}

export async function publicCreateTask(
  link: ResolvedShareLink,
  body: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    startDate?: string;
    dueDate?: string;
  },
) {
  if (await isProjectAgentControlled(link.resourceId)) {
    throw agentControlledRefusal();
  }

  const status = body.status || "to-do";
  const priority = body.priority || "no-priority";
  await assertValidTaskStatus(status, link.resourceId);
  assertValidPriority(priority);

  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(schema.columnTable.projectId, link.resourceId),
      eq(schema.columnTable.slug, status),
    ),
  });

  const [maxPositionResult] = await db
    .select({ maxPosition: max(schema.taskTable.position) })
    .from(schema.taskTable)
    .where(
      and(
        eq(schema.taskTable.projectId, link.resourceId),
        column?.id
          ? eq(schema.taskTable.columnId, column.id)
          : eq(schema.taskTable.status, status),
      ),
    );
  const nextPosition = (maxPositionResult?.maxPosition ?? 0) + 1;

  const created = await db.transaction(async (tx) => {
    const taskNumber = await claimTaskNumber(link.resourceId, tx);

    const [task] = await tx
      .insert(schema.taskTable)
      .values({
        projectId: link.resourceId,
        // Anonymous writes never assign a workspace user.
        userId: null,
        title: body.title,
        description: body.description ?? "",
        status,
        columnId: column?.id ?? null,
        position: nextPosition,
        startDate: body.startDate ? new Date(body.startDate) : null,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        priority,
        number: taskNumber,
      })
      .returning();
    return task;
  });

  if (!created) {
    throw new HTTPException(500, { message: "Failed to create task" });
  }

  await appendShareActionAudit(link, "task.create");
  return {
    id: created.id,
    title: created.title,
    number: created.number,
    status: created.status,
    priority: created.priority,
  };
}

export async function publicUpdateTask(
  link: ResolvedShareLink,
  taskId: string,
  body: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    startDate?: string | null;
    dueDate?: string | null;
  },
) {
  if (await isProjectAgentControlled(link.resourceId)) {
    throw agentControlledRefusal();
  }

  const [task] = await db
    .select()
    .from(schema.taskTable)
    .where(
      and(
        eq(schema.taskTable.id, taskId),
        eq(schema.taskTable.projectId, link.resourceId),
      ),
    )
    .limit(1);
  if (!task) {
    throw new HTTPException(404, { message: "Not found" });
  }

  const updates: Partial<typeof schema.taskTable.$inferInsert> = {};
  if (body.title !== undefined) {
    updates.title = body.title;
  }
  if (body.description !== undefined) {
    updates.description = body.description;
  }
  if (body.priority !== undefined) {
    assertValidPriority(body.priority);
    updates.priority = body.priority;
  }
  if (body.status !== undefined && body.status !== task.status) {
    await assertValidTaskStatus(body.status, link.resourceId);
    const column = await db.query.columnTable.findFirst({
      where: and(
        eq(schema.columnTable.projectId, link.resourceId),
        eq(schema.columnTable.slug, body.status),
      ),
    });
    updates.status = body.status;
    updates.columnId = column?.id ?? null;
  }
  if (body.startDate !== undefined) {
    updates.startDate = body.startDate ? new Date(body.startDate) : null;
  }
  if (body.dueDate !== undefined) {
    updates.dueDate = body.dueDate ? new Date(body.dueDate) : null;
  }

  const [updated] = await db
    .update(schema.taskTable)
    .set(updates)
    .where(
      and(
        eq(schema.taskTable.id, taskId),
        eq(schema.taskTable.projectId, link.resourceId),
      ),
    )
    .returning();
  if (!updated) {
    throw new HTTPException(404, { message: "Not found" });
  }

  await appendShareActionAudit(link, "task.update");
  return {
    id: updated.id,
    title: updated.title,
    number: updated.number,
    status: updated.status,
    priority: updated.priority,
  };
}

export async function publicUpdateDocument(
  link: ResolvedShareLink,
  body: { title: string; content: string; revision: number },
) {
  const [document] = await db
    .select()
    .from(schema.documentTable)
    .where(eq(schema.documentTable.id, link.resourceId))
    .limit(1);
  if (!document || document.archivedAt !== null) {
    throw new HTTPException(404, { message: "Not found" });
  }

  const [updated] = await db
    .update(schema.documentTable)
    .set({
      title: body.title,
      content: body.content,
      revision: body.revision + 1,
    })
    .where(
      and(
        eq(schema.documentTable.id, link.resourceId),
        eq(schema.documentTable.revision, body.revision),
      ),
    )
    .returning();
  if (!updated) {
    throw new HTTPException(409, {
      message: "Document was modified by someone else",
    });
  }

  await appendShareActionAudit(link, "document.update");
  return {
    id: updated.id,
    title: updated.title,
    content: updated.content,
    revision: updated.revision,
  };
}

export async function publicToggleGoalCheckin(
  link: ResolvedShareLink,
  date: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HTTPException(400, {
      message: "Date must be a calendar date formatted YYYY-MM-DD",
    });
  }

  const [goal] = await db
    .select()
    .from(schema.goalTable)
    .where(eq(schema.goalTable.id, link.resourceId))
    .limit(1);
  if (!goal) {
    throw new HTTPException(404, { message: "Not found" });
  }
  if (goal.archivedAt !== null) {
    throw new HTTPException(409, {
      message: "Goal is archived",
    });
  }

  const [existing] = await db
    .select()
    .from(schema.goalCheckinTable)
    .where(
      and(
        eq(schema.goalCheckinTable.goalId, link.resourceId),
        eq(schema.goalCheckinTable.checkInDate, date),
      ),
    )
    .limit(1);

  let row: typeof schema.goalCheckinTable.$inferSelect | undefined;
  if (existing) {
    [row] = await db
      .update(schema.goalCheckinTable)
      .set({
        // Anonymous writes are attributed to the link, not a user.
        completed: !existing.completed,
        checkedByUserId: null,
      })
      .where(eq(schema.goalCheckinTable.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(schema.goalCheckinTable)
      .values({
        goalId: link.resourceId,
        checkInDate: date,
        completed: true,
        checkedByUserId: null,
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
    if (!row) {
      // Lost a race: re-read and flip.
      const [raced] = await db
        .select()
        .from(schema.goalCheckinTable)
        .where(
          and(
            eq(schema.goalCheckinTable.goalId, link.resourceId),
            eq(schema.goalCheckinTable.checkInDate, date),
          ),
        )
        .limit(1);
      if (!raced) {
        throw new HTTPException(500, { message: "Check-in race lost" });
      }
      [row] = await db
        .update(schema.goalCheckinTable)
        .set({ completed: !raced.completed, checkedByUserId: null })
        .where(eq(schema.goalCheckinTable.id, raced.id))
        .returning();
    }
  }
  if (!row) {
    throw new HTTPException(500, { message: "Failed to toggle check-in" });
  }

  await appendShareActionAudit(link, "goal.checkin.toggle");
  return {
    checkInDate: row.checkInDate,
    completed: row.completed,
    note: row.note,
    noteRevision: row.noteRevision,
  };
}

export async function publicUpdateGoalNote(
  link: ResolvedShareLink,
  checkinId: string,
  body: { note: string; noteRevision: number },
) {
  const [checkin] = await db
    .select()
    .from(schema.goalCheckinTable)
    .where(
      and(
        eq(schema.goalCheckinTable.id, checkinId),
        eq(schema.goalCheckinTable.goalId, link.resourceId),
      ),
    )
    .limit(1);
  if (!checkin) {
    throw new HTTPException(404, { message: "Not found" });
  }

  const [updated] = await db
    .update(schema.goalCheckinTable)
    .set({
      note: body.note,
      noteRevision: body.noteRevision + 1,
    })
    .where(
      and(
        eq(schema.goalCheckinTable.id, checkinId),
        eq(schema.goalCheckinTable.noteRevision, body.noteRevision),
      ),
    )
    .returning();
  if (!updated) {
    throw new HTTPException(409, {
      message: "Note was modified by someone else",
    });
  }

  await appendShareActionAudit(link, "goal.checkin.note");
  return {
    checkInDate: updated.checkInDate,
    completed: updated.completed,
    note: updated.note,
    noteRevision: updated.noteRevision,
  };
}
