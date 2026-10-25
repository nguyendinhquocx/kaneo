import { and, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { lockProjectTaskLanes } from "../lock-project-task-lanes";
import { assertTaskAssigneeInWorkspace } from "../validate-task-assignee";
import {
  coercePriority,
  coerceStatus,
  getValidTaskStatuses,
} from "../validate-task-fields";
import { claimTaskNumber } from "./claim-task-numbers";

export type ImportTask = {
  title: string;
  description?: string;
  status: string;
  priority?: string;
  startDate?: string | null;
  dueDate?: string | null;
  userId?: string | null;
};

async function importTasks(
  projectId: string,
  tasksToImport: ImportTask[],
  currentUserId?: string,
) {
  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, projectId),
  });

  if (!project) {
    throw new HTTPException(404, {
      message: "Project not found",
    });
  }

  const validStatuses = await getValidTaskStatuses(projectId);
  const requestedAssigneeIds = [
    ...new Set(
      tasksToImport
        .map((task) => task.userId)
        .filter((userId): userId is string => Boolean(userId)),
    ),
  ];
  for (const assigneeId of requestedAssigneeIds) {
    await assertTaskAssigneeInWorkspace(db, assigneeId, project.workspaceId);
  }

  const results = [];

  for (const taskData of tasksToImport) {
    try {
      const { status, warning: statusWarning } = coerceStatus(
        taskData.status,
        validStatuses,
      );
      const { priority, warning: priorityWarning } = coercePriority(
        taskData.priority || "low",
      );
      const warnings = [statusWarning, priorityWarning].filter(Boolean);

      const createdTask = await db.transaction(async (tx) => {
        await lockProjectTaskLanes(tx, [projectId]);
        if (taskData.userId) {
          await assertTaskAssigneeInWorkspace(
            tx,
            taskData.userId,
            project.workspaceId,
          );
        }
        const taskNumber = await claimTaskNumber(projectId, tx);
        const [column] = await tx
          .select({ id: columnTable.id })
          .from(columnTable)
          .where(
            and(
              eq(columnTable.projectId, projectId),
              eq(columnTable.slug, status),
            ),
          )
          .limit(1);
        const [maxPositionResult] = await tx
          .select({ maxPosition: max(taskTable.position) })
          .from(taskTable)
          .where(
            and(
              eq(taskTable.projectId, projectId),
              column?.id
                ? eq(taskTable.columnId, column.id)
                : eq(taskTable.status, status),
            ),
          );
        const [task] = await tx
          .insert(taskTable)
          .values({
            projectId,
            userId: taskData.userId || null,
            title: taskData.title,
            status,
            columnId: column?.id ?? null,
            startDate: taskData.startDate ? new Date(taskData.startDate) : null,
            dueDate: taskData.dueDate ? new Date(taskData.dueDate) : null,
            description: taskData.description || "",
            priority,
            number: taskNumber,
            position: (maxPositionResult?.maxPosition ?? 0) + 1,
          })
          .returning();
        return task;
      });

      if (createdTask) {
        await publishEvent("task.created", {
          ...createdTask,
          taskId: createdTask.id,
          userId: createdTask.userId ?? "",
          currentUserId: currentUserId ?? "",
          type: "create",
          content: "imported the task",
        });

        results.push({
          success: true,
          task: createdTask,
          ...(warnings.length > 0 && { warnings }),
        });
      } else {
        results.push({
          success: false,
          error: "Failed to create task",
          task: taskData,
        });
      }
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      results.push({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        task: taskData,
      });
    }
  }

  return {
    importedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
    },
    results: {
      total: tasksToImport.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      tasks: results,
    },
  };
}

export default importTasks;
