import { and, eq, max, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { assertTaskContentRevision } from "../../task/content-revision";

async function createTaskRelation({
  sourceTaskId,
  targetTaskId,
  relationType,
  userId,
  workspaceId,
  expectedParentContentRevision,
}: {
  sourceTaskId: string;
  targetTaskId: string;
  relationType: string;
  userId: string;
  workspaceId: string;
  expectedParentContentRevision?: number;
}) {
  if (sourceTaskId === targetTaskId) {
    throw new HTTPException(400, {
      message: "Cannot create a relation between a task and itself",
    });
  }

  const [sourceTask] = await db
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(
      and(
        eq(taskTable.id, sourceTaskId),
        eq(projectTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!sourceTask) {
    throw new HTTPException(404, { message: "Source task not found" });
  }

  const [targetTask] = await db
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(
      and(
        eq(taskTable.id, targetTaskId),
        eq(projectTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!targetTask) {
    throw new HTTPException(404, { message: "Target task not found" });
  }

  const existing = await db
    .select({ id: taskRelationTable.id })
    .from(taskRelationTable)
    .where(
      and(
        eq(taskRelationTable.relationType, relationType),
        or(
          and(
            eq(taskRelationTable.sourceTaskId, sourceTaskId),
            eq(taskRelationTable.targetTaskId, targetTaskId),
          ),
          and(
            eq(taskRelationTable.sourceTaskId, targetTaskId),
            eq(taskRelationTable.targetTaskId, sourceTaskId),
          ),
        ),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    throw new HTTPException(409, {
      message: "This relation already exists",
    });
  }

  const [relation] = await db.transaction(async (tx) => {
    let position = 0;
    if (relationType === "subtask") {
      // Adding a subtask edge changes the parent card's subtask structure:
      // CAS against the parent's contentRevision and bump it atomically.
      if (expectedParentContentRevision === undefined) {
        throw new HTTPException(400, {
          message:
            "expectedParentContentRevision is required for subtask relations",
        });
      }
      const [lockedParent] = await tx
        .select()
        .from(taskTable)
        .where(eq(taskTable.id, sourceTaskId))
        .for("update")
        .limit(1);
      if (!lockedParent) {
        throw new HTTPException(404, { message: "Source task not found" });
      }
      await assertTaskContentRevision(
        tx,
        sourceTaskId,
        expectedParentContentRevision,
      );
      const [maxPosition] = await tx
        .select({ value: max(taskRelationTable.position) })
        .from(taskRelationTable)
        .where(
          and(
            eq(taskRelationTable.sourceTaskId, sourceTaskId),
            eq(taskRelationTable.relationType, "subtask"),
          ),
        );
      position = (maxPosition?.value ?? -1) + 1;
      await tx
        .update(taskTable)
        .set({ contentRevision: lockedParent.contentRevision + 1 })
        .where(eq(taskTable.id, sourceTaskId));
    }

    return tx
      .insert(taskRelationTable)
      .values({
        sourceTaskId,
        targetTaskId,
        relationType,
        position,
      })
      .returning();
  });

  if (!relation) {
    throw new HTTPException(500, {
      message: "Failed to create task relation",
    });
  }

  await publishEvent("task-relation.created", {
    ...relation,
    taskId: sourceTaskId,
    projectId: sourceTask.projectId,
    userId,
  });

  return relation;
}

export default createTaskRelation;
