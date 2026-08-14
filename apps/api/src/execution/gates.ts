import { eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { executionFlagTable } from "../database/schema";
import { publishEvent } from "../events";

export const EXECUTION_FLAGS = {
  agentInboxDispatch: "agent_inbox_dispatch_enabled",
  agentReply: "agent_reply_enabled",
  guestMutation: "guest_mutation_enabled",
  guestAgentMentions: "guest_agent_mentions_enabled",
  gitPush: "git_push_enabled",
  prCreation: "pr_creation_enabled",
  merge: "merge_enabled",
} as const;

const MVP_A_EXECUTION_FLAGS = new Set<ExecutionFlagName>([
  EXECUTION_FLAGS.gitPush,
  EXECUTION_FLAGS.prCreation,
  EXECUTION_FLAGS.merge,
]);
const NON_MVP_EXECUTION_FLAGS = [
  EXECUTION_FLAGS.agentInboxDispatch,
  EXECUTION_FLAGS.agentReply,
  EXECUTION_FLAGS.guestMutation,
  EXECUTION_FLAGS.guestAgentMentions,
] as const;

export type ExecutionFlagName =
  (typeof EXECUTION_FLAGS)[keyof typeof EXECUTION_FLAGS];

export type ExecutionGateMetric =
  | "gate_blocked"
  | "stale_fence_rejected"
  | "lease_conflict"
  | "git_push_gate_blocked"
  | "pr_gate_blocked"
  | "merge_gate_blocked";

const metricCounts = new Map<ExecutionGateMetric, number>();

type ExecutionFlagExecutor = Pick<typeof db, "select">;

function getFlagMetric(
  name: ExecutionFlagName,
): ExecutionGateMetric | undefined {
  if (name === EXECUTION_FLAGS.gitPush) return "git_push_gate_blocked";
  if (name === EXECUTION_FLAGS.prCreation) return "pr_gate_blocked";
  if (name === EXECUTION_FLAGS.merge) return "merge_gate_blocked";
  return undefined;
}

function incrementMetric(metric: ExecutionGateMetric): number {
  const next = (metricCounts.get(metric) ?? 0) + 1;
  metricCounts.set(metric, next);
  return next;
}

export function getExecutionMetrics() {
  return Object.fromEntries(
    [...metricCounts.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ) as Record<string, number>;
}

export function resetExecutionMetricsForTests(): void {
  metricCounts.clear();
}

export async function recordExecutionMetric(
  metric: ExecutionGateMetric,
  data: Record<string, unknown> = {},
): Promise<void> {
  const count = incrementMetric(metric);
  console.warn("execution.metric", { metric, count, ...data });
  await publishEvent("execution.metric", { metric, count, ...data });
}

export async function recordExecutionGateBlocked(
  reason: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await recordExecutionMetric("gate_blocked", { reason, ...data });
}

export async function isExecutionFlagEnabled(
  name: ExecutionFlagName,
  tx: ExecutionFlagExecutor = db,
): Promise<boolean> {
  const query = tx
    .select({ enabled: executionFlagTable.enabled })
    .from(executionFlagTable)
    .where(eq(executionFlagTable.name, name))
    .limit(1);
  // PostgreSQL only permits FOR UPDATE inside a transaction. The global read
  // path is used by health/admin helpers; mutation gates pass their tx so the
  // flag read and guarded write share one serialization boundary.
  const [flag] = tx === db ? await query : await query.for("update");
  return flag?.enabled === true;
}

export async function recordExecutionFlagBlocked(
  name: ExecutionFlagName,
  data: Record<string, unknown> = {},
): Promise<void> {
  await recordExecutionGateBlocked(name, data);
  const metric = getFlagMetric(name);
  if (metric) await recordExecutionMetric(metric, data);
}

export async function assertExecutionFlagEnabled(
  name: ExecutionFlagName,
  data: Record<string, unknown> = {},
  tx: ExecutionFlagExecutor = db,
): Promise<void> {
  if (await isExecutionFlagEnabled(name, tx)) return;

  await recordExecutionFlagBlocked(name, data);
  throw new HTTPException(409, {
    message: `Execution flag ${name} is disabled`,
  });
}

export async function seedExecutionFlags(): Promise<void> {
  const names = Object.values(EXECUTION_FLAGS);
  await db
    .insert(executionFlagTable)
    .values(names.map((name) => ({ name, enabled: false })))
    .onConflictDoNothing({ target: executionFlagTable.name });
  await db
    .update(executionFlagTable)
    .set({ enabled: false, updatedAt: new Date() })
    .where(inArray(executionFlagTable.name, NON_MVP_EXECUTION_FLAGS));
}

export async function listExecutionFlags() {
  const rows = await db
    .select()
    .from(executionFlagTable)
    .where(inArray(executionFlagTable.name, Object.values(EXECUTION_FLAGS)));
  const byName = new Map(rows.map((row) => [row.name, row]));
  return Object.values(EXECUTION_FLAGS).map((name) => ({
    name,
    enabled: byName.get(name)?.enabled === true,
    updatedAt: byName.get(name)?.updatedAt ?? null,
  }));
}

export async function setExecutionFlag(name: string, enabled: boolean) {
  if (!(Object.values(EXECUTION_FLAGS) as string[]).includes(name)) {
    throw new HTTPException(400, { message: "Unknown execution flag" });
  }
  if (enabled && !MVP_A_EXECUTION_FLAGS.has(name as ExecutionFlagName)) {
    throw new HTTPException(409, {
      message: `Execution flag ${name} is not available before MVP-A rollout completes`,
    });
  }
  const [updated] = await db
    .insert(executionFlagTable)
    .values({ name, enabled })
    .onConflictDoUpdate({
      target: executionFlagTable.name,
      set: { enabled, updatedAt: new Date() },
    })
    .returning();
  return updated;
}
