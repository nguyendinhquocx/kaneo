import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  activityTable,
  assetTable,
  projectTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { maybeSteerActiveRunFromComment } from "../../execution/service";
import { findActiveBindingForTask } from "../../agent-session/binding-service";
import createNotification from "../../notification/controllers/create-notification";
import { extractAssetIds } from "../../storage/cleanup-assets";
import { parseMentionIds } from "../../utils/parse-mentions";

async function createComment(
  taskId: string,
  userId: string,
  content: string,
  actorIsAgent: boolean,
) {
  const [activity] = await db
    .insert(activityTable)
    .values({
      taskId,
      type: "comment",
      userId,
      content,
    })
    .returning();

  if (!activity) {
    throw new HTTPException(500, {
      message: "Failed to create activity",
    });
  }

  const referencedAssetIds = [...extractAssetIds(content)];
  if (referencedAssetIds.length > 0) {
    await db
      .update(assetTable)
      .set({ activityId: activity.id })
      .where(
        and(
          eq(assetTable.taskId, taskId),
          eq(assetTable.surface, "comment"),
          inArray(assetTable.id, referencedAssetIds),
        ),
      );
  }

  // SPEC-2026-11-10 T5: ordinary comments never become implicit Pi prompts
  // for an ad-hoc bound session. API-key/MCP agents never self-steer either.
  // Attachment-only comments are metadata, not a human instruction. Formal
  // task_run behavior remains unchanged for a human browser-session comment.
  const steerableText = content
    .replace(/<kaneo-attachment\b[^>]*\/\s*>/gi, "")
    .trim();
  if (!actorIsAgent && steerableText) {
    let hasAdHocBinding = true;
    try {
      hasAdHocBinding = Boolean(await findActiveBindingForTask(taskId));
    } catch {
      // Fail closed: if routing state is unavailable, do not guess a Pi
      // target or run the no-active-run fallback from a plain discussion.
      hasAdHocBinding = true;
    }
    if (!hasAdHocBinding) {
      maybeSteerActiveRunFromComment({
        taskId,
        userId,
        content: steerableText,
      }).catch(() => {});
    }
  }

  const [user] = await db
    .select({ name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, userId));

  const [task] = await db
    .select({
      assigneeId: taskTable.userId,
      projectId: taskTable.projectId,
      title: taskTable.title,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, taskId));

  if (task) {
    await publishEvent("comment.created", {
      ...activity,
      comment: `**${user?.name}** commented:\n> ${content}`,
      projectId: task.projectId,
    });
  }

  // Notify any workspace members @mentioned in the comment (not the author).
  const mentionedIds = parseMentionIds(content).filter((id) => id !== userId);
  for (const mentionedId of mentionedIds) {
    await createNotification({
      userId: mentionedId,
      type: "task_mention",
      eventData: {
        taskTitle: task?.title ?? null,
        mentionerName: user?.name ?? null,
        projectId: task?.projectId ?? null,
        workspaceId: task?.workspaceId ?? null,
      },
      resourceId: taskId,
      resourceType: "task",
    });
  }

  if (
    task?.assigneeId &&
    task.assigneeId !== userId &&
    !mentionedIds.includes(task.assigneeId)
  ) {
    await createNotification({
      userId: task.assigneeId,
      type: "task_comment",
      eventData: {
        taskTitle: task.title,
        commenterName: user?.name ?? null,
        commentPreview: content.slice(0, 160),
        projectId: task.projectId,
        workspaceId: task.workspaceId,
      },
      resourceId: taskId,
      resourceType: "task",
    });
  }

  return activity;
}

export default createComment;
