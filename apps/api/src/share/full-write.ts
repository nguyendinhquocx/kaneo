import { and, asc, eq, inArray, max, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { publishEvent } from "../events";
import { assertBulkTaskIdsGuard } from "../execution/phase-progress";
import {
  createContentAssetUploadUrl,
  deleteS3Object,
  getPrivateObjectMeta,
  validateFullLinkUploadInput,
} from "../storage/s3";
import { assertValidPriority, assertValidTaskStatus } from "../task/validate-task-fields";
import { claimTaskNumber } from "../task/controllers/claim-task-numbers";
import { deleteOrphanedAssets } from "../storage/cleanup-assets";
import {
  assertGuestAssigneeAllowed,
  countResourceAssets,
  getFullLinkProject,
  getFullLinkUploadUsage,
  getRedactedTaskIds,
  isProjectAgentControlledStrict,
  isTaskAgentControlled,
  listAssignableMembers,
  loadProjectTask,
} from "./full-access";
import {
  appendShareActionAudit,
  type ResolvedShareLink,
} from "./resolve-share-link";

// SPEC-2026-10-22 full-project-share-link: guest mutations under a `full`
// capability. Every write is (1) project-scoped to link.resourceId, (2)
// denied for agent-controlled objects, (3) committed atomically with its
// share audit row, and (4) attributed to the share link — never to a fake
// user or the owner. Side effects are limited to ordinary, link-attributed
// event broadcasts; no steering, no member notifications.

export const GUEST_ACTOR_LABEL = "Share link holder";

const guestDenied = () =>
  new HTTPException(403, {
    message:
      "This object is managed by agent-control and cannot be changed through a share link.",
  });

const notFound = () => new HTTPException(404, { message: "Not found" });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function audit(tx: Tx, link: ResolvedShareLink, action: string) {
  await appendShareActionAudit(link, action, tx);
}

// ---------------------------------------------------------------------------
// Members directory (owner-approved minimal disclosure)
// ---------------------------------------------------------------------------

export async function fullListMembers(link: ResolvedShareLink) {
  const project = await getFullLinkProject(link.resourceId);
  return listAssignableMembers(project.workspaceId);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type FullTaskWriteBody = {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  startDate?: string | null;
  dueDate?: string | null;
  assigneeId?: string | null;
  position?: number;
  labels?: Array<{ name: string; color: string }>;
};

async function assertGuestDescriptionWritable(
  projectId: string,
  taskId?: string,
) {
  if (await isProjectAgentControlledStrict(projectId)) {
    throw guestDenied();
  }
  if (taskId && (await isTaskAgentControlled(taskId))) {
    throw guestDenied();
  }
}

export async function fullCreateTask(
  link: ResolvedShareLink,
  body: FullTaskWriteBody & { title: string },
) {
  const project = await getFullLinkProject(link.resourceId);
  await assertGuestDescriptionWritable(project.id);

  const status = body.status || "to-do";
  const priority = body.priority || "no-priority";
  await assertValidTaskStatus(status, project.id);
  assertValidPriority(priority);
  if (body.assigneeId) {
    await assertGuestAssigneeAllowed(body.assigneeId, project.workspaceId);
  }

  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(schema.columnTable.projectId, project.id),
      eq(schema.columnTable.slug, status),
    ),
  });

  const [maxPositionResult] = await db
    .select({ maxPosition: max(schema.taskTable.position) })
    .from(schema.taskTable)
    .where(
      and(
        eq(schema.taskTable.projectId, project.id),
        column?.id
          ? eq(schema.taskTable.columnId, column.id)
          : eq(schema.taskTable.status, status),
      ),
    );
  const nextPosition = (maxPositionResult?.maxPosition ?? 0) + 1;

  const created = await db.transaction(async (tx) => {
    const taskNumber = await claimTaskNumber(project.id, tx);
    const [task] = await tx
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: body.assigneeId || null,
        title: body.title,
        description: body.description ?? "",
        status,
        columnId: column?.id ?? null,
        position: nextPosition,
        startDate: body.startDate ? new Date(body.startDate) : null,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        priority,
        number: taskNumber,
      })
      .returning();
    if (!task) {
      throw new HTTPException(500, { message: "Failed to create task" });
    }
    if (body.labels && body.labels.length > 0) {
      await tx.insert(schema.labelTable).values(
        body.labels.slice(0, 20).map((label) => ({
          taskId: task.id,
          workspaceId: project.workspaceId,
          name: label.name,
          color: label.color,
        })),
      );
    }
    await audit(tx, link, "task.create");
    return task;
  });

  await publishEvent("task.created", {
    ...created,
    taskId: created.id,
    userId: created.userId ?? "",
    currentUserId: "",
    type: "created",
    content: null,
  });

  return created;
}

export async function fullUpdateTask(
  link: ResolvedShareLink,
  taskId: string,
  body: FullTaskWriteBody,
) {
  const project = await getFullLinkProject(link.resourceId);
  const task = await loadProjectTask(taskId, project.id);
  if (await isTaskAgentControlled(task.id)) {
    throw guestDenied();
  }
  if (body.description !== undefined) {
    await assertGuestDescriptionWritable(project.id, task.id);
  }
  if (body.assigneeId) {
    await assertGuestAssigneeAllowed(body.assigneeId, project.workspaceId);
  }

  const updates: Partial<typeof schema.taskTable.$inferInsert> = {};
  if (body.title !== undefined) {
    updates.title = body.title;
  }
  if (body.description !== undefined) {
    updates.description = body.description;
  }
  if (body.priority !== undefined) {
    assertValidPriority(body.priority);
    updates.priority = body.priority;
  }
  if (body.status !== undefined && body.status !== task.status) {
    await assertValidTaskStatus(body.status, project.id);
    const column = await db.query.columnTable.findFirst({
      where: and(
        eq(schema.columnTable.projectId, project.id),
        eq(schema.columnTable.slug, body.status),
      ),
    });
    updates.status = body.status;
    updates.columnId = column?.id ?? null;
  }
  if (body.startDate !== undefined) {
    updates.startDate = body.startDate ? new Date(body.startDate) : null;
  }
  if (body.dueDate !== undefined) {
    updates.dueDate = body.dueDate ? new Date(body.dueDate) : null;
  }
  if (body.assigneeId !== undefined) {
    updates.userId = body.assigneeId || null;
  }
  if (body.position !== undefined) {
    updates.position = body.position;
  }

  const [updated] = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.taskTable)
      .set(updates)
      .where(
        and(
          eq(schema.taskTable.id, task.id),
          eq(schema.taskTable.projectId, project.id),
        ),
      )
      .returning();
    if (!row) {
      return [] as typeof row[];
    }
    await audit(tx, link, "task.update");
    return [row];
  });
  if (!updated) {
    throw notFound();
  }

  if (task.description !== updated.description) {
    deleteOrphanedAssets(task.description, updated.description, {
      taskId: task.id,
    }).catch(() => {});
  }

  await publishEvent("task.updated", {
    taskId: updated.id,
    projectId: updated.projectId,
    title: updated.title,
    status: updated.status,
    userId: updated.userId ?? "",
  });
  if (updates.status && updates.status !== task.status) {
    await publishEvent("task-relation.refresh", {
      projectId: project.id,
      userId: "",
    });
  }

  return updated;
}

export async function fullDeleteTask(
  link: ResolvedShareLink,
  taskId: string,
) {
  const project = await getFullLinkProject(link.resourceId);
  const task = await loadProjectTask(taskId, project.id);
  if (await isTaskAgentControlled(task.id)) {
    throw guestDenied();
  }

  const deletion = await db.transaction(async (tx) => {
    const [lockedRoot] = await tx
      .select({ id: schema.taskTable.id, projectId: schema.taskTable.projectId })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id))
      .for("update")
      .limit(1);
    if (!lockedRoot) {
      throw notFound();
    }

    // Walk explicit subtask edges only, mirroring the owner delete flow:
    // cross-project or dangling children refuse the whole tree.
    const taskIds = new Set([lockedRoot.id]);
    let frontier = [lockedRoot.id];
    while (frontier.length > 0) {
      const childRelations = await tx
        .select({
          sourceTaskId: schema.taskRelationTable.sourceTaskId,
          targetTaskId: schema.taskRelationTable.targetTaskId,
        })
        .from(schema.taskRelationTable)
        .where(
          and(
            inArray(schema.taskRelationTable.sourceTaskId, frontier),
            eq(schema.taskRelationTable.relationType, "subtask"),
          ),
        )
        .for("update");

      if (childRelations.some((relation) => relation.targetTaskId === task.id)) {
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
          id: schema.taskTable.id,
          projectId: schema.taskTable.projectId,
        })
        .from(schema.taskTable)
        .where(inArray(schema.taskTable.id, unseenChildIds))
        .for("update");
      if (childTasks.length !== unseenChildIds.length) {
        throw new HTTPException(409, {
          message: "Cannot delete a subtask tree with missing tasks",
        });
      }
      for (const child of childTasks) {
        if (child.projectId !== lockedRoot.projectId) {
          // Cross-project children are not deleteable through the link.
          throw new HTTPException(409, {
            message:
              "Cannot delete this task tree because a child is shared or belongs to another project",
          });
        }
        taskIds.add(child.id);
      }
      frontier = childTasks.map((child) => child.id);
    }

    const descendantIds = [...taskIds].filter((id) => id !== lockedRoot.id);
    if (descendantIds.length > 0) {
      // Mirror the owner delete integrity check: every descendant must have
      // exactly one parent inside the tree, otherwise the tree is malformed
      // and the delete fails closed.
      const incomingSubtaskRelations = await tx
        .select({
          sourceTaskId: schema.taskRelationTable.sourceTaskId,
          targetTaskId: schema.taskRelationTable.targetTaskId,
        })
        .from(schema.taskRelationTable)
        .where(
          and(
            eq(schema.taskRelationTable.relationType, "subtask"),
            inArray(schema.taskRelationTable.targetTaskId, descendantIds),
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
            message:
              "Cannot delete this task tree because a child is shared or belongs to another project",
          });
        }
      }
    }

    const deletionIds = [...taskIds].sort();
    await assertBulkTaskIdsGuard(tx, {
      taskIds: deletionIds,
      actorIsAgent: false,
    });

    // Refuse trees with execution history — guests can never delete runs or
    // schedules, and a guest-ordinary root with an execution-linked child is
    // uncertain, so it fails closed too.
    if (deletionIds.length > 0) {
      const [run] = await tx
        .select({ id: schema.taskRunTable.id })
        .from(schema.taskRunTable)
        .where(inArray(schema.taskRunTable.taskId, deletionIds))
        .limit(1);
      const [schedule] = await tx
        .select({ id: schema.executionScheduleTable.id })
        .from(schema.executionScheduleTable)
        .where(inArray(schema.executionScheduleTable.taskId, deletionIds))
        .limit(1);
      if (run || schedule) {
        throw guestDenied();
      }
      // Phase-card membership also marks the tree as execution-managed.
      const [phaseCard] = await tx
        .select({ id: schema.executionPhaseCardTable.id })
        .from(schema.executionPhaseCardTable)
        .where(
          or(
            inArray(schema.executionPhaseCardTable.fullTaskId, deletionIds),
            inArray(schema.executionPhaseCardTable.childTaskId, deletionIds),
          ),
        )
        .limit(1);
      if (phaseCard) {
        throw guestDenied();
      }
    }

    const relations = await tx
      .select()
      .from(schema.taskRelationTable)
      .where(
        or(
          inArray(schema.taskRelationTable.sourceTaskId, deletionIds),
          inArray(schema.taskRelationTable.targetTaskId, deletionIds),
        ),
      )
      .for("update");
    const assetRows = await tx
      .select({ objectKey: schema.assetTable.objectKey })
      .from(schema.assetTable)
      .where(inArray(schema.assetTable.taskId, deletionIds))
      .for("update");

    const deletedTasks = await tx
      .delete(schema.taskTable)
      .where(inArray(schema.taskTable.id, deletionIds))
      .returning({
        id: schema.taskTable.id,
        projectId: schema.taskTable.projectId,
        title: schema.taskTable.title,
      });
    if (!deletedTasks.some((deleted) => deleted.id === lockedRoot.id)) {
      throw notFound();
    }

    await audit(tx, link, "task.delete");

    return {
      deletedTasks,
      relations,
      assetKeys: assetRows.map((asset) => asset.objectKey),
      descendantIds,
    };
  });

  for (const deletedTask of deletion.deletedTasks) {
    await publishEvent("task.deleted", {
      taskId: deletedTask.id,
      projectId: deletedTask.projectId,
      userId: "",
      title: deletedTask.title,
    });
  }
  for (const relation of deletion.relations) {
    await publishEvent("task-relation.deleted", {
      projectId: project.id,
      userId: "",
      taskId: relation.sourceTaskId,
      sourceTaskId: relation.sourceTaskId,
      targetTaskId: relation.targetTaskId,
    });
  }
  for (const objectKey of deletion.assetKeys) {
    deleteS3Object(objectKey).catch(() => {});
  }

  return { success: true, deletedCount: deletion.deletedTasks.length };
}

// ---------------------------------------------------------------------------
// Comments (dedicated guest path — no steering, no notifications)
// ---------------------------------------------------------------------------

async function loadGuestComment(commentId: string, projectId: string) {
  const [row] = await db
    .select({
      id: schema.activityTable.id,
      taskId: schema.activityTable.taskId,
      content: schema.activityTable.content,
      eventData: schema.activityTable.eventData,
    })
    .from(schema.activityTable)
    .innerJoin(schema.taskTable, eq(schema.activityTable.taskId, schema.taskTable.id))
    .where(
      and(
        eq(schema.activityTable.id, commentId),
        eq(schema.activityTable.type, "comment"),
        eq(schema.taskTable.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row) {
    throw notFound();
  }
  const shareLinkId =
    typeof row.eventData === "object" && row.eventData !== null
      ? (row.eventData as Record<string, unknown>).shareLinkId
      : undefined;
  return { ...row, shareLinkId: typeof shareLinkId === "string" ? shareLinkId : undefined };
}

export async function fullCreateComment(
  link: ResolvedShareLink,
  taskId: string,
  content: string,
) {
  const project = await getFullLinkProject(link.resourceId);
  const task = await loadProjectTask(taskId, project.id);
  if (await isTaskAgentControlled(task.id)) {
    throw guestDenied();
  }

  const created = await db.transaction(async (tx) => {
    const [activity] = await tx
      .insert(schema.activityTable)
      .values({
        taskId: task.id,
        type: "comment",
        userId: null,
        content,
        // Link attribution without a fake user; own-comment checks read this.
        externalUserName: GUEST_ACTOR_LABEL,
        externalSource: "share-link",
        eventData: { shareLinkId: link.id },
      })
      .returning();
    if (!activity) {
      throw new HTTPException(500, { message: "Failed to create comment" });
    }

    const referencedAssetIds = [
      ...new Set(
        (content.match(/\/(?:api\/)?asset\/([a-z0-9]+)/gi) ?? []).map((ref) =>
          ref.split("/asset/")[1] ?? "",
        ),
      ),
    ].filter(Boolean);
    if (referencedAssetIds.length > 0) {
      await tx
        .update(schema.assetTable)
        .set({ activityId: activity.id })
        .where(
          and(
            eq(schema.assetTable.taskId, task.id),
            eq(schema.assetTable.surface, "comment"),
            inArray(schema.assetTable.id, referencedAssetIds),
          ),
        );
    }

    await audit(tx, link, "comment.create");
    return activity;
  });

  // Ordinary side effect: ID-only project broadcast after the durable write.
  // No agent steering, no mention/assignee notifications (T1 §D).
  await publishEvent("comment.created", {
    ...created,
    comment: `**${GUEST_ACTOR_LABEL}** commented:\n> ${content}`,
    projectId: project.id,
  });

  return {
    id: created.id,
    taskId: created.taskId,
    content: created.content,
    createdAt: created.createdAt,
    authorName: GUEST_ACTOR_LABEL,
  };
}

export async function fullUpdateComment(
  link: ResolvedShareLink,
  commentId: string,
  content: string,
) {
  const project = await getFullLinkProject(link.resourceId);
  const comment = await loadGuestComment(commentId, project.id);
  if (comment.shareLinkId !== link.id) {
    // A holder may only edit comments created by this same link.
    throw notFound();
  }
  if (await isTaskAgentControlled(comment.taskId)) {
    throw guestDenied();
  }

  const [updated] = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.activityTable)
      .set({ content })
      .where(
        and(
          eq(schema.activityTable.id, comment.id),
          eq(schema.activityTable.type, "comment"),
        ),
      )
      .returning();
    if (!row) {
      return [] as typeof row[];
    }
    await audit(tx, link, "comment.update");
    return [row];
  });
  if (!updated) {
    throw notFound();
  }

  if (comment.content !== content) {
    deleteOrphanedAssets(comment.content, content, {
      taskId: comment.taskId,
    }).catch(() => {});
  }

  await publishEvent("comment.updated", {
    ...updated,
    projectId: project.id,
    userId: "",
  });

  return {
    id: updated.id,
    content: updated.content,
    authorName: GUEST_ACTOR_LABEL,
  };
}

export async function fullDeleteComment(
  link: ResolvedShareLink,
  commentId: string,
) {
  const project = await getFullLinkProject(link.resourceId);
  const comment = await loadGuestComment(commentId, project.id);
  if (comment.shareLinkId !== link.id) {
    throw notFound();
  }
  if (await isTaskAgentControlled(comment.taskId)) {
    throw guestDenied();
  }

  const [deleted] = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(schema.activityTable)
      .where(eq(schema.activityTable.id, comment.id))
      .returning();
    if (!row) {
      return [] as typeof row[];
    }
    await audit(tx, link, "comment.delete");
    return [row];
  });
  if (!deleted) {
    throw notFound();
  }

  deleteOrphanedAssets(comment.content, null, {
    taskId: comment.taskId,
  }).catch(() => {});

  await publishEvent("comment.deleted", {
    ...deleted,
    projectId: project.id,
    userId: "",
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Project documents
// ---------------------------------------------------------------------------

async function loadProjectDocument(documentId: string, projectId: string) {
  const [document] = await db
    .select()
    .from(schema.documentTable)
    .where(
      and(
        eq(schema.documentTable.id, documentId),
        eq(schema.documentTable.projectId, projectId),
      ),
    )
    .limit(1);
  if (!document || document.archivedAt !== null) {
    throw notFound();
  }
  return document;
}

export async function fullCreateDocument(
  link: ResolvedShareLink,
  body: { title: string; content: string },
) {
  await getFullLinkProject(link.resourceId);

  const created = await db.transaction(async (tx) => {
    const [document] = await tx
      .insert(schema.documentTable)
      .values({
        projectId: link.resourceId,
        title: body.title,
        content: body.content,
        revision: 1,
        createdByUserId: null,
      })
      .returning();
    if (!document) {
      throw new HTTPException(500, { message: "Failed to create document" });
    }
    await audit(tx, link, "document.create");
    return document;
  });

  return {
    id: created.id,
    title: created.title,
    content: created.content,
    revision: created.revision,
  };
}

export async function fullUpdateDocument(
  link: ResolvedShareLink,
  documentId: string,
  body: { title: string; content: string; revision: number },
) {
  await getFullLinkProject(link.resourceId);
  const document = await loadProjectDocument(documentId, link.resourceId);

  const [updated] = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.documentTable)
      .set({
        title: body.title,
        content: body.content,
        revision: body.revision + 1,
      })
      .where(
        and(
          eq(schema.documentTable.id, document.id),
          eq(schema.documentTable.revision, body.revision),
        ),
      )
      .returning();
    if (!row) {
      return [] as typeof row[];
    }
    await audit(tx, link, "document.update");
    return [row];
  });
  if (!updated) {
    throw new HTTPException(409, {
      message: "Document was modified by someone else",
    });
  }

  if (document.content !== updated.content) {
    deleteOrphanedAssets(document.content, updated.content, {
      documentId: document.id,
    }).catch(() => {});
  }

  return {
    id: updated.id,
    title: updated.title,
    content: updated.content,
    revision: updated.revision,
  };
}

export async function fullSetDocumentArchived(
  link: ResolvedShareLink,
  documentId: string,
  archived: boolean,
) {
  await getFullLinkProject(link.resourceId);
  const document = await loadProjectDocument(documentId, link.resourceId);

  const [updated] = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.documentTable)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(schema.documentTable.id, document.id))
      .returning();
    if (!row) {
      return [] as typeof row[];
    }
    await audit(tx, link, archived ? "document.archive" : "document.unarchive");
    return [row];
  });
  if (!updated) {
    throw notFound();
  }
  return { id: updated.id, archivedAt: updated.archivedAt };
}

export async function fullDeleteDocument(
  link: ResolvedShareLink,
  documentId: string,
) {
  await getFullLinkProject(link.resourceId);
  // Owner parity: archived documents remain deleteable (the authenticated
  // controller does not check archivedAt either) — only existence and
  // project scope matter here.
  const [document] = await db
    .select()
    .from(schema.documentTable)
    .where(
      and(
        eq(schema.documentTable.id, documentId),
        eq(schema.documentTable.projectId, link.resourceId),
      ),
    )
    .limit(1);
  if (!document) {
    throw notFound();
  }

  const assetKeys = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ objectKey: schema.assetTable.objectKey })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.documentId, document.id))
      .for("update");
    await tx.delete(schema.documentTable).where(eq(schema.documentTable.id, document.id));
    await audit(tx, link, "document.delete");
    return rows.map((row) => row.objectKey);
  });

  for (const objectKey of assetKeys) {
    deleteS3Object(objectKey).catch(() => {});
  }
  return { success: true };
}

export async function fullListDocuments(link: ResolvedShareLink) {
  await getFullLinkProject(link.resourceId);
  return db
    .select({
      id: schema.documentTable.id,
      title: schema.documentTable.title,
      revision: schema.documentTable.revision,
      archivedAt: schema.documentTable.archivedAt,
      createdAt: schema.documentTable.createdAt,
      updatedAt: schema.documentTable.updatedAt,
    })
    .from(schema.documentTable)
    .where(eq(schema.documentTable.projectId, link.resourceId))
    .orderBy(asc(schema.documentTable.createdAt));
}

export async function fullGetDocument(
  link: ResolvedShareLink,
  documentId: string,
) {
  await getFullLinkProject(link.resourceId);
  const document = await loadProjectDocument(documentId, link.resourceId);
  return {
    id: document.id,
    title: document.title,
    content: document.content,
    revision: document.revision,
    updatedAt: document.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Task relations / subtasks
// ---------------------------------------------------------------------------

const RELATION_TYPES = new Set(["subtask", "blocks", "related"]);

export async function fullCreateRelation(
  link: ResolvedShareLink,
  sourceTaskId: string,
  targetTaskId: string,
  relationType: string,
) {
  const project = await getFullLinkProject(link.resourceId);
  if (!RELATION_TYPES.has(relationType)) {
    throw new HTTPException(400, { message: "Invalid relation type" });
  }
  if (sourceTaskId === targetTaskId) {
    throw new HTTPException(400, {
      message: "Cannot create a relation between a task and itself",
    });
  }

  // Both endpoint tasks must be proven inside the linked project and free of
  // agent-control relations — reads and writes fail closed together.
  const sourceTask = await loadProjectTask(sourceTaskId, project.id);
  const targetTask = await loadProjectTask(targetTaskId, project.id);
  if ((await isTaskAgentControlled(sourceTask.id)) || (await isTaskAgentControlled(targetTask.id))) {
    throw guestDenied();
  }

  const existing = await db
    .select({ id: schema.taskRelationTable.id })
    .from(schema.taskRelationTable)
    .where(
      and(
        eq(schema.taskRelationTable.relationType, relationType),
        or(
          and(
            eq(schema.taskRelationTable.sourceTaskId, sourceTaskId),
            eq(schema.taskRelationTable.targetTaskId, targetTaskId),
          ),
          and(
            eq(schema.taskRelationTable.sourceTaskId, targetTaskId),
            eq(schema.taskRelationTable.targetTaskId, sourceTaskId),
          ),
        ),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new HTTPException(409, { message: "This relation already exists" });
  }

  const created = await db.transaction(async (tx) => {
    let position = 0;
    if (relationType === "subtask") {
      await tx
        .select({ id: schema.taskTable.id })
        .from(schema.taskTable)
        .where(eq(schema.taskTable.id, sourceTaskId))
        .for("update")
        .limit(1);
      const [maxPosition] = await tx
        .select({ value: max(schema.taskRelationTable.position) })
        .from(schema.taskRelationTable)
        .where(
          and(
            eq(schema.taskRelationTable.sourceTaskId, sourceTaskId),
            eq(schema.taskRelationTable.relationType, "subtask"),
          ),
        );
      position = (maxPosition?.value ?? -1) + 1;
    }

    const [relation] = await tx
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId,
        targetTaskId,
        relationType,
        position,
      })
      .returning();
    if (!relation) {
      throw new HTTPException(500, { message: "Failed to create relation" });
    }
    await audit(tx, link, "task-relation.create");
    return relation;
  });

  await publishEvent("task-relation.created", {
    ...created,
    taskId: sourceTaskId,
    projectId: project.id,
    userId: "",
  });
  await publishEvent("task-relation.refresh", {
    projectId: project.id,
    userId: "",
  });

  return created;
}

export async function fullDeleteRelation(
  link: ResolvedShareLink,
  relationId: string,
) {
  const project = await getFullLinkProject(link.resourceId);

  const [rel] = await db
    .select({
      id: schema.taskRelationTable.id,
      sourceTaskId: schema.taskRelationTable.sourceTaskId,
      targetTaskId: schema.taskRelationTable.targetTaskId,
      relationType: schema.taskRelationTable.relationType,
    })
    .from(schema.taskRelationTable)
    .where(eq(schema.taskRelationTable.id, relationId))
    .limit(1);
  if (!rel) {
    throw notFound();
  }

  // Fail closed unless BOTH endpoints are proven ordinary tasks of the
  // linked project.
  await loadProjectTask(rel.sourceTaskId, project.id);
  await loadProjectTask(rel.targetTaskId, project.id);
  if (
    (await isTaskAgentControlled(rel.sourceTaskId)) ||
    (await isTaskAgentControlled(rel.targetTaskId))
  ) {
    throw guestDenied();
  }

  const [deleted] = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(schema.taskRelationTable)
      .where(eq(schema.taskRelationTable.id, rel.id))
      .returning();
    if (!row) {
      return [] as typeof row[];
    }
    await audit(tx, link, "task-relation.delete");
    return [row];
  });
  if (!deleted) {
    throw notFound();
  }

  await publishEvent("task-relation.deleted", {
    projectId: project.id,
    userId: "",
    taskId: rel.sourceTaskId,
    sourceTaskId: rel.sourceTaskId,
    targetTaskId: rel.targetTaskId,
  });
  await publishEvent("task-relation.refresh", {
    projectId: project.id,
    userId: "",
  });

  return { success: true };
}

export async function fullReorderSubtasks(
  link: ResolvedShareLink,
  parentTaskId: string,
  orderedTargetTaskIds: string[],
) {
  const project = await getFullLinkProject(link.resourceId);
  if (new Set(orderedTargetTaskIds).size !== orderedTargetTaskIds.length) {
    throw new HTTPException(400, { message: "Duplicate subtask IDs" });
  }
  const parent = await loadProjectTask(parentTaskId, project.id);
  if (await isTaskAgentControlled(parent.id)) {
    throw guestDenied();
  }
  for (const childId of orderedTargetTaskIds) {
    await loadProjectTask(childId, project.id);
    if (await isTaskAgentControlled(childId)) {
      throw guestDenied();
    }
  }

  const relations = await db
    .select({
      id: schema.taskRelationTable.id,
      targetTaskId: schema.taskRelationTable.targetTaskId,
    })
    .from(schema.taskRelationTable)
    .where(
      and(
        eq(schema.taskRelationTable.sourceTaskId, parent.id),
        eq(schema.taskRelationTable.relationType, "subtask"),
      ),
    );
  const relationByTaskId = new Map(
    relations.map((relation) => [relation.targetTaskId, relation.id]),
  );
  const orderedRelationIds: string[] = [];
  for (const childId of orderedTargetTaskIds) {
    const relationId = relationByTaskId.get(childId);
    if (!relationId) {
      throw notFound();
    }
    orderedRelationIds.push(relationId);
  }

  await db.transaction(async (tx) => {
    for (const [index, relationId] of orderedRelationIds.entries()) {
      await tx
        .update(schema.taskRelationTable)
        .set({ position: index })
        .where(eq(schema.taskRelationTable.id, relationId));
    }
    await audit(tx, link, "task-relation.reorder");
  });

  await publishEvent("task-relation.refresh", {
    projectId: project.id,
    userId: "",
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Labels (per-task rows scoped by taskId — verified project-local)
// ---------------------------------------------------------------------------

export async function fullCreateLabel(
  link: ResolvedShareLink,
  taskId: string,
  body: { name: string; color: string },
) {
  const project = await getFullLinkProject(link.resourceId);
  const task = await loadProjectTask(taskId, project.id);
  if (await isTaskAgentControlled(task.id)) {
    throw guestDenied();
  }

  const created = await db.transaction(async (tx) => {
    const [label] = await tx
      .insert(schema.labelTable)
      .values({
        taskId: task.id,
        workspaceId: project.workspaceId,
        name: body.name,
        color: body.color,
      })
      .onConflictDoNothing({
        target: [schema.labelTable.taskId, schema.labelTable.name],
      })
      .returning();
    if (!label) {
      throw new HTTPException(409, {
        message: "A label with this name already exists on the task",
      });
    }
    await audit(tx, link, "label.create");
    return label;
  });

  await publishEvent("task.label_created", {
    taskId: task.id,
    projectId: project.id,
    labelId: created.id,
    userId: "",
  });
  return created;
}

export async function fullDeleteLabel(link: ResolvedShareLink, labelId: string) {
  const project = await getFullLinkProject(link.resourceId);
  const [label] = await db
    .select({ id: schema.labelTable.id, taskId: schema.labelTable.taskId })
    .from(schema.labelTable)
    .where(eq(schema.labelTable.id, labelId))
    .limit(1);
  if (!label || !label.taskId) {
    throw notFound();
  }
  const task = await loadProjectTask(label.taskId, project.id);
  if (await isTaskAgentControlled(task.id)) {
    throw guestDenied();
  }

  await db.transaction(async (tx) => {
    await tx.delete(schema.labelTable).where(eq(schema.labelTable.id, label.id));
    await audit(tx, link, "label.delete");
  });

  await publishEvent("task.label_deleted", {
    taskId: task.id,
    projectId: project.id,
    labelId: label.id,
    userId: "",
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Guest task detail + relations read (project-scoped expansion)
// ---------------------------------------------------------------------------

export async function fullGetTaskDetail(link: ResolvedShareLink, taskId: string) {
  const project = await getFullLinkProject(link.resourceId);
  const task = await loadProjectTask(taskId, project.id);
  const agentControlled = await isTaskAgentControlled(task.id);

  const descriptionAllowed = !agentControlled &&
    !(await isProjectAgentControlledStrict(project.id));

  const labels = await db
    .select({
      id: schema.labelTable.id,
      name: schema.labelTable.name,
      color: schema.labelTable.color,
    })
    .from(schema.labelTable)
    .where(eq(schema.labelTable.taskId, task.id));

  // Relations only expand when BOTH endpoints live in the linked project.
  const relationRows = await db
    .select({
      id: schema.taskRelationTable.id,
      sourceTaskId: schema.taskRelationTable.sourceTaskId,
      targetTaskId: schema.taskRelationTable.targetTaskId,
      relationType: schema.taskRelationTable.relationType,
      position: schema.taskRelationTable.position,
    })
    .from(schema.taskRelationTable)
    .where(
      or(
        eq(schema.taskRelationTable.sourceTaskId, task.id),
        eq(schema.taskRelationTable.targetTaskId, task.id),
      ),
    );
  const endpointIds = [
    ...new Set(
      relationRows.flatMap((relation) => [relation.sourceTaskId, relation.targetTaskId]),
    ),
  ];
  const endpointTasks = endpointIds.length
    ? await db
        .select({
          id: schema.taskTable.id,
          title: schema.taskTable.title,
          status: schema.taskTable.status,
          priority: schema.taskTable.priority,
          number: schema.taskTable.number,
          projectId: schema.taskTable.projectId,
          position: schema.taskTable.position,
        })
        .from(schema.taskTable)
        .where(inArray(schema.taskTable.id, endpointIds))
    : [];
  const endpointsByProject = new Map(
    endpointTasks.map((endpoint) => [endpoint.id, endpoint]),
  );
  const relations = relationRows
    .map((relation) => ({
      id: relation.id,
      relationType: relation.relationType,
      position: relation.position,
      sourceTask: endpointsByProject.get(relation.sourceTaskId) ?? null,
      targetTask: endpointsByProject.get(relation.targetTaskId) ?? null,
    }))
    // Cross-project endpoints are never expanded for the guest.
    .filter((relation) => relation.sourceTask && relation.targetTask);

  // Activity is hidden together with the description when the task is
  // execution-linked — bot replies would leak the execution narrative.
  const activities = agentControlled
    ? []
    : await db
        .select({
          id: schema.activityTable.id,
          type: schema.activityTable.type,
          content: schema.activityTable.content,
          createdAt: schema.activityTable.createdAt,
          userId: schema.activityTable.userId,
          userName: schema.userTable.name,
          userImage: schema.userTable.image,
          externalUserName: schema.activityTable.externalUserName,
          externalSource: schema.activityTable.externalSource,
        })
        .from(schema.activityTable)
        .leftJoin(schema.userTable, eq(schema.activityTable.userId, schema.userTable.id))
        .where(eq(schema.activityTable.taskId, task.id))
        .orderBy(asc(schema.activityTable.createdAt));

  const actorName = (row: {
    userId: string | null;
    userName: string | null;
    externalUserName: string | null;
    externalSource: string | null;
  }) =>
    row.externalSource === "share-link"
      ? (row.externalUserName ?? GUEST_ACTOR_LABEL)
      : (row.userName ?? "Member");

  return {
    // Explicit field list: never leak executionState/taskRevision or other
    // internal columns through the capability detail payload.
    id: task.id,
    projectId: task.projectId,
    number: task.number,
    title: task.title,
    description: descriptionAllowed ? task.description : null,
    descriptionLocked: !descriptionAllowed,
    agentControlled,
    status: task.status,
    priority: task.priority,
    startDate: task.startDate,
    dueDate: task.dueDate,
    position: task.position,
    createdAt: task.createdAt,
    assigneeId: task.userId,
    labels,
    relations,
    comments: activities
      .filter((activity) => activity.type === "comment")
      .map((activity) => ({
        id: activity.id,
        content: activity.content,
        createdAt: activity.createdAt,
        authorName: actorName(activity),
        authorImage:
          activity.externalSource === "share-link" ? null : activity.userImage,
        isGuest: activity.externalSource === "share-link",
      })),
  };
}

export async function fullGetTaskRedactedSet(
  link: ResolvedShareLink,
  taskIds: string[],
) {
  return getRedactedTaskIds(link.resourceId, taskIds);
}

// ---------------------------------------------------------------------------
// Capability uploads (ticket + finalize with caps, MIME, actual-object checks)
// ---------------------------------------------------------------------------

const FULL_LINK_MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
const FULL_LINK_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const FULL_LINK_MAX_FILES_PER_RESOURCE = 20;

type UploadOwnerType = "task_description" | "task_comment" | "document";

type UploadOwnerSurface = {
  workspaceId: string;
  projectId: string;
  taskId: string | null;
  documentId: string | null;
  ownerType: UploadOwnerType;
  ownerId: string;
  surface: string;
};

async function resolveGuestUploadOwner(
  ownerType: UploadOwnerType,
  ownerId: string,
): Promise<UploadOwnerSurface> {
  if (ownerType === "task_description" || ownerType === "task_comment") {
    const [task] = await db
      .select({
        id: schema.taskTable.id,
        projectId: schema.taskTable.projectId,
        workspaceId: schema.projectTable.workspaceId,
      })
      .from(schema.taskTable)
      .innerJoin(schema.projectTable, eq(schema.taskTable.projectId, schema.projectTable.id))
      .where(eq(schema.taskTable.id, ownerId))
      .limit(1);
    if (!task) {
      throw notFound();
    }
    return {
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      documentId: null,
      ownerType,
      ownerId,
      surface: ownerType === "task_comment" ? "comment" : "description",
    };
  }

  const [document] = await db
    .select({
      id: schema.documentTable.id,
      projectId: schema.documentTable.projectId,
      archivedAt: schema.documentTable.archivedAt,
      workspaceId: schema.projectTable.workspaceId,
    })
    .from(schema.documentTable)
    .innerJoin(schema.projectTable, eq(schema.documentTable.projectId, schema.projectTable.id))
    .where(eq(schema.documentTable.id, ownerId))
    .limit(1);
  if (!document || document.archivedAt !== null) {
    throw notFound();
  }
  return {
    workspaceId: document.workspaceId,
    projectId: document.projectId,
    taskId: null,
    documentId: document.id,
    ownerType,
    ownerId,
    surface: "document",
  };
}

function assertUploadOwnerInLink(
  owner: UploadOwnerSurface,
  link: ResolvedShareLink,
) {
  if (owner.projectId !== link.resourceId) {
    throw notFound();
  }
}

async function assertGuestUploadTargetAllowed(
  owner: UploadOwnerSurface,
) {
  if (owner.taskId) {
    if (await isTaskAgentControlled(owner.taskId)) {
      throw guestDenied();
    }
    if (await isProjectAgentControlledStrict(owner.projectId)) {
      throw guestDenied();
    }
  }
}

function resourceAssetWhere(owner: UploadOwnerSurface) {
  if (owner.taskId) {
    return and(
      eq(schema.assetTable.taskId, owner.taskId),
      inArray(schema.assetTable.surface, ["description", "comment"]),
    );
  }
  return eq(schema.assetTable.documentId, owner.documentId ?? "");
}

export async function fullCreateUploadTicket(
  link: ResolvedShareLink,
  input: {
    ownerType: UploadOwnerType;
    ownerId: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  const project = await getFullLinkProject(link.resourceId);
  void project;
  const owner = await resolveGuestUploadOwner(input.ownerType, input.ownerId);
  assertUploadOwnerInLink(owner, link);
  await assertGuestUploadTargetAllowed(owner);

  try {
    validateFullLinkUploadInput(input.contentType, input.size);
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : "Invalid upload",
    });
  }
  if (input.size > FULL_LINK_MAX_BYTES_PER_FILE) {
    throw new HTTPException(400, {
      message: "Upload exceeds the 10MB per-file share-link limit.",
    });
  }

  const [usage, resourceCount] = await Promise.all([
    getFullLinkUploadUsage({ shareLinkId: link.id }),
    countResourceAssets(resourceAssetWhere(owner)),
  ]);
  if (usage.totalSize + input.size > FULL_LINK_MAX_TOTAL_BYTES) {
    throw new HTTPException(400, {
      message: "Share-link upload quota exceeded (100MB total).",
    });
  }
  if (resourceCount >= FULL_LINK_MAX_FILES_PER_RESOURCE) {
    throw new HTTPException(400, {
      message: "This resource already has the maximum number of files.",
    });
  }

  const upload = await createContentAssetUploadUrl({
    workspaceId: owner.workspaceId,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    filename: input.filename,
    contentType: input.contentType,
  });
  await appendShareActionAudit(link, "asset.upload-ticket");
  return upload;
}

export async function fullFinalizeUpload(
  link: ResolvedShareLink,
  input: {
    ownerType: UploadOwnerType;
    ownerId: string;
    key: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  const project = await getFullLinkProject(link.resourceId);
  void project;
  const owner = await resolveGuestUploadOwner(input.ownerType, input.ownerId);
  assertUploadOwnerInLink(owner, link);
  await assertGuestUploadTargetAllowed(owner);

  try {
    validateFullLinkUploadInput(input.contentType, input.size);
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : "Invalid upload",
    });
  }

  const normalizedKey = input.key.trim();
  // Key must belong to exactly this owner surface — no cross-resource writes.
  if (
    !normalizedKey.startsWith(
      `workspace/${owner.workspaceId}/content/${owner.ownerType}/${owner.ownerId}/`,
    )
  ) {
    throw new HTTPException(400, {
      message: "Upload key does not match the content resource.",
    });
  }

  // Verify the ACTUAL staged object before trusting declared metadata.
  let actual: { contentType?: string; contentLength?: number };
  try {
    actual = await getPrivateObjectMeta(normalizedKey);
  } catch {
    throw new HTTPException(404, {
      message: "Staged upload not found. Upload the file first.",
    });
  }
  const actualLength = actual.contentLength ?? 0;
  const actualType = (actual.contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (actualLength <= 0 || actualLength !== input.size) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "Uploaded file size does not match the finalized metadata.",
    });
  }
  if (actualType !== input.contentType.toLowerCase().split(";")[0]?.trim()) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "Uploaded file type does not match the finalized metadata.",
    });
  }
  if (actualLength > FULL_LINK_MAX_BYTES_PER_FILE) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "Upload exceeds the 10MB per-file share-link limit.",
    });
  }

  const [usage, resourceCount] = await Promise.all([
    getFullLinkUploadUsage({ shareLinkId: link.id }),
    countResourceAssets(resourceAssetWhere(owner)),
  ]);
  if (usage.totalSize + actualLength > FULL_LINK_MAX_TOTAL_BYTES) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "Share-link upload quota exceeded (100MB total).",
    });
  }
  if (resourceCount >= FULL_LINK_MAX_FILES_PER_RESOURCE) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "This resource already has the maximum number of files.",
    });
  }

  const [existing] = await db
    .select({ id: schema.assetTable.id })
    .from(schema.assetTable)
    .where(eq(schema.assetTable.objectKey, normalizedKey))
    .limit(1);

  const values = {
    workspaceId: owner.workspaceId,
    projectId: owner.projectId,
    taskId: owner.taskId,
    documentId: owner.documentId,
    goalCheckinId: null,
    filename: input.filename,
    mimeType: actualType,
    size: actualLength,
    kind: actualType.startsWith("image/") ? "image" : "attachment",
    surface: owner.surface,
    // Created by the capability, not a user.
    createdBy: null,
  };

  let assetId: string;
  try {
    assetId = await db.transaction(async (tx) => {
      const [row] = existing
        ? await tx
            .update(schema.assetTable)
            .set(values)
            .where(eq(schema.assetTable.id, existing.id))
            .returning({ id: schema.assetTable.id })
        : await tx
            .insert(schema.assetTable)
            .values({ ...values, objectKey: normalizedKey })
            .returning({ id: schema.assetTable.id });
      if (!row) {
        throw new HTTPException(500, { message: "Failed to persist asset" });
      }
      // Audit row carries the asset id so per-link quota accounting stays
      // exact; both commits roll back together.
      await appendShareActionAudit(link, "asset.finalize", tx, row.id);
      return row.id;
    });
  } catch (error) {
    // Transaction failed: the staged object must never stay addressable.
    await deleteS3Object(normalizedKey).catch(() => {});
    throw error;
  }

  await publishEvent("asset.created", {
    taskId: owner.taskId ?? undefined,
    projectId: owner.projectId,
  });

  return {
    id: assetId,
    filename: input.filename,
    mimeType: actualType,
    size: actualLength,
  };
}

export function isProjectManifestLocked(projectId: string) {
  return isProjectAgentControlledStrict(projectId);
}
