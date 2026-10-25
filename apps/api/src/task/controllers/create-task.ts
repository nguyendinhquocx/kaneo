import { and, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable, userTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { assertTaskAssigneeInWorkspace } from "../validate-task-assignee";
import { assertValidTaskStatus } from "../validate-task-fields";
import { lockProjectTaskLanes } from "../lock-project-task-lanes";
import { claimTaskNumber } from "./claim-task-numbers";

async function createTask({
  projectId,
  workspaceId,
  currentUserId,
  userId,
  title,
  status,
  startDate,
  dueDate,
  description,
  priority,
}: {
  projectId: string;
  workspaceId: string;
  currentUserId: string;
  userId?: string;
  title: string;
  status: string;
  startDate?: Date;
  dueDate?: Date;
  description?: string;
  priority?: string;
}) {
  const resolvedStatus = status || "to-do";
  const resolvedPriority = priority || "no-priority";

  await assertValidTaskStatus(resolvedStatus, projectId);

  const [assignee] = await db
    .select({ name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, userId ?? ""));

  const createdTask = await db.transaction(async (tx) => {
    await lockProjectTaskLanes(tx, [projectId]);
    await assertTaskAssigneeInWorkspace(tx, userId, workspaceId);
    const taskNumber = await claimTaskNumber(projectId, tx);
    const [column] = await tx
      .select({ id: columnTable.id })
      .from(columnTable)
      .where(
        and(
          eq(columnTable.projectId, projectId),
          eq(columnTable.slug, resolvedStatus),
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
            : eq(taskTable.status, resolvedStatus),
        ),
      );
    const nextPosition = (maxPositionResult?.maxPosition ?? 0) + 1;

    const [task] = await tx
      .insert(taskTable)
      .values({
        projectId,
        userId: userId || null,
        title: title || "",
        status: resolvedStatus,
        columnId: column?.id ?? null,
        startDate: startDate || null,
        dueDate: dueDate || null,
        description: description || "",
        priority: resolvedPriority,
        number: taskNumber,
        position: nextPosition,
      })
      .returning();

    return task;
  });

  if (!createdTask) {
    throw new HTTPException(500, {
      message: "Failed to create task",
    });
  }

  await publishEvent("task.created", {
    ...createdTask,
    taskId: createdTask.id,
    userId: createdTask.userId ?? "",
    currentUserId: currentUserId,
    type: "created",
    content: null,
  });

  return {
    ...createdTask,
    assigneeName: assignee?.name,
  };
}

export default createTask;
