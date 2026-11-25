// SPEC-2026-11-25-kaneo-ui-agent-binding T1: presence + roster service.
// Unbound Pi sessions announce themselves so the web UI can offer live
// bind-from-card targets; bound sessions stop announcing and the binding
// heartbeat piggybacks the same row instead. Presence is ephemeral discovery
// data: every read TTL-filters on last_seen_at and a low-probability lazy
// sweep deletes rows stale for days. No foreign keys — a session row dies by
// TTL, never by task deletion.
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import {
  type AgentSessionBinding,
  getOwnedAgentPrincipal,
  presentBinding,
} from "./binding-service";

// D1: TTL live = last_seen_at >= now() - 5 minutes; the web-bind guard
// accepts a row up to 1 extra TTL stale (announce jitter / slow first tick).
export const PRESENCE_TTL_MS = 5 * 60_000;
export const PRESENCE_SWEEP_AFTER_MS = 7 * 24 * 60 * 60_000;
// D1: the sweep runs inside the announce handler at ~2% of calls so no cron
// job is needed. Injected in tests; Math.random() in production.
export const PRESENCE_SWEEP_PROBABILITY = 0.02;

type PresenceExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AnnouncedBinding = ReturnType<typeof presentBinding> & {
  taskTitle: string | null;
  taskNumber: number | null;
};

export type AgentSessionRosterRow = {
  sessionId: string;
  host: string;
  title: string;
  cwd: string;
  model: string;
  lastSeenAt: string;
  agentPrincipalId: string;
  binding: {
    taskId: string;
    taskTitle: string | null;
    taskNumber: number | null;
  } | null;
};

async function findActiveBindingWithTask(sessionId: string) {
  const [row] = await db
    .select({
      binding: schema.agentSessionBindingTable,
      taskTitle: schema.taskTable.title,
      taskNumber: schema.taskTable.number,
    })
    .from(schema.agentSessionBindingTable)
    .leftJoin(
      schema.taskTable,
      eq(schema.taskTable.id, schema.agentSessionBindingTable.taskId),
    )
    .where(
      and(
        eq(schema.agentSessionBindingTable.sessionId, sessionId),
        eq(schema.agentSessionBindingTable.status, "active"),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    binding: {
      ...presentBinding(row.binding as AgentSessionBinding),
      taskTitle: row.taskTitle,
      taskNumber: row.taskNumber,
    } satisfies AnnouncedBinding,
  };
}

// D1 lazy sweep: delete rows whose last_seen_at is ancient. Probability-
// gated by the caller; deterministic when the caller passes a fixed roll.
export async function sweepStalePresence(
  executor: PresenceExecutor = db,
): Promise<void> {
  await executor
    .delete(schema.agentSessionPresenceTable)
    .where(
      lt(
        schema.agentSessionPresenceTable.lastSeenAt,
        new Date(Date.now() - PRESENCE_SWEEP_AFTER_MS),
      ),
    );
}

export function shouldSweepPresence(roll: number = Math.random()): boolean {
  return roll < PRESENCE_SWEEP_PROBABILITY;
}

export async function announceAgentSessionPresence(input: {
  userId: string;
  sessionId: string;
  agentPrincipalId: string;
  host: string;
  title?: string;
  cwd?: string;
  model?: string;
}): Promise<{ binding: AnnouncedBinding | null }> {
  // Auth agent-session rule: the principal id is proved against the caller's
  // own active principal rows, never trusted from the body alone.
  await getOwnedAgentPrincipal(input.userId, input.agentPrincipalId);

  await db
    .insert(schema.agentSessionPresenceTable)
    .values({
      sessionId: input.sessionId,
      agentPrincipalId: input.agentPrincipalId,
      host: input.host,
      title: input.title ?? "",
      cwd: input.cwd ?? "",
      model: input.model ?? "",
    })
    .onConflictDoUpdate({
      target: schema.agentSessionPresenceTable.sessionId,
      set: {
        agentPrincipalId: input.agentPrincipalId,
        host: input.host,
        title: input.title ?? "",
        cwd: input.cwd ?? "",
        model: input.model ?? "",
        lastSeenAt: new Date(),
      },
    });

  if (shouldSweepPresence()) {
    await sweepStalePresence();
  }

  const found = await findActiveBindingWithTask(input.sessionId);
  return { binding: found?.binding ?? null };
}

export async function listAgentSessionRoster(
  userId: string,
): Promise<{ sessions: AgentSessionRosterRow[] }> {
  // TTL filter lives in the query itself (D1): expired rows never leak into
  // the UI; the sweep is only garbage collection.
  const ttlCutoff = new Date(Date.now() - PRESENCE_TTL_MS);
  const rows = await db
    .select({
      sessionId: schema.agentSessionPresenceTable.sessionId,
      host: schema.agentSessionPresenceTable.host,
      title: schema.agentSessionPresenceTable.title,
      cwd: schema.agentSessionPresenceTable.cwd,
      model: schema.agentSessionPresenceTable.model,
      lastSeenAt: schema.agentSessionPresenceTable.lastSeenAt,
      agentPrincipalId: schema.agentSessionPresenceTable.agentPrincipalId,
      taskId: schema.agentSessionBindingTable.taskId,
      taskTitle: schema.taskTable.title,
      taskNumber: schema.taskTable.number,
    })
    .from(schema.agentSessionPresenceTable)
    .innerJoin(
      schema.agentPrincipalTable,
      and(
        eq(
          schema.agentPrincipalTable.id,
          schema.agentSessionPresenceTable.agentPrincipalId,
        ),
        eq(schema.agentPrincipalTable.userId, userId),
        eq(schema.agentPrincipalTable.isActive, true),
      ),
    )
    .leftJoin(
      schema.agentSessionBindingTable,
      and(
        eq(
          schema.agentSessionBindingTable.sessionId,
          schema.agentSessionPresenceTable.sessionId,
        ),
        eq(schema.agentSessionBindingTable.status, "active"),
      ),
    )
    .leftJoin(
      schema.taskTable,
      eq(schema.taskTable.id, schema.agentSessionBindingTable.taskId),
    )
    .where(gte(schema.agentSessionPresenceTable.lastSeenAt, ttlCutoff))
    .orderBy(
      asc(schema.agentSessionPresenceTable.host),
      desc(schema.agentSessionPresenceTable.lastSeenAt),
    );

  return {
    sessions: rows.map((row) => ({
      sessionId: row.sessionId,
      host: row.host,
      title: row.title,
      cwd: row.cwd,
      model: row.model,
      lastSeenAt: row.lastSeenAt.toISOString(),
      agentPrincipalId: row.agentPrincipalId,
      binding: row.taskId
        ? {
            taskId: row.taskId,
            taskTitle: row.taskTitle,
            taskNumber: row.taskNumber,
          }
        : null,
    })),
  };
}

// D3 web-caller ownership guard: a session-cookie caller may only bind a
// sessionId that this user's own extension has announced recently. The grace
// window accepts a row up to 1 extra TTL stale so a slow first announce tick
// right after a bind still passes. API-key/extension callers skip this
// entirely (cold-start /kaneo-card must keep working before tick 0 lands).
export async function assertSessionPresenceForWebBind(
  userId: string,
  sessionId: string,
): Promise<void> {
  const graceCutoff = new Date(Date.now() - PRESENCE_TTL_MS * 2);
  const [row] = await db
    .select({
      agentPrincipalId: schema.agentSessionPresenceTable.agentPrincipalId,
    })
    .from(schema.agentSessionPresenceTable)
    .innerJoin(
      schema.agentPrincipalTable,
      and(
        eq(
          schema.agentPrincipalTable.id,
          schema.agentSessionPresenceTable.agentPrincipalId,
        ),
        eq(schema.agentPrincipalTable.userId, userId),
        eq(schema.agentPrincipalTable.isActive, true),
      ),
    )
    .where(
      and(
        eq(schema.agentSessionPresenceTable.sessionId, sessionId),
        gte(schema.agentSessionPresenceTable.lastSeenAt, graceCutoff),
      ),
    )
    .limit(1);
  if (!row) {
    throw new HTTPException(403, {
      message:
        "This session is not a known live agent session for your account; it cannot be bound from the web UI.",
    });
  }
}

// D2 piggyback: when bound, the heartbeat keeps presence fresh instead of
// the announce loop. UPSERT (not update-only) because a session that resumes
// already bound never announces and may have no row yet; the server fills
// principal/host from the binding row. title/cwd/model COALESCE through
// nullif so a previously announced value is kept, while a missing value is
// filled without clobbering (the announce loop is stopped when bound).
export async function upsertPresenceFromHeartbeat(
  executor: PresenceExecutor,
  binding: Pick<
    AgentSessionBinding,
    "sessionId" | "agentPrincipalId" | "hostId"
  >,
): Promise<void> {
  await executor
    .insert(schema.agentSessionPresenceTable)
    .values({
      sessionId: binding.sessionId,
      agentPrincipalId: binding.agentPrincipalId,
      host: binding.hostId,
    })
    .onConflictDoUpdate({
      target: schema.agentSessionPresenceTable.sessionId,
      set: {
        agentPrincipalId: sql`excluded.agent_principal_id`,
        host: sql`excluded.host`,
        lastSeenAt: sql`now()`,
        title: sql`coalesce(nullif(${schema.agentSessionPresenceTable.title}, ''), excluded.title)`,
        cwd: sql`coalesce(nullif(${schema.agentSessionPresenceTable.cwd}, ''), excluded.cwd)`,
        model: sql`coalesce(nullif(${schema.agentSessionPresenceTable.model}, ''), excluded.model)`,
      },
    });
}
