import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskRelationTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { assertTaskContentRevision } from "../../task/content-revision";

async function deleteTaskRelation(
  id: string,
  userId: string,
  expectedParentContentRevision?: number,
) {
  const [rel] = await db
    .select({
      sourceTaskId: taskRelationTable.sourceTaskId,
      targetTaskId: taskRelationTable.targetTaskId,
      relationType: taskRelationTable.relationType,
    })
    .from(taskRelationTable)
    .where(eq(taskRelationTable.id, id))
    .limit(1);

  if (!rel) {
    throw new HTTPException(404, {
      message: "Task relation not found",
    });
  }

  const [task] = await db
    .select({ projectId: taskTable.projectId })
    .from(taskTable)
    .where(eq(taskTable.id, rel.sourceTaskId))
    .limit(1);

  const [relation] = await db.transaction(async (tx) => {
    if (rel.relationType === "subtask") {
      // Removing a subtask edge changes the parent's subtask structure:
      // CAS + bump in the same transaction as the delete.
      if (expectedParentContentRevision === undefined) {
        throw new HTTPException(400, {
          message:
            "expectedParentContentRevision is required for subtask relations",
        });
      }
      const [lockedParent] = await tx
        .select()
        .from(taskTable)
        .where(eq(taskTable.id, rel.sourceTaskId))
        .for("update")
        .limit(1);
      if (!lockedParent) {
        throw new HTTPException(404, { message: "Task not found" });
      }
      await assertTaskContentRevision(
        tx,
        rel.sourceTaskId,
        expectedParentContentRevision,
      );
      const [deleted] = await tx
        .delete(taskRelationTable)
        .where(eq(taskRelationTable.id, id))
        .returning();
      if (!deleted) {
        throw new HTTPException(404, {
          message: "Task relation not found",
        });
      }
      await tx
        .update(taskTable)
        .set({ contentRevision: lockedParent.contentRevision + 1 })
        .where(eq(taskTable.id, rel.sourceTaskId));
      return [deleted];
    }

    return tx
      .delete(taskRelationTable)
      .where(eq(taskRelationTable.id, id))
      .returning();
  });

  if (!relation) {
    throw new HTTPException(404, {
      message: "Task relation not found",
    });
  }

  if (task) {
    await publishEvent("task-relation.deleted", {
      ...relation,
      taskId: rel.sourceTaskId,
      sourceTaskId: rel.sourceTaskId,
      targetTaskId: rel.targetTaskId,
      projectId: task.projectId,
      userId,
    });
  }

  return relation;
}

export default deleteTaskRelation;
