// SPEC-2026-11-10-kaneo-card-agent-collaboration T5: durable, bounded
// comment-to-Pi outbox. The row stores only a pinned comment timestamp/hash,
// never a duplicate transcript. Claim returns text once to the exact
// binding/session/generation; expired claimed attempts become `unknown` and
// are never automatically replayed.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { extractAssetIds } from "../storage/cleanup-assets";
import { assertUserWorkspacePermission } from "../utils/require-workspace-permission";
import { getOwnedAgentPrincipal } from "./binding-service";
import { resolveTaskSubtreeScope } from "../share/task-share-access";

const staleBinding = () =>
  new HTTPException(409, { message: "stale_binding" });
const formalRunActive = () =>
  new HTTPException(409, { message: "formal-run-active" });

const CLAIM_LEASE_MS = 60_000;
const QUEUE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_POLL_WAIT_MS = 25_000;
const MAX_POLL_WAIT_MS = 25_000;
const POLL_INTERVAL_MS = 500;

type Delivery = typeof schema.agentSessionDeliveryTable.$inferSelect;
type DeliveryTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ScopedInput = {
  userId: string;
  bindingId: string;
  sessionId: string;
  generation: number;
  requirePrincipalOwner?: boolean;
};

function hashComment(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function receipt(delivery: Delivery) {
  return {
    deliveryId: delivery.id,
    bindingId: delivery.bindingId,
    bindingGeneration: delivery.bindingGeneration,
    commentId: delivery.commentId,
    clientActionKey: delivery.clientActionKey,
    state: delivery.state,
    createdAt: delivery.createdAt,
    expiresAt: delivery.expiresAt,
    enqueuedAt: delivery.enqueuedAt,
  };
}

async function lockCurrentBinding(tx: DeliveryTransaction, input: ScopedInput) {
  const [candidate] = await tx
    .select()
    .from(schema.agentSessionBindingTable)
    .where(eq(schema.agentSessionBindingTable.id, input.bindingId))
    .limit(1);
  if (!candidate) throw staleBinding();

  // Match formal-run/rebind lock order: card tree first, binding row second.
  const [task] = await tx
    .select({ projectId: schema.taskTable.projectId })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, candidate.taskId))
    .for("update")
    .limit(1);
  if (!task || task.projectId !== candidate.projectId) throw staleBinding();

  let scope;
  try {
    scope = await resolveTaskSubtreeScope(candidate.taskId, candidate.projectId, tx);
    const lockedTaskIds = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const taskIds = scope.tasks
        .map((item) => item.id)
        .filter((id) => !lockedTaskIds.has(id))
        .sort();
      if (taskIds.length > 0) {
        await tx
          .select({ id: schema.taskTable.id })
          .from(schema.taskTable)
          .where(inArray(schema.taskTable.id, taskIds))
          .orderBy(asc(schema.taskTable.id))
          .for("update");
        for (const id of taskIds) lockedTaskIds.add(id);
      }
      const refreshed = await resolveTaskSubtreeScope(
        candidate.taskId,
        candidate.projectId,
        tx,
      );
      const unlocked = refreshed.tasks.some((item) => !lockedTaskIds.has(item.id));
      scope = refreshed;
      if (!unlocked) break;
      if (attempt === 3) throw staleBinding();
    }
  } catch (error) {
    if (error instanceof HTTPException && [403, 404, 409].includes(error.status)) {
      throw staleBinding();
    }
    throw error;
  }

  const [binding] = await tx
    .select()
    .from(schema.agentSessionBindingTable)
    .where(eq(schema.agentSessionBindingTable.id, input.bindingId))
    .for("update")
    .limit(1);
  if (
    !binding ||
    binding.status !== "active" ||
    binding.sessionId !== input.sessionId ||
    binding.bindingGeneration !== input.generation ||
    binding.projectId !== task.projectId
  ) {
    throw staleBinding();
  }
  if (input.requirePrincipalOwner) {
    await getOwnedAgentPrincipal(input.userId, binding.agentPrincipalId, tx);
  }
  const [project] = await tx
    .select({ workspaceId: schema.projectTable.workspaceId })
    .from(schema.projectTable)
    .where(eq(schema.projectTable.id, binding.projectId))
    .limit(1);
  if (!project) throw staleBinding();
  await assertUserWorkspacePermission(input.userId, project.workspaceId, {
    task: ["update"],
  });

  const [liveRun] = await tx
    .select({ id: schema.taskRunTable.id })
    .from(schema.taskRunTable)
    .where(
      and(
        eq(schema.taskRunTable.taskId, binding.taskId),
        inArray(schema.taskRunTable.state, ["queued", "in_progress"]),
      ),
    )
    .limit(1);
  if (liveRun) throw formalRunActive();
  return { binding, scope };
}

function isTerminal(state: string) {
  return ["enqueued", "stale", "expired", "failed_before_send", "unknown"].includes(state);
}

async function transitionExpiredRows(
  tx: DeliveryTransaction,
  bindingId: string,
  now: Date,
) {
  await tx
    .update(schema.agentSessionDeliveryTable)
    .set({ state: "expired", updatedAt: now })
    .where(
      and(
        eq(schema.agentSessionDeliveryTable.bindingId, bindingId),
        eq(schema.agentSessionDeliveryTable.state, "queued"),
        lte(schema.agentSessionDeliveryTable.expiresAt, now),
      ),
    );
  // A worker that claimed and disappeared may already have enqueued the
  // steer. Unknown is terminal; never turn it back into queued.
  await tx
    .update(schema.agentSessionDeliveryTable)
    .set({ state: "unknown", updatedAt: now })
    .where(
      and(
        eq(schema.agentSessionDeliveryTable.bindingId, bindingId),
        eq(schema.agentSessionDeliveryTable.state, "claimed"),
        lte(schema.agentSessionDeliveryTable.claimedLeaseExpiresAt, now),
      ),
    );
}

async function markQueuedCommentStale(
  tx: DeliveryTransaction,
  delivery: Delivery,
  now: Date,
) {
  if (!delivery.commentId) {
    const [row] = await tx
      .update(schema.agentSessionDeliveryTable)
      .set({ state: "stale", updatedAt: now })
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.id, delivery.id),
          eq(schema.agentSessionDeliveryTable.state, "queued"),
        ),
      )
      .returning();
    return row ?? delivery;
  }
  const [comment] = await tx
    .select({
      id: schema.activityTable.id,
      taskId: schema.activityTable.taskId,
      content: schema.activityTable.content,
      updatedAt: schema.activityTable.updatedAt,
      type: schema.activityTable.type,
      userId: schema.activityTable.userId,
      externalSource: schema.activityTable.externalSource,
    })
    .from(schema.activityTable)
    .where(eq(schema.activityTable.id, delivery.commentId))
    .for("update")
    .limit(1);
  const content = comment?.content ?? "";
  const unchanged = Boolean(
    comment &&
      comment.type === "comment" &&
      comment.taskId === delivery.taskId &&
      comment.externalSource !== "share-link" &&
      comment.updatedAt.getTime() === delivery.commentUpdatedAt?.getTime() &&
      hashComment(content) === delivery.commentContentHash,
  );
  if (unchanged) return delivery;
  const [row] = await tx
    .update(schema.agentSessionDeliveryTable)
    .set({ state: "stale", updatedAt: now })
    .where(
      and(
        eq(schema.agentSessionDeliveryTable.id, delivery.id),
        eq(schema.agentSessionDeliveryTable.state, "queued"),
      ),
    )
    .returning();
  return row ?? delivery;
}

export async function queueCommentDelivery(input: ScopedInput & {
  commentId: string;
  clientActionKey: string;
}) {
  const key = input.clientActionKey.trim();
  if (!key || key.length > 128) {
    throw new HTTPException(400, {
      message: "clientActionKey must be 1–128 characters",
    });
  }

  return db.transaction(async (tx) => {
    const { binding, scope } = await lockCurrentBinding(tx, input);
    const now = new Date();
    await transitionExpiredRows(tx, binding.id, now);
    const [existing] = await tx
      .select()
      .from(schema.agentSessionDeliveryTable)
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.bindingId, binding.id),
          eq(schema.agentSessionDeliveryTable.clientActionKey, key),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.commentId !== input.commentId) {
        throw new HTTPException(409, {
          message: "clientActionKey was already used for a different comment",
        });
      }
      const current =
        existing.state === "queued"
          ? await markQueuedCommentStale(tx, existing, now)
          : existing;
      return { duplicate: true, receipt: receipt(current) };
    }

    const [comment] = await tx
      .select({
        id: schema.activityTable.id,
        taskId: schema.activityTable.taskId,
        content: schema.activityTable.content,
        updatedAt: schema.activityTable.updatedAt,
        type: schema.activityTable.type,
        userId: schema.activityTable.userId,
        externalSource: schema.activityTable.externalSource,
      })
      .from(schema.activityTable)
      .where(eq(schema.activityTable.id, input.commentId))
      .for("update")
      .limit(1);
    if (
      !comment ||
      comment.type !== "comment" ||
      !scope.tasks.some((task) => task.id === comment.taskId) ||
      comment.externalSource === "share-link" ||
      comment.externalSource === "agent-binding"
    ) {
      throw new HTTPException(404, { message: "Comment is not sendable" });
    }

    const [delivery] = await tx
      .insert(schema.agentSessionDeliveryTable)
      .values({
        bindingId: binding.id,
        taskId: comment.taskId,
        bindingGeneration: binding.bindingGeneration,
        clientActionKey: key,
        commentId: comment.id,
        commentUpdatedAt: comment.updatedAt,
        commentContentHash: hashComment(comment.content ?? ""),
        state: "queued",
        expiresAt: new Date(now.getTime() + QUEUE_TTL_MS),
      })
      .onConflictDoNothing({
        target: [
          schema.agentSessionDeliveryTable.bindingId,
          schema.agentSessionDeliveryTable.clientActionKey,
        ],
      })
      .returning();
    if (delivery) return { duplicate: false, receipt: receipt(delivery) };

    // A concurrent request with the same idempotency key won the insert.
    const [winner] = await tx
      .select()
      .from(schema.agentSessionDeliveryTable)
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.bindingId, binding.id),
          eq(schema.agentSessionDeliveryTable.clientActionKey, key),
        ),
      )
      .limit(1);
    if (!winner || winner.commentId !== input.commentId) {
      throw new HTTPException(409, { message: "delivery idempotency conflict" });
    }
    return { duplicate: true, receipt: receipt(winner) };
  });
}

async function claimOneDelivery(input: ScopedInput) {
  return db.transaction(async (tx) => {
    const { binding, scope } = await lockCurrentBinding(tx, input);
    const now = new Date();
    await transitionExpiredRows(tx, binding.id, now);
    const [delivery] = await tx
      .select()
      .from(schema.agentSessionDeliveryTable)
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.bindingId, binding.id),
          eq(schema.agentSessionDeliveryTable.bindingGeneration, binding.bindingGeneration),
          eq(schema.agentSessionDeliveryTable.state, "queued"),
          gt(schema.agentSessionDeliveryTable.expiresAt, now),
        ),
      )
      .orderBy(asc(schema.agentSessionDeliveryTable.createdAt), asc(schema.agentSessionDeliveryTable.id))
      .for("update")
      .limit(1);
    if (!delivery) return { kind: "empty" as const };

    const current = await markQueuedCommentStale(tx, delivery, now);
    if (current.state !== "queued") return { kind: "stale" as const };
    const [comment] = await tx
      .select({ content: schema.activityTable.content })
      .from(schema.activityTable)
      .where(eq(schema.activityTable.id, delivery.commentId ?? ""))
      .limit(1);
    if (!comment) return { kind: "stale" as const };
    const content = comment.content ?? "";
    const mentionedIds = [...extractAssetIds(content)];
    const attachments = mentionedIds.length
      ? await tx
          .select({ id: schema.assetTable.id })
          .from(schema.assetTable)
          .where(
            and(
              inArray(schema.assetTable.id, mentionedIds),
              inArray(schema.assetTable.taskId, scope.tasks.map((task) => task.id)),
              eq(schema.assetTable.surface, "comment"),
            ),
          )
      : [];

    const [claimed] = await tx
      .update(schema.agentSessionDeliveryTable)
      .set({
        state: "claimed",
        claimedAt: now,
        claimedLeaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.id, delivery.id),
          eq(schema.agentSessionDeliveryTable.state, "queued"),
          eq(schema.agentSessionDeliveryTable.bindingGeneration, binding.bindingGeneration),
        ),
      )
      .returning();
    if (!claimed) return { kind: "stale" as const };
    return {
      kind: "claimed" as const,
      delivery: {
        deliveryId: claimed.id,
        bindingId: binding.id,
        bindingGeneration: binding.bindingGeneration,
        sessionId: binding.sessionId,
        hostId: binding.hostId,
        commentId: comment ? delivery.commentId : null,
        content,
        attachmentAssetIds: attachments.map((asset) => asset.id),
        claimedLeaseExpiresAt: claimed.claimedLeaseExpiresAt,
      },
    };
  });
}

export async function claimNextCommentDelivery(input: ScopedInput & {
  waitMs?: number;
  signal?: AbortSignal;
}) {
  const waitMs = Math.min(
    Math.max(Math.floor(input.waitMs ?? DEFAULT_POLL_WAIT_MS), 0),
    MAX_POLL_WAIT_MS,
  );
  const deadline = Date.now() + waitMs;
  do {
    if (input.signal?.aborted) return { delivery: null };
    const result = await claimOneDelivery({ ...input, requirePrincipalOwner: true });
    if (result.kind === "claimed") return { delivery: result.delivery };
    if (waitMs === 0 || Date.now() >= deadline) return { delivery: null };
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return { delivery: null };
}

export async function acknowledgeCommentDelivery(input: ScopedInput & {
  deliveryId: string;
  outcome: "enqueued" | "failed_before_send";
}) {
  return db.transaction(async (tx) => {
    const { binding } = await lockCurrentBinding(tx, {
      ...input,
      requirePrincipalOwner: true,
    });
    const [delivery] = await tx
      .select()
      .from(schema.agentSessionDeliveryTable)
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.id, input.deliveryId),
          eq(schema.agentSessionDeliveryTable.bindingId, binding.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!delivery) throw new HTTPException(404, { message: "Not found" });
    if (isTerminal(delivery.state)) return { receipt: receipt(delivery) };
    const now = new Date();
    if (
      delivery.state !== "claimed" ||
      delivery.bindingGeneration !== binding.bindingGeneration ||
      !delivery.claimedLeaseExpiresAt ||
      delivery.claimedLeaseExpiresAt.getTime() <= now.getTime()
    ) {
      if (delivery.state === "claimed") {
        const [unknown] = await tx
          .update(schema.agentSessionDeliveryTable)
          .set({ state: "unknown", updatedAt: now })
          .where(eq(schema.agentSessionDeliveryTable.id, delivery.id))
          .returning();
        return { receipt: receipt(unknown ?? { ...delivery, state: "unknown" }) };
      }
      throw new HTTPException(409, { message: "delivery is not claimed" });
    }
    const [updated] = await tx
      .update(schema.agentSessionDeliveryTable)
      .set({
        state: input.outcome,
        enqueuedAt: input.outcome === "enqueued" ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.id, delivery.id),
          eq(schema.agentSessionDeliveryTable.state, "claimed"),
          eq(schema.agentSessionDeliveryTable.bindingGeneration, binding.bindingGeneration),
        ),
      )
      .returning();
    if (!updated) throw staleBinding();
    return { receipt: receipt(updated) };
  });
}

async function refreshDelivery(delivery: Delivery) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.agentSessionDeliveryTable)
      .where(eq(schema.agentSessionDeliveryTable.id, delivery.id))
      .for("update")
      .limit(1);
    if (!current) throw new HTTPException(404, { message: "Not found" });
    const now = new Date();
    if (current.state === "queued" && current.expiresAt.getTime() <= now.getTime()) {
      const [updated] = await tx
        .update(schema.agentSessionDeliveryTable)
        .set({ state: "expired", updatedAt: now })
        .where(eq(schema.agentSessionDeliveryTable.id, current.id))
        .returning();
      return updated ?? { ...current, state: "expired" };
    }
    if (
      current.state === "claimed" &&
      current.claimedLeaseExpiresAt &&
      current.claimedLeaseExpiresAt.getTime() <= now.getTime()
    ) {
      const [updated] = await tx
        .update(schema.agentSessionDeliveryTable)
        .set({ state: "unknown", updatedAt: now })
        .where(eq(schema.agentSessionDeliveryTable.id, current.id))
        .returning();
      return updated ?? { ...current, state: "unknown" };
    }
    if (current.state === "queued") {
      const refreshed = await markQueuedCommentStale(tx, current, now);
      return refreshed;
    }
    return current;
  });
}

export async function getCommentDeliveryStatus(input: {
  bindingId: string;
  deliveryId: string;
}) {
  const [delivery] = await db
    .select()
    .from(schema.agentSessionDeliveryTable)
    .where(
      and(
        eq(schema.agentSessionDeliveryTable.bindingId, input.bindingId),
        eq(schema.agentSessionDeliveryTable.id, input.deliveryId),
      ),
    )
    .limit(1);
  if (!delivery) throw new HTTPException(404, { message: "Not found" });
  return receipt(await refreshDelivery(delivery));
}

export async function markQueuedCommentDeliveriesStale(commentId: string) {
  await markQueuedCommentDeliveriesStaleWith(db, commentId);
}

// Transactional variant so the comment mutation and its delivery invalidation
// commit atomically; the fire-and-forget wrapper stays for callers outside a
// transaction.
export async function markQueuedCommentDeliveriesStaleWith(
  executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  commentId: string,
) {
  await executor
    .update(schema.agentSessionDeliveryTable)
    .set({ state: "stale", updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentSessionDeliveryTable.commentId, commentId),
        eq(schema.agentSessionDeliveryTable.state, "queued"),
      ),
    );
}

// Read-only: latest receipt for one comment on this binding. Workspace
// member scope (no principal ownership check) so the sender can restore the
// last receipt state after a page reload; receipts carry no comment content.
export async function getLatestDeliveryForComment(input: {
  userId: string;
  bindingId: string;
  commentId: string;
}) {
  const [binding] = await db
    .select()
    .from(schema.agentSessionBindingTable)
    .where(eq(schema.agentSessionBindingTable.id, input.bindingId))
    .limit(1);
  if (!binding) throw staleBinding();
  await assertUserWorkspacePermission(
    input.userId,
    (
      await db
        .select({ workspaceId: schema.projectTable.workspaceId })
        .from(schema.projectTable)
        .where(eq(schema.projectTable.id, binding.projectId))
        .limit(1)
    )[0]?.workspaceId ?? "",
    { task: ["read"] },
  ).catch(() => {
    throw staleBinding();
  });
  const [delivery] = await db
    .select()
    .from(schema.agentSessionDeliveryTable)
    .where(
      and(
        eq(schema.agentSessionDeliveryTable.bindingId, input.bindingId),
        eq(schema.agentSessionDeliveryTable.commentId, input.commentId),
      ),
    )
    .orderBy(desc(schema.agentSessionDeliveryTable.createdAt))
    .limit(1);
  return delivery ? receipt(delivery) : null;
}

export type { Delivery, ScopedInput };
