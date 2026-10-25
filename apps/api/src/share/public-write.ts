import { and, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { isProjectAgentControlled } from "../project/controllers/public-project-dto";
import { deleteOrphanedAssets } from "../storage/cleanup-assets";
import { claimTaskNumber } from "../task/controllers/claim-task-numbers";
import { lockProjectTaskLanes } from "../task/lock-project-task-lanes";
import {
  assertValidPriority,
  assertValidTaskStatus,
  VIRTUAL_STATUSES,
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
// SPEC-2026-10-22 full-project-share-link: every audit row now commits inside
// the same transaction as its mutation — an audit failure rolls back the
// mutation instead of leaving unattributed data behind.

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
  // P2-F1 fix: virtual statuses hide tasks from the board — not part of the
  // "basic task fields" an edit link grants.
  if (VIRTUAL_STATUSES.includes(status as (typeof VIRTUAL_STATUSES)[number])) {
    throw new HTTPException(400, {
      message: "Public links cannot set planned or archived status",
    });
  }

  const created = await db.transaction(async (tx) => {
    await lockProjectTaskLanes(tx, [link.resourceId]);
    const taskNumber = await claimTaskNumber(link.resourceId, tx);
    const [column] = await tx
      .select({ id: schema.columnTable.id })
      .from(schema.columnTable)
      .where(
        and(
          eq(schema.columnTable.projectId, link.resourceId),
          eq(schema.columnTable.slug, status),
        ),
      )
      .limit(1);
    if (!column) {
      throw new HTTPException(400, { message: "Invalid task status" });
    }
    const [maxPositionResult] = await tx
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
    // Atomic mutation + audit: a failed audit insert rolls back the task.
    await appendShareActionAudit(link, "task.create", tx);
    return task;
  });

  if (!created) {
    throw new HTTPException(500, { message: "Failed to create task" });
  }

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
    if (
      VIRTUAL_STATUSES.includes(
        body.status as (typeof VIRTUAL_STATUSES)[number],
      )
    ) {
      throw new HTTPException(400, {
        message: "Public links cannot set planned or archived status",
      });
    }
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

  const [updated] = await db.transaction(async (tx) => {
    if (updates.status !== undefined) {
      await lockProjectTaskLanes(tx, [link.resourceId]);
      const [targetColumn] = await tx
        .select({ id: schema.columnTable.id })
        .from(schema.columnTable)
        .where(
          and(
            eq(schema.columnTable.projectId, link.resourceId),
            eq(schema.columnTable.slug, updates.status),
          ),
        )
        .limit(1);
      if (!targetColumn) {
        throw new HTTPException(400, { message: "Invalid task status" });
      }
      const [maxPositionResult] = await tx
        .select({ maxPosition: max(schema.taskTable.position) })
        .from(schema.taskTable)
        .where(
          and(
            eq(schema.taskTable.projectId, link.resourceId),
            targetColumn?.id
              ? eq(schema.taskTable.columnId, targetColumn.id)
              : eq(schema.taskTable.status, updates.status),
          ),
        );
      updates.columnId = targetColumn?.id ?? null;
      updates.position = (maxPositionResult?.maxPosition ?? 0) + 1;
    }
    const [row] = await tx
      .update(schema.taskTable)
      .set(updates)
      .where(
        and(
          eq(schema.taskTable.id, taskId),
          eq(schema.taskTable.projectId, link.resourceId),
        ),
      )
      .returning();
    if (!row) {
      return [] as typeof row[];
    }
    await appendShareActionAudit(link, "task.update", tx);
    return [row];
  });
  if (!updated) {
    throw new HTTPException(404, { message: "Not found" });
  }

  if (task.description !== updated.description) {
    deleteOrphanedAssets(task.description, updated.description, {
      taskId,
    }).catch(() => {});
  }
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

  const [updated] = await db.transaction(async (tx) => {
    const [row] = await tx
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
    if (!row) {
      return [] as typeof row[];
    }
    await appendShareActionAudit(link, "document.update", tx);
    return [row];
  });
  if (!updated) {
    throw new HTTPException(409, {
      message: "Document was modified by someone else",
    });
  }

    if (document.content !== updated.content) {
      deleteOrphanedAssets(document.content, updated.content, {
        documentId: document.id,
      }).catch(() => {});
    }
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

  // P2-F2 fix: serialize the flip like the authenticated path so concurrent
  // anonymous submits cannot read the same state and cancel each other out.
  const row = await db.transaction(async (tx) => {
    const locked = existing
      ? (
          await tx
            .select()
            .from(schema.goalCheckinTable)
            .where(eq(schema.goalCheckinTable.id, existing.id))
            .for("update")
            .limit(1)
        )[0]
      : undefined;

    if (locked) {
      const [updated] = await tx
        .update(schema.goalCheckinTable)
        .set({
          // Anonymous writes are attributed to the link, not a user.
          completed: !locked.completed,
          checkedByUserId: null,
        })
        .where(eq(schema.goalCheckinTable.id, locked.id))
        .returning();
      await appendShareActionAudit(link, "goal.checkin.toggle", tx);
      return updated;
    }

    const [inserted] = await tx
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
    if (inserted) {
      await appendShareActionAudit(link, "goal.checkin.toggle", tx);
      return inserted;
    }

    // Lost a race with a concurrent insert: lock and flip.
    const [raced] = await tx
      .select()
      .from(schema.goalCheckinTable)
      .where(
        and(
          eq(schema.goalCheckinTable.goalId, link.resourceId),
          eq(schema.goalCheckinTable.checkInDate, date),
        ),
      )
      .for("update")
      .limit(1);
    if (!raced) {
      throw new HTTPException(500, { message: "Check-in race lost" });
    }
    const [updated] = await tx
      .update(schema.goalCheckinTable)
      .set({ completed: !raced.completed, checkedByUserId: null })
      .where(eq(schema.goalCheckinTable.id, raced.id))
      .returning();
    await appendShareActionAudit(link, "goal.checkin.toggle", tx);
    return updated;
  });

  if (!row) {
    throw new HTTPException(500, { message: "Failed to toggle check-in" });
  }

  return {
    id: row.id,
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

  const [updated] = await db.transaction(async (tx) => {
    const [row] = await tx
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
    if (!row) {
      return [] as typeof row[];
    }
    await appendShareActionAudit(link, "goal.checkin.note", tx);
    return [row];
  });
  if (!updated) {
    throw new HTTPException(409, {
      message: "Note was modified by someone else",
    });
  }

  if (checkin.note !== updated.note) {
    deleteOrphanedAssets(checkin.note, updated.note, {
      goalCheckinId: checkin.id,
    }).catch(() => {});
  }
  return {
    checkInDate: updated.checkInDate,
    completed: updated.completed,
    note: updated.note,
    noteRevision: updated.noteRevision,
  };
}
