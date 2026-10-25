import { and, eq, inArray, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  assetTable,
  executionScheduleTable,
  taskRelationTable,
  taskRunTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { assertBulkTaskIdsGuard } from "../../execution/phase-progress";
import { lockProjectTaskLanes } from "../lock-project-task-lanes";
import { deleteS3Keys } from "../../storage/cleanup-assets";
import getTask from "./get-task";

const unsafeSubtaskTreeMessage =
  "Cannot delete this task tree because a child is shared, belongs to another project, or has an invalid subtask relation";
const executionManagedTreeMessage =
  "Cannot delete child tasks that have execution runs or schedules";

async function deleteTask(
  taskId: string,
  currentUserId: string,
  actorIsAgent = false,
) {
  // Keep the API response shape stable; the transaction below rechecks and
  // locks the row before deleting anything.
  const task = await getTask(taskId);

  const deletion = await db.transaction(async (tx) => {
    await lockProjectTaskLanes(tx, [task.projectId]);
    const [lockedRoot] = await tx
      .select({ id: taskTable.id, projectId: taskTable.projectId })
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .for("update")
      .limit(1);

    if (!lockedRoot || lockedRoot.projectId !== task.projectId) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    const taskIds = new Set([lockedRoot.id]);
    // Only walk explicit subtask edges. Related/blocks links never imply
    // ownership and must not cause their target tasks to be deleted.
    let frontier = [lockedRoot.id];
    while (frontier.length > 0) {
      const childRelations = await tx
        .select({
          sourceTaskId: taskRelationTable.sourceTaskId,
          targetTaskId: taskRelationTable.targetTaskId,
          relationType: taskRelationTable.relationType,
        })
        .from(taskRelationTable)
        .where(
          and(
            inArray(taskRelationTable.sourceTaskId, frontier),
            eq(taskRelationTable.relationType, "subtask"),
          ),
        )
        .for("update");

      if (childRelations.some((relation) => relation.targetTaskId === taskId)) {
        throw new HTTPException(409, {
          message: "Cannot delete a cyclic subtask tree",
        });
      }

      const unseenChildIds = [
        ...new Set(
          childRelations
            .map((relation) => relation.targetTaskId)
            .filter((childId) => !taskIds.has(childId)),
        ),
      ];
      if (unseenChildIds.length === 0) {
        frontier = [];
        continue;
      }

      const childTasks = await tx
        .select({
          id: taskTable.id,
          projectId: taskTable.projectId,
          title: taskTable.title,
        })
        .from(taskTable)
        .where(inArray(taskTable.id, unseenChildIds))
        .for("update");

      if (childTasks.length !== unseenChildIds.length) {
        throw new HTTPException(409, {
          message: "Cannot delete a subtask tree with missing tasks",
        });
      }

      for (const child of childTasks) {
        if (child.projectId !== lockedRoot.projectId) {
          throw new HTTPException(409, {
            message: unsafeSubtaskTreeMessage,
          });
        }
        taskIds.add(child.id);
      }
      frontier = childTasks.map((child) => child.id);
    }

    const descendantIds = [...taskIds].filter((id) => id !== lockedRoot.id);
    if (descendantIds.length > 0) {
      const incomingSubtaskRelations = await tx
        .select({
          sourceTaskId: taskRelationTable.sourceTaskId,
          targetTaskId: taskRelationTable.targetTaskId,
        })
        .from(taskRelationTable)
        .where(
          and(
            eq(taskRelationTable.relationType, "subtask"),
            inArray(taskRelationTable.targetTaskId, descendantIds),
          ),
        )
        .for("update");
      const incomingByChild = new Map<string, string[]>();
      for (const relation of incomingSubtaskRelations) {
        const parents = incomingByChild.get(relation.targetTaskId) ?? [];
        parents.push(relation.sourceTaskId);
        incomingByChild.set(relation.targetTaskId, parents);
      }

      for (const descendantId of descendantIds) {
        const parents = incomingByChild.get(descendantId) ?? [];
        if (
          parents.length !== 1 ||
          parents[0] === descendantId ||
          !taskIds.has(parents[0] ?? "")
        ) {
          throw new HTTPException(409, {
            message: unsafeSubtaskTreeMessage,
          });
        }
      }
    }

    const deletionIds = [...taskIds].sort();
    await assertBulkTaskIdsGuard(tx, {
      taskIds: deletionIds,
      actorIsAgent,
    });

    // Deleting a task cascades these rows in PostgreSQL. Refuse the whole tree
    // first so a normal card delete cannot erase execution history/schedules.
    const guardedExecutionTaskIds = descendantIds.length > 0 ? deletionIds : [];
    const taskRuns =
      guardedExecutionTaskIds.length > 0
        ? await tx
            .select({ id: taskRunTable.id })
            .from(taskRunTable)
            .where(inArray(taskRunTable.taskId, guardedExecutionTaskIds))
            .limit(1)
            .for("update")
        : [];
    const schedules =
      guardedExecutionTaskIds.length > 0
        ? await tx
            .select({ id: executionScheduleTable.id })
            .from(executionScheduleTable)
            .where(
              inArray(executionScheduleTable.taskId, guardedExecutionTaskIds),
            )
            .limit(1)
            .for("update")
        : [];
    if (taskRuns.length > 0 || schedules.length > 0) {
      throw new HTTPException(409, {
        message: executionManagedTreeMessage,
      });
    }

    const relations = await tx
      .select()
      .from(taskRelationTable)
      .where(
        or(
          inArray(taskRelationTable.sourceTaskId, deletionIds),
          inArray(taskRelationTable.targetTaskId, deletionIds),
        ),
      )
      .for("update");
    const assetRows = await tx
      .select({ objectKey: assetTable.objectKey })
      .from(assetTable)
      .where(inArray(assetTable.taskId, deletionIds))
      .for("update");

    const relatedTaskIds = [
      ...new Set([
        ...relations.map((relation) => relation.sourceTaskId),
        ...relations.map((relation) => relation.targetTaskId),
      ]),
    ];
    const relatedTasks =
      relatedTaskIds.length > 0
        ? await tx
            .select({ id: taskTable.id, projectId: taskTable.projectId })
            .from(taskTable)
            .where(inArray(taskTable.id, relatedTaskIds))
        : [];
    const projectIdByTaskId = new Map(
      relatedTasks.map((relatedTask) => [
        relatedTask.id,
        relatedTask.projectId,
      ]),
    );

    const deletedTasks = await tx
      .delete(taskTable)
      .where(inArray(taskTable.id, deletionIds))
      .returning({
        id: taskTable.id,
        projectId: taskTable.projectId,
        title: taskTable.title,
      });

    if (!deletedTasks.some((deletedTask) => deletedTask.id === lockedRoot.id)) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    return {
      deletedTasks,
      relations,
      assetKeys: assetRows.map((asset) => asset.objectKey),
      projectIdByTaskId,
    };
  });

  for (const deletedTask of deletion.deletedTasks) {
    await publishEvent("task.deleted", {
      taskId: deletedTask.id,
      projectId: deletedTask.projectId,
      userId: currentUserId,
      title: deletedTask.title,
    });
  }

  for (const relation of deletion.relations) {
    await publishEvent("task-relation.deleted", {
      projectId:
        deletion.projectIdByTaskId.get(relation.sourceTaskId) ?? task.projectId,
      userId: currentUserId,
      taskId: relation.sourceTaskId,
      sourceTaskId: relation.sourceTaskId,
      targetTaskId: relation.targetTaskId,
    });
  }

  // Fire-and-forget S3 cleanup only after the complete DB cascade commits.
  if (deletion.assetKeys.length > 0) {
    deleteS3Keys(deletion.assetKeys).catch(() => {});
  }

  return task;
}

export default deleteTask;
