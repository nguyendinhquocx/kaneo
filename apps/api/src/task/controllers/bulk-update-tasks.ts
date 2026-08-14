import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  labelTable,
  projectTable,
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

async function bulkUpdateTasks({
  taskIds,
  operation,
  value,
  userId,
}: {
  taskIds: string[];
  operation: BulkOperation;
  value?: string | null;
  userId: string;
}) {
  const tasks = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      projectId: taskTable.projectId,
      userId: taskTable.userId,
      dueDate: taskTable.dueDate,
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
        const rows = await lockTasksForStatusMutation(
          tx,
          tasks.map((task) => task.id),
        );
        if (rows.length !== tasks.length) {
          throw new HTTPException(404, { message: "No tasks found" });
        }

        const projectIds = [...new Set(rows.map((task) => task.projectId))];
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

          const [updated] = await tx
            .update(taskTable)
            .set({ status: value, columnId: column?.id ?? null })
            .where(eq(taskTable.id, task.id))
            .returning();
          if (!updated) {
            throw new HTTPException(500, {
              message: "Failed to update task status",
            });
          }
          updatedRows.push({
            id: updated.id,
            projectId: updated.projectId,
            status: updated.status,
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

      const result = await db
        .update(taskTable)
        .set({ priority: value })
        .where(inArray(taskTable.id, foundIds));

      updatedCount = result.rowCount ?? foundIds.length;

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

      const result = await db
        .update(taskTable)
        .set({ userId: value || null })
        .where(inArray(taskTable.id, foundIds));

      updatedCount = result.rowCount ?? foundIds.length;

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
      const result = await db
        .delete(taskTable)
        .where(inArray(taskTable.id, foundIds));

      updatedCount = result.rowCount ?? foundIds.length;

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

      const result = await db
        .update(taskTable)
        .set({ dueDate: parsedDate })
        .where(inArray(taskTable.id, foundIds));

      updatedCount = result.rowCount ?? foundIds.length;

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
