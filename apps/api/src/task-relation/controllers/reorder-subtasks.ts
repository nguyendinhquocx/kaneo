import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";
import { lockProjectTaskLanes } from "../../task/lock-project-task-lanes";
import getTaskRelations from "./get-task-relations";

type ReorderSubtasksInput = {
  parentTaskId: string;
  orderedTargetTaskIds: string[];
  workspaceId: string;
};

export async function reorderSubtasks({
  parentTaskId,
  orderedTargetTaskIds,
  workspaceId,
}: ReorderSubtasksInput) {
  if (new Set(orderedTargetTaskIds).size !== orderedTargetTaskIds.length) {
    throw new HTTPException(400, { message: "Duplicate subtask IDs" });
  }

  const [parentSnapshot] = await db
    .select({ projectId: schema.taskTable.projectId })
    .from(schema.taskTable)
    .innerJoin(
      schema.projectTable,
      eq(schema.taskTable.projectId, schema.projectTable.id),
    )
    .where(
      and(
        eq(schema.taskTable.id, parentTaskId),
        eq(schema.projectTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!parentSnapshot) {
    throw new HTTPException(404, { message: "Task not found" });
  }
  const childSnapshots =
    orderedTargetTaskIds.length > 0
      ? await db
          .select({ id: schema.taskTable.id, projectId: schema.taskTable.projectId })
          .from(schema.taskTable)
          .innerJoin(
            schema.projectTable,
            eq(schema.taskTable.projectId, schema.projectTable.id),
          )
          .where(
            and(
              inArray(schema.taskTable.id, orderedTargetTaskIds),
              eq(schema.projectTable.workspaceId, workspaceId),
            ),
          )
      : [];
  if (childSnapshots.length !== orderedTargetTaskIds.length) {
    throw new HTTPException(409, {
      message: "Subtask list changed; reload before reordering",
    });
  }
  const projectIds = [
    parentSnapshot.projectId,
    ...childSnapshots.map((child) => child.projectId),
  ];

  await db.transaction(async (tx) => {
    await lockProjectTaskLanes(tx, projectIds);
    const [parent] = await tx
      .select({
        id: schema.taskTable.id,
        projectId: schema.taskTable.projectId,
      })
      .from(schema.taskTable)
      .innerJoin(
        schema.projectTable,
        eq(schema.taskTable.projectId, schema.projectTable.id),
      )
      .where(
        and(
          eq(schema.taskTable.id, parentTaskId),
          eq(schema.projectTable.workspaceId, workspaceId),
        ),
      )
      .for("update")
      .limit(1);

    if (!parent || parent.projectId !== parentSnapshot.projectId) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    const relations = await tx
      .select({
        id: schema.taskRelationTable.id,
        targetTaskId: schema.taskRelationTable.targetTaskId,
        position: schema.taskRelationTable.position,
        createdAt: schema.taskRelationTable.createdAt,
      })
      .from(schema.taskRelationTable)
      .where(
        and(
          eq(schema.taskRelationTable.sourceTaskId, parentTaskId),
          eq(schema.taskRelationTable.relationType, "subtask"),
        ),
      )
      .orderBy(
        asc(schema.taskRelationTable.position),
        asc(schema.taskRelationTable.createdAt),
      )
      .for("update");

    const currentIds = new Set(
      relations.map((relation) => relation.targetTaskId),
    );
    if (
      currentIds.size !== orderedTargetTaskIds.length ||
      orderedTargetTaskIds.some((id) => !currentIds.has(id))
    ) {
      throw new HTTPException(409, {
        message: "Subtask list changed; reload before reordering",
      });
    }

    const children = await tx
      .select({
        id: schema.taskTable.id,
        projectId: schema.taskTable.projectId,
        columnId: schema.taskTable.columnId,
        status: schema.taskTable.status,
        position: schema.taskTable.position,
        createdAt: schema.taskTable.createdAt,
      })
      .from(schema.taskTable)
      .innerJoin(
        schema.projectTable,
        eq(schema.taskTable.projectId, schema.projectTable.id),
      )
      .where(
        and(
          inArray(schema.taskTable.id, orderedTargetTaskIds),
          eq(schema.projectTable.workspaceId, workspaceId),
        ),
      )
      .orderBy(asc(schema.taskTable.id))
      .for("update");

    if (
      children.length !== orderedTargetTaskIds.length ||
      children.some(
        (child) =>
          child.projectId !==
          childSnapshots.find((snapshot) => snapshot.id === child.id)?.projectId,
      )
    ) {
      throw new HTTPException(409, {
        message: "Subtask list changed; reload before reordering",
      });
    }

    const childById = new Map(children.map((child) => [child.id, child]));
    const laneGroups = new Map<string, typeof children>();
    for (const targetTaskId of orderedTargetTaskIds) {
      const child = childById.get(targetTaskId);
      if (!child) continue;
      const laneKey = `${child.projectId}:${child.columnId ?? child.status}`;
      const lane = laneGroups.get(laneKey) ?? [];
      lane.push(child);
      laneGroups.set(laneKey, lane);
    }

    const positionByTaskId = new Map(
      orderedTargetTaskIds.map((taskId, position) => [taskId, position]),
    );
    for (const relation of relations) {
      const position = positionByTaskId.get(relation.targetTaskId);
      if (position === undefined) {
        throw new HTTPException(409, {
          message: "Subtask list changed; reload before reordering",
        });
      }
      await tx
        .update(schema.taskRelationTable)
        .set({ position })
        .where(eq(schema.taskRelationTable.id, relation.id));
    }

    for (const laneChildren of laneGroups.values()) {
      const sample = laneChildren[0];
      if (!sample) continue;
      const laneFilter = sample.columnId
        ? eq(schema.taskTable.columnId, sample.columnId)
        : and(
            isNull(schema.taskTable.columnId),
            eq(schema.taskTable.status, sample.status),
          );
      const laneTasks = await tx
        .select({
          id: schema.taskTable.id,
          position: schema.taskTable.position,
        })
        .from(schema.taskTable)
        .where(
          and(eq(schema.taskTable.projectId, sample.projectId), laneFilter),
        )
        .orderBy(
          asc(schema.taskTable.position),
          asc(schema.taskTable.createdAt),
        );

      const siblingIds = new Set(laneChildren.map((child) => child.id));
      const firstSiblingIndex = laneTasks.findIndex((task) =>
        siblingIds.has(task.id),
      );
      const remaining = laneTasks
        .filter((task) => !siblingIds.has(task.id))
        .map((task) => task.id);
      const desiredSiblingOrder = orderedTargetTaskIds.filter((id) =>
        siblingIds.has(id),
      );
      remaining.splice(
        Math.max(0, firstSiblingIndex),
        0,
        ...desiredSiblingOrder,
      );

      for (const [position, taskId] of remaining.entries()) {
        await tx
          .update(schema.taskTable)
          .set({ position })
          .where(eq(schema.taskTable.id, taskId));
      }
    }
  });

  return getTaskRelations(parentTaskId, workspaceId);
}
