// SPEC-2026-11-10-kaneo-card-agent-collaboration T4: agent-session card
// binding service. One exact Pi session binds to one card; the API derives
// host/runtime from the OWNED principal row (never the request body), and
// every scoped call must present `bindingId + sessionId + generation`.
// Mismatch or revocation is a typed stale-binding failure — never a silent
// retarget to a replacement session.
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { resolveTaskSubtreeScope } from "../share/task-share-access";
import { isTaskAgentControlled } from "../share/full-access";

export const STALE_BINDING_CODE = "stale_binding";

const staleBinding = () =>
  new HTTPException(409, {
    message: STALE_BINDING_CODE,
  });

export type AgentSessionBinding = typeof schema.agentSessionBindingTable.$inferSelect;

export async function getOwnedAgentPrincipal(
  userId: string,
  agentPrincipalId: string,
) {
  const [principal] = await db
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
  const [member] = await db
    .select({ id: schema.workspaceUserTable.id })
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, project.workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    )
    .limit(1);
  if (!member) {
    throw new HTTPException(403, { message: "Not a workspace member" });
  }
}

async function assertTaskUpdateAllowed(userId: string, taskId: string) {
  const [task] = await db
    .select({
      id: schema.taskTable.id,
      projectId: schema.taskTable.projectId,
      userId: schema.taskTable.userId,
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

async function assertNoLiveFormalRun(taskId: string) {
  const [liveRun] = await db
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

async function loadActiveBinding(taskId: string) {
  const [binding] = await db
    .select()
    .from(schema.agentSessionBindingTable)
    .where(
      and(
        eq(schema.agentSessionBindingTable.taskId, taskId),
        eq(schema.agentSessionBindingTable.status, "active"),
      ),
    )
    .limit(1);
  return binding ?? null;
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
  const principal = await getOwnedAgentPrincipal(
    input.userId,
    input.agentPrincipalId,
  );
  const task = await assertTaskUpdateAllowed(input.userId, input.taskId);
  await assertNoLiveFormalRun(input.taskId);

  return db.transaction(async (tx) => {
    // Serialize the partial unique index: one ACTIVE binding per task. The
    // advisory lock keys on the task so the revoke+insert pair is atomic.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.taskId}))`,
    );
    const [prior] = await tx
      .select()
      .from(schema.agentSessionBindingTable)
      .where(
        and(
          eq(schema.agentSessionBindingTable.taskId, input.taskId),
          eq(schema.agentSessionBindingTable.status, "active"),
        ),
      )
      .limit(1);
    if (prior) {
      // Rebind: revoke the prior binding and stale-fence its inbox so an
      // in-flight poller cannot act on a session it no longer owns.
      await tx
        .update(schema.agentSessionDeliveryTable)
        .set({ state: "stale", updatedAt: new Date() })
        .where(
          and(
            eq(schema.agentSessionDeliveryTable.bindingId, prior.id),
            inArray(schema.agentSessionDeliveryTable.state, [
              "queued",
              "claimed",
            ]),
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

    // The new binding inherits the next generation so the per-card fence
    // stays monotonic across rebinds.
    const nextGeneration = prior ? prior.bindingGeneration + 1 : 1;
    const [binding] = await tx
      .insert(schema.agentSessionBindingTable)
      .values({
        taskId: input.taskId,
        projectId: task.projectId,
        agentPrincipalId: principal.id,
        // Host/runtime come from the DB principal row, never the body.
        hostId: principal.hostId,
        sessionId: input.sessionId,
        bindingGeneration: nextGeneration,
      })
      .returning();
    if (!binding) throw new HTTPException(500, { message: "Failed to bind" });
    return presentBinding(binding);
  });
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
  if (!binding) throw new HTTPException(404, { message: "Not found" });
  const principal = await getOwnedAgentPrincipal(
    userId,
    binding.agentPrincipalId,
  );
  void principal;
  if (
    binding.status !== "active" ||
    binding.sessionId !== sessionId ||
    (generation !== undefined && binding.bindingGeneration !== generation)
  ) {
    throw staleBinding();
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
    await tx
      .update(schema.agentSessionDeliveryTable)
      .set({ state: "stale", updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentSessionDeliveryTable.bindingId, binding.id),
          inArray(schema.agentSessionDeliveryTable.state, [
            "queued",
            "claimed",
          ]),
        ),
      );
    await tx
      .update(schema.agentSessionBindingTable)
      .set({
        status: "revoked",
        revokedAt: new Date(),
        revokedReason: "unbound",
        bindingGeneration: binding.bindingGeneration + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentSessionBindingTable.id, binding.id));
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
  const [row] = await db
    .update(schema.agentSessionBindingTable)
    .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.agentSessionBindingTable.id, binding.id))
    .returning();
  if (!row) throw new HTTPException(404, { message: "Not found" });
  return presentBinding(row);
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
  const scope = await resolveTaskSubtreeScope(
    binding.taskId,
    binding.projectId,
  );
  return { binding, scope };
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
