import { and, eq, inArray, isNull, max, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  labelTable,
  projectTable,
  shareLinkTable,
  taskTable,
  userTable,
  workspaceUserTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import {
  assertFinalTaskStatusGate,
  lockTasksForStatusMutation,
} from "../../execution/finalization-gate";
import { assertUserWorkspacePermission } from "../../utils/require-workspace-permission";
import { contentRevisionConflict, parseExpectedContentRevision } from "../content-revision";
import { lockProjectTaskLanes } from "../lock-project-task-lanes";
import { assertTaskAssigneeInWorkspace } from "../validate-task-assignee";
import { assertValidPriority, VIRTUAL_STATUSES } from "../validate-task-fields";

type BulkOperation =
  | "updateStatus"
  | "updatePriority"
  | "updateAssignee"
  | "delete"
  | "addLabel"
  | "removeLabel"
  | "updateDueDate";

// Per-task CAS field update for bulk writes. A zero-row update means the card
// changed between the client's read and this write: fail with the current
// revision instead of silently overwriting.
async function casBulkFieldUpdate({
  tasks,
  revisions,
  apply,
}: {
  tasks: Array<{
    id: string;
    projectId: string;
    contentRevision: number;
  }>;
  revisions: Map<string, number>;
  apply: (
    task: { id: string; projectId: string; contentRevision: number },
    nextContentRevision: number,
  ) => { set: Record<string, unknown>; where: SQL | undefined };
}): Promise<number> {
  let updated = 0;
  for (const task of tasks) {
    const { set, where } = apply(task, task.contentRevision + 1);
    const [row] = await db
      .update(taskTable)
      .set(set as never)
      .where(where)
      .returning({ id: taskTable.id });
    if (!row) {
      throw contentRevisionConflict(task.contentRevision);
    }
    updated++;
  }
  return updated;
}

async function bulkUpdateTasks({
  taskIds,
  operation,
  value,
  userId,
  expectedContentRevisions,
}: {
  taskIds: string[];
  operation: BulkOperation;
  value?: string | null;
  userId: string;
  expectedContentRevisions?: Record<string, number>;
}) {
  // Task-field bulk writes are CAS-guarded per task: the client sends the
  // revision it read for every card it wants to change. Label and delete
  // operations are not content-field edits and stay outside the CAS.
  const needsContentCas =
    operation === "updateStatus" ||
    operation === "updatePriority" ||
    operation === "updateAssignee" ||
    operation === "updateDueDate";
  const revisions = new Map<string, number>();
  if (needsContentCas) {
    if (
      !expectedContentRevisions ||
      typeof expectedContentRevisions !== "object"
    ) {
      throw new HTTPException(400, {
        message:
          "expectedContentRevisions (taskId -> revision) is required for this bulk operation",
      });
    }
    for (const taskId of taskIds) {
      const raw = (expectedContentRevisions as Record<string, unknown>)[taskId];
      revisions.set(taskId, parseExpectedContentRevision(raw));
    }
  }
  const tasks = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      projectId: taskTable.projectId,
      userId: taskTable.userId,
      dueDate: taskTable.dueDate,
      contentRevision: taskTable.contentRevision,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(inArray(taskTable.id, taskIds));

  if (tasks.length === 0) {
    throw new HTTPException(404, {
      message: "No tasks found",
    });
  }

  const workspaceIds = [...new Set(tasks.map((t) => t.workspaceId))];

  if (workspaceIds.length > 1) {
    throw new HTTPException(400, {
      message: "All tasks must belong to the same workspace",
    });
  }

  const workspaceId = workspaceIds[0];

  if (!workspaceId) {
    throw new HTTPException(400, {
      message: "Could not determine workspace",
    });
  }

  const [membership] = await db
    .select({ role: workspaceUserTable.role })
    .from(workspaceUserTable)
    .where(
      and(
        eq(workspaceUserTable.userId, userId),
        eq(workspaceUserTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new HTTPException(403, {
      message: "You don't have access to this workspace",
    });
  }

  const requiredPermission =
    operation === "delete"
      ? { task: ["delete"] }
      : operation === "updateAssignee"
        ? { task: ["assign"] }
        : { task: ["update"] };
  await assertUserWorkspacePermission(userId, workspaceId, requiredPermission);

  const foundIds = tasks.map((t) => t.id);
  let updatedCount = 0;

  switch (operation) {
    case "updateStatus": {
      if (!value) {
        throw new HTTPException(400, { message: "Status value is required" });
      }

      const lockedTasks = await db.transaction(async (tx) => {
        const projectIds = [...new Set(tasks.map((task) => task.projectId))];
        await lockProjectTaskLanes(tx, projectIds);
        const rows = await lockTasksForStatusMutation(
          tx,
          tasks.map((task) => task.id),
        );
        if (rows.length !== tasks.length) {
          throw new HTTPException(404, { message: "No tasks found" });
        }

        if (rows.some((task) => !projectIds.includes(task.projectId))) {
          throw new HTTPException(409, {
            message: "A task moved projects; refresh and retry the update",
          });
        }
        const columns = await tx
          .select({
            id: columnTable.id,
            projectId: columnTable.projectId,
            slug: columnTable.slug,
            isFinal: columnTable.isFinal,
          })
          .from(columnTable)
          .where(inArray(columnTable.projectId, projectIds));

        const updatedRows: typeof rows = [];
        const nextPositions = new Map<string, number>();
        for (const task of rows) {
          const column = columns.find(
            (candidate) =>
              candidate.projectId === task.projectId &&
              candidate.slug === value,
          );
          if (!column && !VIRTUAL_STATUSES.includes(value as never)) {
            throw new HTTPException(400, {
              message: `Invalid status "${value}" for project ${task.projectId}`,
            });
          }

          await assertFinalTaskStatusGate(tx, {
            taskId: task.id,
            status: value,
            isFinalColumn: column?.isFinal === true,
          });

          let position = task.position;
          if (task.status !== value) {
            const laneKey = `${task.projectId}:${value}`;
            let nextPosition = nextPositions.get(laneKey);
            if (nextPosition === undefined) {
              const [maxPositionResult] = await tx
                .select({ maxPosition: max(taskTable.position) })
                .from(taskTable)
                .where(
                  and(
                    eq(taskTable.projectId, task.projectId),
                    column?.id
                      ? eq(taskTable.columnId, column.id)
                      : eq(taskTable.status, value),
                  ),
                );
              nextPosition = (maxPositionResult?.maxPosition ?? 0) + 1;
            }
            position = nextPosition;
            nextPositions.set(laneKey, nextPosition + 1);
          }

          const [updated] = await tx
            .update(taskTable)
            .set({
              status: value,
              columnId: column?.id ?? null,
              position,
              contentRevision: task.contentRevision + 1,
            })
            .where(
              and(
                eq(taskTable.id, task.id),
                eq(taskTable.contentRevision, revisions.get(task.id) ?? -1),
              ),
            )
            .returning();
          if (!updated) {
            throw contentRevisionConflict(task.contentRevision);
          }
          updatedRows.push({
            id: updated.id,
            projectId: updated.projectId,
            status: updated.status,
            position: updated.position,
            contentRevision: updated.contentRevision,
          });
        }
        return updatedRows;
      });

      updatedCount = lockedTasks.length;
      for (const task of lockedTasks) {
        await publishEvent("task.status_changed", {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          newStatus: value,
          type: "status_changed",
        });
      }

      for (const projectId of [
        ...new Set(lockedTasks.map((t) => t.projectId)),
      ]) {
        await publishEvent("task-relation.refresh", {
          projectId,
          userId,
        });
      }
      break;
    }

    case "updatePriority": {
      if (!value) {
        throw new HTTPException(400, { message: "Priority value is required" });
      }
      assertValidPriority(value);

      updatedCount = await casBulkFieldUpdate({
        tasks,
        revisions,
        apply: (task, nextContentRevision) => ({
          set: { priority: value as string, contentRevision: nextContentRevision },
          where: and(
            eq(taskTable.id, task.id),
            eq(taskTable.contentRevision, revisions.get(task.id) ?? -1),
          ),
        }),
      });

      for (const task of tasks) {
        await publishEvent("task.priority_changed", {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          newPriority: value,
          type: "priority_changed",
        });
      }
      break;
    }

    case "updateAssignee": {
      await assertTaskAssigneeInWorkspace(db, value, workspaceId);
      const newAssigneeName = value
        ? (
            await db
              .select({ name: userTable.name })
              .from(userTable)
              .where(eq(userTable.id, value))
              .limit(1)
          )[0]?.name
        : undefined;

      updatedCount = await casBulkFieldUpdate({
        tasks,
        revisions,
        apply: (task, nextContentRevision) => ({
          set: { userId: (value || null) as string | null, contentRevision: nextContentRevision },
          where: and(
            eq(taskTable.id, task.id),
            eq(taskTable.contentRevision, revisions.get(task.id) ?? -1),
          ),
        }),
      });

      for (const task of tasks) {
        const eventType = value ? "task.assignee_changed" : "task.unassigned";
        await publishEvent(eventType, {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          oldAssignee: task.userId,
          newAssignee: newAssigneeName,
          newAssigneeId: value || null,
          title: task.title,
          type: value ? "assignee_changed" : "unassigned",
        });
      }
      break;
    }

    case "delete": {
      // Deleting cards kills their task-scoped share links in the same
      // transaction, mirroring the single-delete route.
      const deletedCount = await db.transaction(async (tx) => {
        const result = await tx
          .delete(taskTable)
          .where(inArray(taskTable.id, foundIds))
          .returning({ id: taskTable.id });
        if (result.length > 0) {
          await tx
            .update(shareLinkTable)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(shareLinkTable.resourceType, "task"),
                inArray(shareLinkTable.resourceId, result.map((row) => row.id)),
                isNull(shareLinkTable.revokedAt),
              ),
            );
        }
        return result.length;
      });

      updatedCount = deletedCount;

      for (const task of tasks) {
        await publishEvent("task.deleted", {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          title: task.title,
        });
      }
      break;
    }

    case "addLabel": {
      if (!value) {
        throw new HTTPException(400, { message: "Label ID is required" });
      }

      const label = await db.query.labelTable.findFirst({
        where: and(
          eq(labelTable.id, value),
          eq(labelTable.workspaceId, workspaceId),
        ),
      });

      if (!label) {
        throw new HTTPException(404, { message: "Label not found" });
      }

      for (const task of tasks) {
        const existingAssignment = await db.query.labelTable.findFirst({
          where: and(
            eq(labelTable.name, label.name),
            eq(labelTable.taskId, task.id),
          ),
        });

        if (!existingAssignment) {
          await db
            .insert(labelTable)
            .values({
              name: label.name,
              color: label.color,
              workspaceId: workspaceId,
              taskId: task.id,
            })
            .onConflictDoNothing({
              target: [labelTable.taskId, labelTable.name],
            });
          updatedCount++;

          await publishEvent("task.label_assigned", {
            projectId: task.projectId,
            taskId: task.id,
            userId,
            type: "label_assigned",
          });
        }
      }
      break;
    }

    case "removeLabel": {
      if (!value) {
        throw new HTTPException(400, { message: "Label ID is required" });
      }
      const result = await db
        .update(labelTable)
        .set({ taskId: null })
        .where(
          and(eq(labelTable.id, value), inArray(labelTable.taskId, foundIds)),
        );

      updatedCount = result.rowCount ?? foundIds.length;

      for (const task of tasks) {
        await publishEvent("task.label_unassigned", {
          projectId: task.projectId,
          taskId: task.id,
          userId,
          type: "label_unassigned",
        });
      }
      break;
    }

    case "updateDueDate": {
      let parsedDate: Date | null = null;
      if (value) {
        parsedDate = new Date(value);
        if (Number.isNaN(parsedDate.getTime())) {
          throw new HTTPException(400, {
            message: `Invalid date value "${value}"`,
          });
        }
      }

      updatedCount = await casBulkFieldUpdate({
        tasks,
        revisions,
        apply: (task, nextContentRevision) => ({
          set: { dueDate: parsedDate, contentRevision: nextContentRevision },
          where: and(
            eq(taskTable.id, task.id),
            eq(taskTable.contentRevision, revisions.get(task.id) ?? -1),
          ),
        }),
      });

      for (const task of tasks) {
        await publishEvent("task.due_date_changed", {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          oldDueDate: task.dueDate,
          newDueDate: parsedDate,
          title: task.title,
          type: "due_date_changed",
        });
      }
      break;
    }

    default: {
      throw new HTTPException(400, {
        message: `Unknown operation "${operation}"`,
      });
    }
  }

  return { success: true, updatedCount };
}

export default bulkUpdateTasks;
