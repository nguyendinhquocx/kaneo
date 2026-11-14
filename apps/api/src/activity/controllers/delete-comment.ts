import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { activityTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { deleteOrphanedAssets } from "../../storage/cleanup-assets";
import { markQueuedCommentDeliveriesStaleWith } from "../../agent-session/delivery-service";

async function deleteComment(userId: string, id: string) {
  const [existing] = await db
    .select({
      id: activityTable.id,
      content: activityTable.content,
      taskId: activityTable.taskId,
    })
    .from(activityTable)
    .where(
      and(
        eq(activityTable.id, id),
        eq(activityTable.userId, userId),
        eq(activityTable.type, "comment"),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new HTTPException(404, {
      message: "Comment not found or you are not the author",
    });
  }

  // A deleted comment must invalidate queued Send-to-Pi receipts in the
  // same transaction, or a claim could still pin the just-deleted content.
  const deletedComment = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(activityTable)
      .where(
        and(
          eq(activityTable.id, id),
          eq(activityTable.userId, userId),
          eq(activityTable.type, "comment"),
        ),
      )
      .returning();
    if (!row) return null;
    await markQueuedCommentDeliveriesStaleWith(tx, row.id);
    return row;
  });

  if (!deletedComment) {
    throw new HTTPException(404, {
      message: "Comment not found or you are not the author",
    });
  }

  // Deletion invalidates queued deliveries; a claimed attempt remains
  // truthful and is reconciled by its lease/ack state machine.

  const [task] = await db
    .select({ projectId: taskTable.projectId })
    .from(taskTable)
    .where(eq(taskTable.id, deletedComment.taskId))
    .limit(1);

  if (task) {
    await publishEvent("comment.deleted", {
      ...deletedComment,
      projectId: task.projectId,
      userId,
    });
  }

  deleteOrphanedAssets(existing.content, null, {
    taskId: existing.taskId,
  }).catch(() => {});

  return deletedComment;
}

export default deleteComment;
