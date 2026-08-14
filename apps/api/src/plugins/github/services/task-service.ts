import type { InferSelectModel } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import db from "../../../database";
import {
  columnTable,
  integrationTable,
  taskTable,
} from "../../../database/schema";
import { assertFinalTaskStatusGate } from "../../../execution/finalization-gate";

export type TaskRow = InferSelectModel<typeof taskTable>;

export type UpdateTaskStatusResult =
  | { applied: false }
  | { applied: true; before: TaskRow; after: TaskRow };

const NON_COLUMN_STATUSES = new Set(["planned", "archived"]);

export async function findTaskByNumber(projectId: string, taskNumber: number) {
  return db.query.taskTable.findFirst({
    where: and(
      eq(taskTable.projectId, projectId),
      eq(taskTable.number, taskNumber),
    ),
  });
}

export async function findTaskById(taskId: string) {
  return db.query.taskTable.findFirst({
    where: eq(taskTable.id, taskId),
  });
}

export async function updateTaskStatus(
  taskId: string,
  newStatus: string,
): Promise<UpdateTaskStatusResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .limit(1)
      .for("update");

    if (!task) {
      return { applied: false };
    }

    let columnId: string | null = null;

    const [column] = await tx
      .select()
      .from(columnTable)
      .where(
        and(
          eq(columnTable.projectId, task.projectId),
          eq(columnTable.slug, newStatus),
        ),
      )
      .limit(1);

    if (column) {
      columnId = column.id;
    } else if (!NON_COLUMN_STATUSES.has(newStatus)) {
      console.warn(
        `[Integration] Skipping status update for task ${taskId}: column "${newStatus}" not found in project ${task.projectId}`,
      );
      return { applied: false };
    }

    // GitHub webhooks are external status writers. They must use the same
    // parent-review gate as REST and bulk status mutation, while the task row
    // lock serializes this check against review/claim transactions.
    try {
      await assertFinalTaskStatusGate(tx, {
        taskId,
        status: newStatus,
        isFinalColumn: column?.isFinal === true,
      });
    } catch (error) {
      if (error instanceof Error) {
        console.warn(
          `[Integration] Skipping final status update for task ${taskId}: ${error.message}`,
        );
      }
      return { applied: false };
    }

    const [after] = await tx
      .update(taskTable)
      .set({ status: newStatus, columnId })
      .where(eq(taskTable.id, taskId))
      .returning();

    if (!after) {
      return { applied: false };
    }

    return { applied: true, before: task, after };
  });
}

export async function isTaskInFinalState(task: {
  projectId: string;
  status: string;
  columnId: string | null;
}): Promise<boolean> {
  if (task.columnId) {
    const columnById = await db.query.columnTable.findFirst({
      where: and(
        eq(columnTable.id, task.columnId),
        eq(columnTable.projectId, task.projectId),
      ),
    });

    if (columnById) {
      return columnById.isFinal;
    }
  }

  const columnByStatus = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, task.projectId),
      eq(columnTable.slug, task.status),
    ),
  });

  if (columnByStatus) {
    return columnByStatus.isFinal;
  }

  return task.status === "done";
}

export async function getIntegrationWithProject(integrationId: string) {
  return db.query.integrationTable.findFirst({
    where: eq(integrationTable.id, integrationId),
    with: {
      project: true,
    },
  });
}

export async function findIntegrationByRepo(owner: string, repo: string) {
  const integrations = await findAllIntegrationsByRepo(owner, repo);
  return integrations[0] || null;
}

export async function findAllIntegrationsByRepo(owner: string, repo: string) {
  const integrations = await db.query.integrationTable.findMany({
    where: and(
      eq(integrationTable.type, "github"),
      eq(integrationTable.isActive, true),
    ),
    with: {
      project: true,
    },
  });

  return integrations.filter((integration) => {
    try {
      const config = JSON.parse(integration.config);
      return config.repositoryOwner === owner && config.repositoryName === repo;
    } catch {
      return false;
    }
  });
}
