// SPEC-2026-11-10-kaneo-card-agent-collaboration T4: card-focused wrappers
// behind the bound session. Exactly the ten tools the spec allows; root
// actions accept no target id, child/asset/comment ids only flow through
// their named helper, and the API rechecks subtree membership per call.
// Every write CASes on contentRevision and returns the fresh revision.
import { and, asc, count, desc, eq, gt, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import {
  assertContentAssetKeyMatchesContext,
  createContentAssetUploadUrl,
  deleteS3Object,
  getPrivateObjectMeta,
  getPrivateObjectPrefix,
  validateFullLinkUploadInput,
} from "../storage/s3";
import { assertTaskContentRevision } from "../task/content-revision";
import { normalizeWorkMarkerCounts } from "../task/work-marker-counts";
import { claimTaskNumber } from "../task/controllers/claim-task-numbers";
import { lockProjectTaskLanes } from "../task/lock-project-task-lanes";
import {
  assertValidPriority,
  assertValidTaskStatus,
  VIRTUAL_STATUSES,
} from "../task/validate-task-fields";
import { loadScopedBinding } from "./binding-service";

const notFound = () => new HTTPException(404, { message: "Not found" });

// Mirrors the share-link image signature check (PNG/JPEG/GIF/WEBP magic
// bytes) without importing share-module internals.
function hasValidImageSignature(contentType: string, prefix: Uint8Array) {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...prefix.subarray(offset, offset + length));
  if (contentType === "image/png") {
    return (
      prefix.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every(
        (value, index) => prefix[index] === value,
      )
    );
  }
  if (contentType === "image/jpeg") {
    return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8;
  }
  if (contentType === "image/gif") {
    return prefix.length >= 6 && ascii(0, 3) === "GIF";
  }
  if (contentType === "image/webp") {
    return (
      prefix.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP"
    );
  }
  return false;
}

export type BindingScope = Awaited<
  ReturnType<typeof loadScopedBinding>
>["scope"];

type BindingContext = {
  userId: string;
  bindingId: string;
  sessionId: string;
  generation: number;
};

type ShareTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function assertInScope(scope: BindingScope, taskId: string) {
  const task = scope.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw notFound();
  return task;
}

async function assertDescriptionAllowed(scope: BindingScope, hasDescription: boolean) {
  const [manifest] = await db
    .select({ id: schema.executionManifestTable.id })
    .from(schema.executionManifestTable)
    .where(eq(schema.executionManifestTable.projectId, scope.projectId))
    .limit(1);
  if (manifest && hasDescription) {
    throw new HTTPException(403, {
      message:
        "Descriptions are read-only in manifest projects; this binding cannot write them.",
    });
  }
}

// --- reads -----------------------------------------------------------------

export async function bindingCardGet(ctx: BindingContext) {
  const { scope } = await loadScopedBinding(ctx);
  const columns = await loadColumns(scope.projectId);
  const labelMap = new Map(columns.map((column) => [column.slug, column.name]));
  const root = scope.tasks.find((task) => task.id === scope.rootTaskId);
  if (!root) throw notFound();
  const labels = await db
    .select({
      id: schema.labelTable.id,
      name: schema.labelTable.name,
      color: schema.labelTable.color,
      taskId: schema.labelTable.taskId,
    })
    .from(schema.labelTable)
    .where(
      inArray(
        schema.labelTable.taskId,
        scope.tasks.map((task) => task.id),
      ),
    );
  const subtaskCount = scope.tasks.length - 1;
  return {
    card: {
      id: root.id,
      number: root.number,
      title: root.title,
      description: root.description,
      status: root.status,
      statusLabel: labelMap.get(root.status) ?? null,
      priority: root.priority,
      startDate: root.startDate,
      dueDate: root.dueDate,
      contentRevision: root.contentRevision,
      workMarkerCounts: normalizeWorkMarkerCounts(root.workMarkerCounts),
      labels: labels
        .filter((label) => label.taskId === root.id)
        .map(({ id, name, color }) => ({ id, name, color })),
    },
    statusOptions: columns.map((column) => ({
      slug: column.slug,
      name: column.name,
      isFinal: column.isFinal,
    })),
    subtasks: scope.tasks
      .filter((task) => task.id !== scope.rootTaskId)
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        statusLabel: labelMap.get(task.status) ?? null,
        contentRevision: task.contentRevision,
      })),
    subtaskCount,
  };
}

async function loadColumns(projectId: string) {
  return db
    .select({
      slug: schema.columnTable.slug,
      name: schema.columnTable.name,
      isFinal: schema.columnTable.isFinal,
    })
    .from(schema.columnTable)
    .where(eq(schema.columnTable.projectId, projectId))
    .orderBy(asc(schema.columnTable.position));
}

// --- writes ----------------------------------------------------------------

function stripCapabilityAssetTokens(content: string) {
  return content.replace(
    /(?:https?:\/\/[^/\s]+)?\/api\/share\/(?:task|project)\/[A-Za-z0-9_-]+\/asset\/([A-Za-z0-9_-]+)/g,
    "/asset/$1",
  );
}

export async function bindingCardUpdate(
  ctx: BindingContext,
  body: {
    patch: {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      startDate?: string | null;
      dueDate?: string | null;
    };
    expectedContentRevision: number;
  },
) {
  const { scope } = await loadScopedBinding(ctx);
  const task = assertInScope(scope, scope.rootTaskId);
  await assertDescriptionAllowed(scope, body.patch.description !== undefined);

  const updates: Partial<typeof schema.taskTable.$inferInsert> = {};
  if (body.patch.title !== undefined) updates.title = body.patch.title;
  if (body.patch.description !== undefined) {
    updates.description = stripCapabilityAssetTokens(body.patch.description);
  }
  if (body.patch.priority !== undefined) {
    assertValidPriority(body.patch.priority);
    updates.priority = body.patch.priority;
  }
  if (body.patch.status !== undefined && body.patch.status !== task.status) {
    await assertValidTaskStatus(body.patch.status, scope.projectId);
    if (
      VIRTUAL_STATUSES.includes(
        body.patch.status as (typeof VIRTUAL_STATUSES)[number],
      )
    ) {
      throw new HTTPException(400, {
        message: "Bindings cannot set planned or archived status",
      });
    }
    updates.status = body.patch.status;
  }
  if (body.patch.startDate !== undefined) {
    updates.startDate = body.patch.startDate
      ? new Date(body.patch.startDate)
      : null;
  }
  if (body.patch.dueDate !== undefined) {
    updates.dueDate = body.patch.dueDate
      ? new Date(body.patch.dueDate)
      : null;
  }
  if (Object.keys(updates).length === 0) {
    throw new HTTPException(400, { message: "No valid card fields to update" });
  }

  return db.transaction(async (tx) => {
    if (updates.status !== undefined) {
      await lockProjectTaskLanes(tx, [scope.projectId]);
    }
    const [locked] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id))
      .for("update")
      .limit(1);
    if (!locked) throw notFound();
    await assertTaskContentRevision(tx, task.id, body.expectedContentRevision);
    if (updates.status !== undefined) {
      const [column] = await tx
        .select({ id: schema.columnTable.id })
        .from(schema.columnTable)
        .where(
          and(
            eq(schema.columnTable.projectId, scope.projectId),
            eq(schema.columnTable.slug, updates.status),
          ),
        )
        .for("update")
        .limit(1);
      updates.columnId = column?.id ?? null;
    }
    const [row] = await tx
      .update(schema.taskTable)
      .set({ ...updates, contentRevision: locked.contentRevision + 1 })
      .where(eq(schema.taskTable.id, task.id))
      .returning();
    if (!row) throw notFound();
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      contentRevision: row.contentRevision,
    };
  });
}

async function loadRelation(
  tx: ShareTransaction,
  parentTaskId: string,
  childTaskId: string,
) {
  const [relation] = await tx
    .select()
    .from(schema.taskRelationTable)
    .where(
      and(
        eq(schema.taskRelationTable.sourceTaskId, parentTaskId),
        eq(schema.taskRelationTable.targetTaskId, childTaskId),
        eq(schema.taskRelationTable.relationType, "subtask"),
      ),
    )
    .limit(1);
  if (!relation) throw notFound();
  return relation;
}

export async function bindingCardCreateSubtask(
  ctx: BindingContext,
  body: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    expectedParentContentRevision: number;
  },
) {
  const { scope } = await loadScopedBinding(ctx);
  const parent = assertInScope(scope, scope.rootTaskId);
  await assertDescriptionAllowed(scope, body.description !== undefined);
  const status = body.status || "to-do";
  const priority = body.priority || "no-priority";
  await assertValidTaskStatus(status, scope.projectId);
  if (VIRTUAL_STATUSES.includes(status as (typeof VIRTUAL_STATUSES)[number])) {
    throw new HTTPException(400, {
      message: "Bindings cannot set planned or archived status",
    });
  }
  assertValidPriority(priority);

  return db.transaction(async (tx) => {
    await lockProjectTaskLanes(tx, [scope.projectId]);
    const [lockedParent] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, parent.id))
      .for("update")
      .limit(1);
    if (!lockedParent) throw notFound();
    await assertTaskContentRevision(
      tx,
      parent.id,
      body.expectedParentContentRevision,
    );
    const taskNumber = await claimTaskNumber(scope.projectId, tx);
    const [column] = await tx
      .select({ id: schema.columnTable.id })
      .from(schema.columnTable)
      .where(
        and(
          eq(schema.columnTable.projectId, scope.projectId),
          eq(schema.columnTable.slug, status),
        ),
      )
      .limit(1);
    const [child] = await tx
      .insert(schema.taskTable)
      .values({
        projectId: scope.projectId,
        title: body.title,
        description: body.description
          ? stripCapabilityAssetTokens(body.description)
          : null,
        status,
        columnId: column?.id ?? null,
        priority,
        position: 0,
        number: taskNumber,
      })
      .returning();
    if (!child) throw new HTTPException(500, { message: "Failed to create subtask" });
    const [relation] = await tx
      .insert(schema.taskRelationTable)
      .values({
        sourceTaskId: parent.id,
        targetTaskId: child.id,
        relationType: "subtask",
        position: 0,
      })
      .returning();
    if (!relation) throw new HTTPException(500, { message: "Failed to link subtask" });
    const [updatedParent] = await tx
      .update(schema.taskTable)
      .set({ contentRevision: lockedParent.contentRevision + 1 })
      .where(eq(schema.taskTable.id, parent.id))
      .returning();
    if (!updatedParent) throw notFound();
    return {
      subtask: {
        id: child.id,
        title: child.title,
        status: child.status,
        contentRevision: child.contentRevision,
      },
      relationId: relation.id,
      parentContentRevision: updatedParent.contentRevision,
    };
  });
}

export async function bindingCardUpdateSubtask(
  ctx: BindingContext,
  subtaskId: string,
  body: {
    patch: {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      startDate?: string | null;
      dueDate?: string | null;
    };
    expectedContentRevision: number;
  },
) {
  const { scope } = await loadScopedBinding(ctx);
  const task = assertInScope(scope, subtaskId);
  if (task.id === scope.rootTaskId) {
    throw new HTTPException(400, {
      message: "use the root card update for the bound card itself",
    });
  }
  await assertDescriptionAllowed(scope, body.patch.description !== undefined);

  const updates: Partial<typeof schema.taskTable.$inferInsert> = {};
  if (body.patch.title !== undefined) updates.title = body.patch.title;
  if (body.patch.description !== undefined) {
    updates.description = stripCapabilityAssetTokens(body.patch.description);
  }
  if (body.patch.priority !== undefined) {
    assertValidPriority(body.patch.priority);
    updates.priority = body.patch.priority;
  }
  if (body.patch.status !== undefined && body.patch.status !== task.status) {
    await assertValidTaskStatus(body.patch.status, scope.projectId);
    if (
      VIRTUAL_STATUSES.includes(
        body.patch.status as (typeof VIRTUAL_STATUSES)[number],
      )
    ) {
      throw new HTTPException(400, {
        message: "Bindings cannot set planned or archived status",
      });
    }
    updates.status = body.patch.status;
  }
  if (body.patch.startDate !== undefined) {
    updates.startDate = body.patch.startDate
      ? new Date(body.patch.startDate)
      : null;
  }
  if (body.patch.dueDate !== undefined) {
    updates.dueDate = body.patch.dueDate
      ? new Date(body.patch.dueDate)
      : null;
  }
  if (Object.keys(updates).length === 0) {
    throw new HTTPException(400, { message: "No valid subtask fields to update" });
  }

  return db.transaction(async (tx) => {
    if (updates.status !== undefined) {
      await lockProjectTaskLanes(tx, [scope.projectId]);
    }
    const [locked] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id))
      .for("update")
      .limit(1);
    if (!locked) throw notFound();
    await assertTaskContentRevision(tx, task.id, body.expectedContentRevision);
    if (updates.status !== undefined) {
      const [column] = await tx
        .select({ id: schema.columnTable.id })
        .from(schema.columnTable)
        .where(
          and(
            eq(schema.columnTable.projectId, scope.projectId),
            eq(schema.columnTable.slug, updates.status),
          ),
        )
        .for("update")
        .limit(1);
      updates.columnId = column?.id ?? null;
    }
    const [row] = await tx
      .update(schema.taskTable)
      .set({ ...updates, contentRevision: locked.contentRevision + 1 })
      .where(eq(schema.taskTable.id, task.id))
      .returning();
    if (!row) throw notFound();
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      contentRevision: row.contentRevision,
    };
  });
}

export async function bindingCardDeleteSubtask(
  ctx: BindingContext,
  subtaskId: string,
  body: { expectedParentContentRevision: number },
) {
  const { scope } = await loadScopedBinding(ctx);
  const task = assertInScope(scope, subtaskId);
  if (task.id === scope.rootTaskId) {
    throw new HTTPException(400, {
      message: "the bound root card cannot be deleted through the binding",
    });
  }
  // Descendant-only: the target must NOT be an ancestor of the root — with a
  // subtree scope this is implied, but re-verify the direct edge exists.
  return db.transaction(async (tx) => {
    const parent = assertInScope(scope, scope.rootTaskId);
    await loadRelation(tx, parent.id, task.id);
    const [lockedParent] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, parent.id))
      .for("update")
      .limit(1);
    if (!lockedParent) throw notFound();
    await assertTaskContentRevision(
      tx,
      parent.id,
      body.expectedParentContentRevision,
    );
    await tx.delete(schema.taskTable).where(eq(schema.taskTable.id, task.id));
    const [updatedParent] = await tx
      .update(schema.taskTable)
      .set({ contentRevision: lockedParent.contentRevision + 1 })
      .where(eq(schema.taskTable.id, parent.id))
      .returning();
    if (!updatedParent) throw notFound();
    return {
      deletedSubtaskId: task.id,
      parentContentRevision: updatedParent.contentRevision,
    };
  });
}

const COMMENTS_DEFAULT_LIMIT = 10;
const COMMENTS_MAX_LIMIT = 50;

export async function bindingCardListComments(
  ctx: BindingContext,
  rawLimit?: number,
  cursor?: string,
) {
  const { scope } = await loadScopedBinding(ctx);
  assertInScope(scope, scope.rootTaskId);
  const limit = Math.min(
    Math.max(Math.floor(rawLimit ?? COMMENTS_DEFAULT_LIMIT), 1),
    COMMENTS_MAX_LIMIT,
  );
  const conditions = [
    eq(schema.activityTable.taskId, scope.rootTaskId),
    eq(schema.activityTable.type, "comment"),
  ];
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conditions.push(eq(schema.activityTable.createdAt, cursorDate));
    }
  }
  const rows = await db
    .select({
      id: schema.activityTable.id,
      content: schema.activityTable.content,
      createdAt: schema.activityTable.createdAt,
      authorName: schema.userTable.name,
      externalUserName: schema.activityTable.externalUserName,
    })
    .from(schema.activityTable)
    .leftJoin(
      schema.userTable,
      eq(schema.activityTable.userId, schema.userTable.id),
    )
    .where(and(...conditions))
    .orderBy(desc(schema.activityTable.createdAt))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      content: row.content ?? "",
      createdAt: row.createdAt,
      authorName: row.authorName ?? row.externalUserName ?? "Unknown",
    })),
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

export async function bindingCardCreateComment(
  ctx: BindingContext,
  content: string,
) {
  const { binding, scope } = await loadScopedBinding(ctx);
  assertInScope(scope, scope.rootTaskId);
  const [comment] = await db
    .insert(schema.activityTable)
    .values({
      taskId: scope.rootTaskId,
      type: "comment",
      userId: null,
      content,
      externalUserName: `Bound session ${binding.sessionId.slice(0, 8)}`,
      externalSource: "agent-binding",
    })
    .returning();
  if (!comment) throw new HTTPException(500, { message: "Failed to create comment" });
  return {
    id: comment.id,
    content: comment.content ?? "",
    createdAt: comment.createdAt,
  };
}

export async function bindingCardUpdateWorkMarkers(
  ctx: BindingContext,
  body: { workMarkerCounts: unknown; expectedContentRevision: number },
) {
  const { scope } = await loadScopedBinding(ctx);
  const task = assertInScope(scope, scope.rootTaskId);
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id))
      .for("update")
      .limit(1);
    if (!locked) throw notFound();
    await assertTaskContentRevision(tx, task.id, body.expectedContentRevision);
    const [row] = await tx
      .update(schema.taskTable)
      .set({
        workMarkerCounts: normalizeWorkMarkerCounts(body.workMarkerCounts),
        contentRevision: locked.contentRevision + 1,
      })
      .where(eq(schema.taskTable.id, task.id))
      .returning();
    if (!row) throw notFound();
    return {
      workMarkerCounts: normalizeWorkMarkerCounts(row.workMarkerCounts),
      contentRevision: row.contentRevision,
    };
  });
}

// Formal-run claim fence: an ad-hoc binding loses the card to the run.
// Called inside the claim transaction while the run rows are locked.
export async function fenceBindingForRunClaim(
  tx: ShareTransaction,
  taskId: string,
) {
  const [binding] = await tx
    .select()
    .from(schema.agentSessionBindingTable)
    .where(
      and(
        eq(schema.agentSessionBindingTable.taskId, taskId),
        eq(schema.agentSessionBindingTable.status, "active"),
      ),
    )
    .for("update")
    .limit(1);
  if (!binding) return;

  // A claimed delivery inside its 60s lease blocks the claim: the Pi side
  // may be mid-send and must ack or time out first.
  const [inFlight] = await tx
    .select({ id: schema.agentSessionDeliveryTable.id })
    .from(schema.agentSessionDeliveryTable)
    .where(
      and(
        eq(schema.agentSessionDeliveryTable.bindingId, binding.id),
        eq(schema.agentSessionDeliveryTable.state, "claimed"),
        gt(
          schema.agentSessionDeliveryTable.claimedLeaseExpiresAt,
          new Date(),
        ),
      ),
    )
    .limit(1);
  if (inFlight) {
    throw new HTTPException(409, {
      message: "ad-hoc-delivery-in-flight",
    });
  }

  // Queue/claimed deliveries beyond the lease die with the binding.
  await tx
    .update(schema.agentSessionDeliveryTable)
    .set({ state: "stale", updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentSessionDeliveryTable.bindingId, binding.id),
        inArray(schema.agentSessionDeliveryTable.state, ["queued", "claimed"]),
      ),
    );
  await tx
    .update(schema.agentSessionBindingTable)
    .set({
      status: "revoked",
      revokedAt: new Date(),
      revokedReason: "formal_run_claim",
      bindingGeneration: binding.bindingGeneration + 1,
      updatedAt: new Date(),
    })
    .where(eq(schema.agentSessionBindingTable.id, binding.id));
}

// --- assets ----------------------------------------------------------------

const BINDING_MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
const BINDING_MAX_FILES_PER_RESOURCE = 20;

async function resolveUploadOwner(
  ownerType: "task_description" | "task_comment",
  ownerId: string,
) {
  const [task] = await db
    .select({
      id: schema.taskTable.id,
      projectId: schema.taskTable.projectId,
      workspaceId: schema.projectTable.workspaceId,
    })
    .from(schema.taskTable)
    .innerJoin(
      schema.projectTable,
      eq(schema.taskTable.projectId, schema.projectTable.id),
    )
    .where(eq(schema.taskTable.id, ownerId))
    .limit(1);
  if (!task) throw notFound();
  return {
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    taskId: task.id,
    ownerType,
    ownerId,
    surface: ownerType === "task_comment" ? "comment" : "description",
  };
}

export async function bindingCardCreateUploadTicket(
  ctx: BindingContext,
  input: {
    ownerType: "task_description" | "task_comment";
    ownerId: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  const { scope } = await loadScopedBinding(ctx);
  assertInScope(scope, input.ownerId);
  const [manifest] = await db
    .select({ id: schema.executionManifestTable.id })
    .from(schema.executionManifestTable)
    .where(eq(schema.executionManifestTable.projectId, scope.projectId))
    .limit(1);
  if (manifest && input.ownerType === "task_description") {
    throw new HTTPException(403, {
      message: "Descriptions are read-only in manifest projects.",
    });
  }
  const owner = await resolveUploadOwner(input.ownerType, input.ownerId);
  try {
    validateFullLinkUploadInput(input.contentType, input.size);
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : "Invalid upload",
    });
  }
  if (input.size > BINDING_MAX_BYTES_PER_FILE) {
    throw new HTTPException(400, {
      message: "Upload exceeds the 10MB per-file binding limit.",
    });
  }
  const [row] = await db
    .select({ fileCount: count() })
    .from(schema.assetTable)
    .where(
      and(
        eq(schema.assetTable.taskId, owner.taskId),
        inArray(schema.assetTable.surface, ["description", "comment"]),
      ),
    );
  if (Number(row?.fileCount ?? 0) >= BINDING_MAX_FILES_PER_RESOURCE) {
    throw new HTTPException(400, {
      message: "This resource already has the maximum number of files.",
    });
  }
  return createContentAssetUploadUrl({
    workspaceId: owner.workspaceId,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    filename: input.filename,
    contentType: input.contentType,
  });
}

export async function bindingCardFinalizeUpload(
  ctx: BindingContext,
  input: {
    ownerType: "task_description" | "task_comment";
    ownerId: string;
    key: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  const { scope } = await loadScopedBinding(ctx);
  assertInScope(scope, input.ownerId);
  const [manifest] = await db
    .select({ id: schema.executionManifestTable.id })
    .from(schema.executionManifestTable)
    .where(eq(schema.executionManifestTable.projectId, scope.projectId))
    .limit(1);
  if (manifest && input.ownerType === "task_description") {
    throw new HTTPException(403, {
      message: "Descriptions are read-only in manifest projects.",
    });
  }
  const owner = await resolveUploadOwner(input.ownerType, input.ownerId);

  const normalizedKey = input.key.trim();
  if (
    !assertContentAssetKeyMatchesContext(normalizedKey, {
      workspaceId: owner.workspaceId,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
    })
  ) {
    throw new HTTPException(400, {
      message: "Upload key does not match the content resource.",
    });
  }
  try {
    validateFullLinkUploadInput(input.contentType, input.size);
  } catch (error) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : "Invalid upload",
    });
  }
  if (input.size > BINDING_MAX_BYTES_PER_FILE) {
    await deleteS3Object(normalizedKey).catch(() => {});
    throw new HTTPException(400, {
      message: "Upload exceeds the 10MB per-file binding limit.",
    });
  }

  let actual: { contentType?: string; contentLength?: number };
  try {
    actual = await getPrivateObjectMeta(normalizedKey);
  } catch {
    throw new HTTPException(404, {
      message: "Staged upload not found. Upload the file first.",
    });
  }
  const actualLength = actual.contentLength ?? 0;
  const actualType =
    (actual.contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
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
  if (actualType.startsWith("image/")) {
    let prefix: Uint8Array;
    try {
      prefix = await getPrivateObjectPrefix(normalizedKey);
    } catch {
      await deleteS3Object(normalizedKey).catch(() => {});
      throw new HTTPException(503, {
        message: "Could not verify the uploaded image. Try uploading it again.",
      });
    }
    if (!hasValidImageSignature(actualType, prefix)) {
      await deleteS3Object(normalizedKey).catch(() => {});
      throw new HTTPException(400, {
        message: "Uploaded image bytes do not match the declared image type.",
      });
    }
  }

  const [duplicateKey] = await db
    .select({ id: schema.assetTable.id })
    .from(schema.assetTable)
    .where(eq(schema.assetTable.objectKey, normalizedKey))
    .limit(1);
  if (duplicateKey) {
    throw new HTTPException(409, {
      message: "This upload key has already been finalized.",
    });
  }

  const [row] = await db
    .insert(schema.assetTable)
    .values({
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
      taskId: owner.taskId,
      documentId: null,
      goalCheckinId: null,
      filename: input.filename,
      mimeType: actualType,
      size: actualLength,
      kind: actualType.startsWith("image/") ? "image" : "attachment",
      surface: owner.surface,
      createdBy: null,
      objectKey: normalizedKey,
    })
    .returning({ id: schema.assetTable.id });
  if (!row) {
    throw new HTTPException(500, { message: "Failed to persist asset" });
  }
  return {
    id: row.id,
    filename: input.filename,
    mimeType: actualType,
    size: actualLength,
  };
}

// Asset reads re-check the asset's task is STILL in the current subtree.
export async function canBindingReadAsset(
  scope: BindingScope,
  asset: { taskId: string | null; surface: string },
) {
  if (!asset.taskId) return false;
  if (!["description", "comment"].includes(asset.surface)) return false;
  return scope.tasks.some((candidate) => candidate.id === asset.taskId);
}

