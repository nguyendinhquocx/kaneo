// SPEC-2026-11-10-kaneo-card-agent-collaboration T4: agent-session card
// binding service. One exact Pi session binds to one card; the API derives
// host/runtime from the OWNED principal row (never the request body), and
// every scoped call must present `bindingId + sessionId + generation`.
// Mismatch or revocation is a typed stale-binding failure — never a silent
// retarget to a replacement session.
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { resolveTaskSubtreeScope } from "../share/task-share-access";
import { isTaskAgentControlled } from "../share/full-access";
import { assertUserWorkspacePermission } from "../utils/require-workspace-permission";

export const STALE_BINDING_CODE = "stale_binding";

const staleBinding = () =>
  new HTTPException(409, {
    message: STALE_BINDING_CODE,
  });

export type AgentSessionBinding = typeof schema.agentSessionBindingTable.$inferSelect;
type BindingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type BindingExecutor = typeof db | BindingTransaction;

export async function getOwnedAgentPrincipal(
  userId: string,
  agentPrincipalId: string,
  executor: BindingExecutor = db,
) {
  const [principal] = await executor
    .select()
    .from(schema.agentPrincipalTable)
    .where(
      and(
        eq(schema.agentPrincipalTable.id, agentPrincipalId),
        eq(schema.agentPrincipalTable.userId, userId),
        eq(schema.agentPrincipalTable.isActive, true),
      ),
    )
    .limit(1);
  if (!principal) {
    throw new HTTPException(403, {
      message: "Agent principal is not active or not owned by this user",
    });
  }
  return principal;
}

async function assertWorkspaceMembership(userId: string, projectId: string) {
  const [project] = await db
    .select({ workspaceId: schema.projectTable.workspaceId })
    .from(schema.projectTable)
    .where(eq(schema.projectTable.id, projectId))
    .limit(1);
  if (!project) throw new HTTPException(404, { message: "Not found" });
  await assertUserWorkspacePermission(userId, project.workspaceId, {
    task: ["update"],
  });
}

async function assertTaskUpdateAllowed(userId: string, taskId: string) {
  const [task] = await db
    .select({
      id: schema.taskTable.id,
      projectId: schema.taskTable.projectId,
    })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, taskId))
    .limit(1);
  if (!task) throw new HTTPException(404, { message: "Not found" });
  await assertWorkspaceMembership(userId, task.projectId);
  // Ad-hoc binds are for ordinary cards: a card owned by a formal run
  // (agent-controlled) fails closed.
  if (await isTaskAgentControlled(taskId)) {
    throw new HTTPException(409, {
      message: "task is controlled by a formal run",
    });
  }
  return task;
}

async function assertNoLiveFormalRun(
  taskId: string,
  executor: BindingExecutor = db,
) {
  const [liveRun] = await executor
    .select({ id: schema.taskRunTable.id })
    .from(schema.taskRunTable)
    .where(
      and(
        eq(schema.taskRunTable.taskId, taskId),
        inArray(schema.taskRunTable.state, ["queued", "in_progress"]),
      ),
    )
    .limit(1);
  if (liveRun) {
    throw new HTTPException(409, {
      message: "a formal run is live on this task",
    });
  }
}


function presentBinding(binding: AgentSessionBinding) {
  return {
    bindingId: binding.id,
    bindingGeneration: binding.bindingGeneration,
    taskId: binding.taskId,
    projectId: binding.projectId,
    sessionId: binding.sessionId,
    hostId: binding.hostId,
    status: binding.status,
    lastHeartbeatAt: binding.lastHeartbeatAt,
    revision: binding.revision,
  };
}

export async function bindAgentSession(input: {
  userId: string;
  taskId: string;
  agentPrincipalId: string;
  sessionId: string;
}) {
  const task = await assertTaskUpdateAllowed(input.userId, input.taskId);
  await assertNoLiveFormalRun(input.taskId);

  return db.transaction(async (tx) => {
    // ALL advisory locks precede every task-row lock. A fixed global order
    // (advisory session -> advisory project -> task rows -> binding rows)
    // cannot form a lock cycle with claimTaskRun (task rows -> binding rows)
    // or with a concurrent bind, whichever tasks are involved.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`session:${input.sessionId}`}))`,
    );
    // Serialize bindings within a project so two different roots cannot
    // concurrently claim overlapping subtask trees.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`binding-project:${task.projectId}`}))`,
    );
    // Use the same task-row lock order as claimTaskRun. This closes the race
    // where a formal run claims after the preflight but before the bind row
    // inserts.
    const [lockedTask] = await tx
      .select({ id: schema.taskTable.id, projectId: schema.taskTable.projectId })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, input.taskId))
      .for("update")
      .limit(1);
    if (!lockedTask || lockedTask.projectId !== task.projectId) {
      throw new HTTPException(404, { message: "Not found" });
    }
    await assertNoLiveFormalRun(input.taskId, tx);
    const currentPrincipal = await getOwnedAgentPrincipal(
      input.userId,
      input.agentPrincipalId,
      tx,
    );
    const candidateBindings = await tx
      .select()
      .from(schema.agentSessionBindingTable)
      .where(
        and(
          eq(schema.agentSessionBindingTable.status, "active"),
          or(
            eq(schema.agentSessionBindingTable.taskId, input.taskId),
            eq(schema.agentSessionBindingTable.sessionId, input.sessionId),
          ),
        ),
      );
    const priorTaskIds = [...new Set(candidateBindings.map((item) => item.taskId))]
      .filter((id) => id !== input.taskId)
      .sort();
    if (priorTaskIds.length > 0) {
      await tx
        .select({ id: schema.taskTable.id })
        .from(schema.taskTable)
        .where(inArray(schema.taskTable.id, priorTaskIds))
        .orderBy(asc(schema.taskTable.id))
        .for("update");
    }
    // Re-read and lock binding rows after task-row locks. Formal-run claim
    // uses the same task -> binding -> delivery order, avoiding a deadlock.
    const priorBindings = await tx
      .select()
      .from(schema.agentSessionBindingTable)
      .where(
        and(
          eq(schema.agentSessionBindingTable.status, "active"),
          or(
            eq(schema.agentSessionBindingTable.taskId, input.taskId),
            eq(schema.agentSessionBindingTable.sessionId, input.sessionId),
          ),
        ),
      )
      .for("update");
    const priorForTask = priorBindings.find(
      (binding) => binding.taskId === input.taskId,
    );
    for (const prior of priorBindings) {
      // Rebind either the card or this exact Pi session. Fence its outbox
      // before revoking so queued work cannot migrate to the replacement.
      await tx
        .update(schema.agentSessionDeliveryTable)
        .set({ state: "stale", updatedAt: new Date() })
        .where(
          and(
            eq(schema.agentSessionDeliveryTable.bindingId, prior.id),
            eq(schema.agentSessionDeliveryTable.state, "queued"),
          ),
        );
      // A claimed attempt might already have reached Pi. Never call that
      // safely stale/replayable: preserve the truthful terminal `unknown`.
      await tx
        .update(schema.agentSessionDeliveryTable)
        .set({ state: "unknown", updatedAt: new Date() })
        .where(
          and(
            eq(schema.agentSessionDeliveryTable.bindingId, prior.id),
            eq(schema.agentSessionDeliveryTable.state, "claimed"),
          ),
        );
      await tx
        .update(schema.agentSessionBindingTable)
        .set({
          status: "revoked",
          revokedAt: new Date(),
          revokedReason: "rebound",
          bindingGeneration: prior.bindingGeneration + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.agentSessionBindingTable.id, prior.id));
    }

    // A root binding owns its entire live descendant tree. Reject another
    // writer binding anywhere inside that tree (or an ancestor whose tree
    // already contains this card); otherwise two Pi sessions could race on
    // one subtask while each believes it has the only writer lease.
    const newScope = await resolveTaskSubtreeScope(
      input.taskId,
      lockedTask.projectId,
      tx,
    );
    const activeProjectBindings = await tx
      .select()
      .from(schema.agentSessionBindingTable)
      .where(
        and(
          eq(schema.agentSessionBindingTable.projectId, lockedTask.projectId),
          eq(schema.agentSessionBindingTable.status, "active"),
        ),
      );
    for (const other of activeProjectBindings) {
      if (newScope.tasks.some((candidate) => candidate.id === other.taskId)) {
        throw new HTTPException(409, {
          message: "task tree overlaps an active agent-session binding",
        });
      }
      const otherScope = await resolveTaskSubtreeScope(
        other.taskId,
        other.projectId,
        tx,
      );
      if (otherScope.tasks.some((candidate) => candidate.id === input.taskId)) {
        throw new HTTPException(409, {
          message: "task tree overlaps an active agent-session binding",
        });
      }
    }

    // Keep generations monotonic per card across rebinds.
    const nextGeneration = priorForTask
      ? priorForTask.bindingGeneration + 1
      : 1;
    const [binding] = await tx
      .insert(schema.agentSessionBindingTable)
      .values({
        taskId: input.taskId,
        projectId: task.projectId,
        agentPrincipalId: currentPrincipal.id,
        // Host/runtime come from the DB principal row, never the body.
        hostId: currentPrincipal.hostId,
        sessionId: input.sessionId,
        bindingGeneration: nextGeneration,
      })
      .returning();
    if (!binding) throw new HTTPException(500, { message: "Failed to bind" });
    return presentBinding(binding);
  });
}

async function lockBindingIdentity(
  tx: BindingTransaction,
  binding: AgentSessionBinding,
  sessionId: string,
  generation: number | undefined,
) {
  // Match formal-run claim ordering: task row first, binding row second.
  const [task] = await tx
    .select({ projectId: schema.taskTable.projectId })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, binding.taskId))
    .for("update")
    .limit(1);
  if (!task || task.projectId !== binding.projectId) throw staleBinding();
  const [current] = await tx
    .select()
    .from(schema.agentSessionBindingTable)
    .where(eq(schema.agentSessionBindingTable.id, binding.id))
    .for("update")
    .limit(1);
  if (
    !current ||
    current.status !== "active" ||
    current.sessionId !== sessionId ||
    current.bindingGeneration !== binding.bindingGeneration ||
    (generation !== undefined && current.bindingGeneration !== generation)
  ) {
    throw staleBinding();
  }
  return current;
}

async function loadOwnedBinding(
  userId: string,
  bindingId: string,
  sessionId: string,
  generation?: number,
) {
  const [binding] = await db
    .select()
    .from(schema.agentSessionBindingTable)
    .where(eq(schema.agentSessionBindingTable.id, bindingId))
    .limit(1);
  if (!binding) throw staleBinding();
  try {
    await getOwnedAgentPrincipal(userId, binding.agentPrincipalId);
  } catch (error) {
    // Inactive/revoked principal means this binding can no longer route to a
    // valid Pi owner. Do not hide unexpected database/runtime failures.
    if (error instanceof HTTPException && [403, 404].includes(error.status)) {
      throw staleBinding();
    }
    throw error;
  }
  if (
    binding.status !== "active" ||
    binding.sessionId !== sessionId ||
    (generation !== undefined && binding.bindingGeneration !== generation)
  ) {
    throw staleBinding();
  }
  try {
    const task = await assertTaskUpdateAllowed(userId, binding.taskId);
    if (task.projectId !== binding.projectId) throw staleBinding();
  } catch (error) {
    // Deleted, moved, inaccessible, or newly formal-run-controlled cards all
    // become the same typed stale-binding response, never generic task work.
    if (error instanceof HTTPException && [403, 404, 409].includes(error.status)) {
      throw staleBinding();
    }
    throw error;
  }
  return binding;
}

export async function showAgentSessionBinding(input: {
  userId: string;
  bindingId: string;
  sessionId: string;
  generation?: number;
}) {
  const binding = await loadOwnedBinding(
    input.userId,
    input.bindingId,
    input.sessionId,
    input.generation,
  );
  return presentBinding(binding);
}

export async function unbindAgentSession(input: {
  userId: string;
  bindingId: string;
  sessionId: string;
  generation?: number;
}) {
  const binding = await loadOwnedBinding(
    input.userId,
    input.bindingId,
    input.sessionId,
    input.generation,
  );
  await db.transaction(async (tx) => {
    await lockBindingIdentity(
      tx,
      binding,
      input.sessionId,
      input.generation,
    );
    await tx
      .update(schema.agentSessionDeliveryTable)
      .set({ state: "stale", updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.bindingId, binding.id),
          eq(schema.agentSessionDeliveryTable.state, "queued"),
        ),
      );
    await tx
      .update(schema.agentSessionDeliveryTable)
      .set({ state: "unknown", updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.bindingId, binding.id),
          eq(schema.agentSessionDeliveryTable.state, "claimed"),
        ),
      );
    const [revoked] = await tx
      .update(schema.agentSessionBindingTable)
      .set({
        status: "revoked",
        revokedAt: new Date(),
        revokedReason: "unbound",
        bindingGeneration: binding.bindingGeneration + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.agentSessionBindingTable.id, binding.id),
          eq(schema.agentSessionBindingTable.status, "active"),
          eq(schema.agentSessionBindingTable.bindingGeneration, binding.bindingGeneration),
        ),
      )
      .returning({ id: schema.agentSessionBindingTable.id });
    if (!revoked) throw staleBinding();
  });
  return { unbound: true, bindingGeneration: binding.bindingGeneration + 1 };
}

export async function heartbeatAgentSessionBinding(input: {
  userId: string;
  bindingId: string;
  sessionId: string;
  generation: number;
}) {
  const binding = await loadOwnedBinding(
    input.userId,
    input.bindingId,
    input.sessionId,
    input.generation,
  );
  return db.transaction(async (tx) => {
    await lockBindingIdentity(
      tx,
      binding,
      input.sessionId,
      input.generation,
    );
    const [row] = await tx
      .update(schema.agentSessionBindingTable)
      .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentSessionBindingTable.id, binding.id),
          eq(schema.agentSessionBindingTable.status, "active"),
          eq(schema.agentSessionBindingTable.bindingGeneration, input.generation),
          eq(schema.agentSessionBindingTable.sessionId, input.sessionId),
        ),
      )
      .returning();
    if (!row) throw staleBinding();
    return presentBinding(row);
  });
}

// Re-resolved per scoped call: moved/deleted/re-scoped cards must not stay
// writable through a cached scope.
async function loadScopedBinding(input: {
  userId: string;
  bindingId: string;
  sessionId: string;
  generation: number;
}) {
  const binding = await loadOwnedBinding(
    input.userId,
    input.bindingId,
    input.sessionId,
    input.generation,
  );
  try {
    const scope = await resolveTaskSubtreeScope(
      binding.taskId,
      binding.projectId,
    );
    return { binding, scope };
  } catch (error) {
    // Re-scope failures (deleted/moved card, cycle, cross-project child, or
    // formal agent-control) stale the binding instead of leaking a 404 or
    // falling back to an unscoped task route. Unexpected infrastructure
    // failures still surface normally.
    if (error instanceof HTTPException && [403, 404, 409].includes(error.status)) {
      throw staleBinding();
    }
    throw error;
  }
}

// Resolve the one active binding whose root is this card or a current
// same-project subtask ancestor. Bindings own their whole live subtree, so a
// child comment/status lookup routes to its root Pi session without a picker.
export async function findActiveBindingForTask(taskId: string) {
  const [task] = await db
    .select({ projectId: schema.taskTable.projectId })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, taskId))
    .limit(1);
  if (!task) return null;

  const visited = new Set<string>();
  let frontier = [taskId];
  for (let depth = 0; frontier.length > 0 && depth <= 32; depth += 1) {
    const current = frontier.filter((id) => !visited.has(id));
    if (current.length === 0) return null;
    for (const id of current) visited.add(id);

    const [binding] = await db
      .select()
      .from(schema.agentSessionBindingTable)
      .where(
        and(
          eq(schema.agentSessionBindingTable.projectId, task.projectId),
          eq(schema.agentSessionBindingTable.status, "active"),
          inArray(schema.agentSessionBindingTable.taskId, current),
        ),
      )
      .limit(1);
    if (binding) return binding;

    const parentEdges = await db
      .select({ sourceTaskId: schema.taskRelationTable.sourceTaskId })
      .from(schema.taskRelationTable)
      .where(
        and(
          inArray(schema.taskRelationTable.targetTaskId, current),
          eq(schema.taskRelationTable.relationType, "subtask"),
        ),
      );
    const parentIds = [...new Set(parentEdges.map((edge) => edge.sourceTaskId))];
    if (parentIds.length === 0) return null;
    const sameProjectParents = await db
      .select({ id: schema.taskTable.id })
      .from(schema.taskTable)
      .where(
        and(
          inArray(schema.taskTable.id, parentIds),
          eq(schema.taskTable.projectId, task.projectId),
        ),
      );
    frontier = sameProjectParents.map((parent) => parent.id);
  }
  return null;
}

export async function bindingTaskScope(input: {
  userId: string;
  bindingId: string;
  sessionId: string;
  generation: number;
}) {
  const { binding, scope } = await loadScopedBinding(input);
  return { binding, scope, present: presentBinding(binding) };
}

export { loadScopedBinding, presentBinding };
