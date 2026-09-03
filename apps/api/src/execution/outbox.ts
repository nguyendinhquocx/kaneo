// SPEC-kaneo-native-telegram-control-v0-1 (T1): transactional notification
// outbox. Events are allocated per-task FIFO sequences and written in the
// same DB transaction as the state mutation they announce. Delivery is
// at-least-once: Telegram sends happen outside the transaction, so a crash
// after send yields `send_unknown` and must be reconciled, never hidden.
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import db from "../database";
import {
  executionNotificationDeliveryTable,
  executionNotificationEventTable,
  executionNotificationSequenceTable,
} from "../database/schema";
import { stableHash } from "./validation";

// SPEC-kaneo-wavefix-v0-2 (T6): post-commit helpers call the outbox with the
// pooled db handle (no wrapping transaction); Drizzle exposes the same query
// surface, so both are accepted here.
export type OutboxTransaction =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Logical notification route for the ProDesk Telegram observer (v0.1). */
export const DEFAULT_NOTIFICATION_ROUTE = "prodesk-telegram";

export type NotificationEventRecord =
  typeof executionNotificationEventTable.$inferSelect;

export type NotificationDeliveryRecord =
  typeof executionNotificationDeliveryTable.$inferSelect;

export type NotificationEventWithDelivery = {
  event: NotificationEventRecord;
  delivery: NotificationDeliveryRecord;
};

/**
 * Allocate the next FIFO sequence for `taskId` (row-locked) and insert the
 * event plus its pending delivery row inside the caller's transaction.
 * Duplicate caller requestKeys are the caller's concern (idempotency table);
 * the unique `(task_id, sequence)` + `(event_id, route)` constraints are the
 * last-resort dedupe inside the outbox itself.
 */
export async function enqueueNotificationEvent(
  tx: OutboxTransaction,
  {
    taskId,
    runId = null,
    kind,
    route = DEFAULT_NOTIFICATION_ROUTE,
    payload = {},
    availableAt,
    expiresAt,
  }: {
    taskId: string;
    runId?: string | null;
    kind: string;
    route?: string;
    payload?: Record<string, unknown>;
    availableAt?: Date;
    expiresAt?: Date | null;
  },
): Promise<{ eventId: string; sequence: number }> {
  const [sequenceRow] = await tx
    .insert(executionNotificationSequenceTable)
    .values({ taskId, nextSequence: 1 })
    .onConflictDoUpdate({
      target: executionNotificationSequenceTable.taskId,
      set: {
        nextSequence: sql`${executionNotificationSequenceTable.nextSequence} + 1`,
      },
    })
    .returning({
      nextSequence: executionNotificationSequenceTable.nextSequence,
    });
  if (!sequenceRow) {
    throw new Error("execution_notification_sequence upsert returned no row");
  }
  const sequence = sequenceRow.nextSequence;

  const [event] = await tx
    .insert(executionNotificationEventTable)
    .values({
      taskId,
      runId,
      sequence,
      kind,
      route,
      payload,
      payloadHash: stableHash(payload),
      state: "pending",
      availableAt: availableAt ?? new Date(),
      expiresAt: expiresAt ?? null,
    })
    .returning();
  if (!event) {
    throw new Error("execution_notification_event insert returned no row");
  }

  await tx
    .insert(executionNotificationDeliveryTable)
    .values({ eventId: event.id, route, state: "pending" })
    .onConflictDoNothing({
      target: [
        executionNotificationDeliveryTable.eventId,
        executionNotificationDeliveryTable.route,
      ],
    });

  return { eventId: event.id, sequence };
}

export type NotificationDeliveryUpdateState =
  | "pending"
  | "sending"
  | "sent"
  | "send_unknown"
  | "acked"
  | "dead_letter";

/**
 * Observer-side delivery lifecycle update (T4 consumes this). The delivery
 * must exist for the route; state target must be a canonical delivery state.
 * Crash-after-send is recorded as `send_unknown`, never silently retried.
 */
export async function updateNotificationDelivery({
  id,
  route = DEFAULT_NOTIFICATION_ROUTE,
  state,
  telegramMessageIds,
  lastError,
}: {
  id: unknown;
  route?: string;
  state: unknown;
  telegramMessageIds?: unknown;
  lastError?: unknown;
}) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("delivery id is required");
  }
  if (
    typeof state !== "string" ||
    !(
      [
        "pending",
        "sending",
        "sent",
        "send_unknown",
        "acked",
        "dead_letter",
      ] as const
    ).includes(state as NotificationDeliveryUpdateState)
  ) {
    throw new Error("invalid delivery state");
  }
  let messageIds: number[] | undefined;
  if (telegramMessageIds !== undefined) {
    if (
      !Array.isArray(telegramMessageIds) ||
      telegramMessageIds.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      ) ||
      telegramMessageIds.length > 20
    ) {
      throw new Error(
        "telegramMessageIds must be an array of <= 20 message ids",
      );
    }
    messageIds = telegramMessageIds as number[];
  }
  const boundedError =
    lastError === undefined
      ? null
      : typeof lastError === "string"
        ? lastError.slice(0, 500)
        : null;
  const now = new Date();
  const [updated] = await db
    .update(executionNotificationDeliveryTable)
    .set({
      state,
      ...(messageIds ? { telegramMessageIds: messageIds } : {}),
      ...(boundedError ? { lastError: boundedError } : {}),
      ...(state === "acked" ? { ackedAt: now } : {}),
      ...(state === "dead_letter" ? { deadLetteredAt: now } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(executionNotificationDeliveryTable.id, id),
        eq(executionNotificationDeliveryTable.route, route),
      ),
    )
    .returning();
  if (!updated) {
    throw new Error("delivery not found for route");
  }
  return updated;
}

/**
 * List due events for a route in FIFO order with their pending delivery row.
 * The observer claims deliveries with its own lease (T4); this read is
 * repeatable and never mutates state.
 */
export async function listDueNotificationEvents({
  route = DEFAULT_NOTIFICATION_ROUTE,
  limit = 50,
}: {
  route?: string;
  limit?: number;
} = {}): Promise<NotificationEventWithDelivery[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const events = await db
    .select()
    .from(executionNotificationEventTable)
    .where(
      and(
        eq(executionNotificationEventTable.route, route),
        inArray(executionNotificationEventTable.state, ["pending", "sending"]),
      ),
    )
    .orderBy(
      asc(executionNotificationEventTable.taskId),
      asc(executionNotificationEventTable.sequence),
    )
    .limit(boundedLimit);
  if (events.length === 0) return [];

  const deliveries = await db
    .select()
    .from(executionNotificationDeliveryTable)
    .where(
      inArray(
        executionNotificationDeliveryTable.eventId,
        events.map((event) => event.id),
      ),
    );
  const byEventId = new Map(
    deliveries.map((delivery) => [delivery.eventId, delivery]),
  );
  return events
    .map((event) => {
      const delivery = byEventId.get(event.id);
      return delivery ? { event, delivery } : null;
    })
    .filter((row): row is NotificationEventWithDelivery => row !== null);
}
