// SPEC-2026-11-10-kaneo-card-agent-collaboration T4: agent-session binding
// routes. Authenticated (session or API key). The agentPrincipalId comes
// from the caller's local config (extension env), never from model args,
// and the server re-proves ownership against the principal row.
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import db, { schema } from "../database";
import { authenticateApiRequest } from "../utils/authenticate-api-request";
import { requestActorIsAgent } from "../execution/phase-progress";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import { isTaskAgentControlled } from "../share/full-access";
import {
  bindAgentSession,
  bindingTaskScope,
  findActiveBindingForTask,
  getOwnedAgentPrincipal,
  heartbeatAgentSessionBinding,
  showAgentSessionBinding,
  unbindAgentSession,
} from "./binding-service";
import {
  bindingCardCreateComment,
  bindingCardCreateSubtask,
  bindingCardCreateUploadTicket,
  bindingCardDeleteSubtask,
  bindingCardFinalizeUpload,
  bindingCardGet,
  bindingCardListComments,
  bindingCardUpdate,
  bindingCardUpdateSubtask,
  bindingCardUpdateWorkMarkers,
  canBindingReadAsset,
} from "./card-tools";
import {
  acknowledgeCommentDelivery,
  claimNextCommentDelivery,
  getCommentDeliveryStatus,
  queueCommentDelivery,
  getLatestDeliveryForComment,
} from "./delivery-service";
import { getPrivateObject } from "../storage/s3";
import { buildAssetResponse } from "../storage/asset-response";

const app = new Hono();

app.use("*", async (c, next) => {
  await authenticateApiRequest(c);
  await next();
});

const requireTaskUpdate = requireWorkspacePermission({ task: ["update"] });

async function requireBoundTaskUpdate(c: Context, next: Next) {
  try {
    return await requireTaskUpdate(c, next);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) {
      throw new HTTPException(409, { message: "stale_binding" });
    }
    throw error;
  }
}

async function authorizeBindingWorkspace(c: Context, next: Next) {
  const [binding] = await db
    .select({ projectId: schema.agentSessionBindingTable.projectId })
    .from(schema.agentSessionBindingTable)
    .where(eq(schema.agentSessionBindingTable.id, c.req.param("bindingId") ?? ""))
    .limit(1);
  if (!binding) throw new HTTPException(409, { message: "stale_binding" });
  const [project] = await db
    .select({ workspaceId: schema.projectTable.workspaceId })
    .from(schema.projectTable)
    .where(eq(schema.projectTable.id, binding.projectId))
    .limit(1);
  if (!project) throw new HTTPException(404, { message: "Not found" });
  c.set("workspaceId", project.workspaceId);
  return requireBoundTaskUpdate(c, next);
}

async function authorizeBindTask(c: Context, next: Next) {
  const body = (c.req as unknown as { valid: (target: string) => unknown }).valid(
    "json",
  ) as { taskId?: string };
  const [task] = await db
    .select({ projectId: schema.taskTable.projectId })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, body.taskId ?? ""))
    .limit(1);
  if (!task) throw new HTTPException(404, { message: "Not found" });
  const [project] = await db
    .select({ workspaceId: schema.projectTable.workspaceId })
    .from(schema.projectTable)
    .where(eq(schema.projectTable.id, task.projectId))
    .limit(1);
  if (!project) throw new HTTPException(404, { message: "Not found" });
  c.set("workspaceId", project.workspaceId);
  return requireTaskUpdate(c, next);
}

async function authorizeCardBody(c: Context, next: Next) {
  const body = (await c.req.raw.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const bindingId = typeof body.bindingId === "string" ? body.bindingId : "";
  const [binding] = await db
    .select({ projectId: schema.agentSessionBindingTable.projectId })
    .from(schema.agentSessionBindingTable)
    .where(eq(schema.agentSessionBindingTable.id, bindingId))
    .limit(1);
  if (!binding) throw new HTTPException(409, { message: "stale_binding" });
  const [project] = await db
    .select({ workspaceId: schema.projectTable.workspaceId })
    .from(schema.projectTable)
    .where(eq(schema.projectTable.id, binding.projectId))
    .limit(1);
  if (!project) throw new HTTPException(404, { message: "Not found" });
  c.set("workspaceId", project.workspaceId);
  return requireBoundTaskUpdate(c, next);
}

app.use("/bindings/:bindingId", authorizeBindingWorkspace);
app.use("/bindings/:bindingId/*", authorizeBindingWorkspace);
app.use("/card/*", authorizeCardBody);

const bindingCtxEntries = {
  bindingId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
};

const queryGeneration = v.pipe(
  v.string(),
  v.transform(Number),
  v.integer(),
  v.minValue(1),
);

const bindingQueryCtxSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  generation: queryGeneration,
});

const getUserId = (c: { get: (key: string) => unknown }) =>
  (c.get("userId") as string) ?? "";

async function assertBindingPrincipalOwner(userId: string, bindingId: string) {
  const [binding] = await db
    .select({ agentPrincipalId: schema.agentSessionBindingTable.agentPrincipalId })
    .from(schema.agentSessionBindingTable)
    .where(eq(schema.agentSessionBindingTable.id, bindingId))
    .limit(1);
  if (!binding) throw new HTTPException(409, { message: "stale_binding" });
  await getOwnedAgentPrincipal(userId, binding.agentPrincipalId);
}

// Owner-only compact status. The workspace-access guard blocks guest
// capability routes; the response omits principal IDs and raw metadata, but
// exposes bindingId/sessionId/generation so Send-to-Pi can target the exact
// bound session (delivery routes re-verify principal ownership server-side).
app.get(
  "/tasks/:taskId/binding-status",
  describeRoute({
    operationId: "getTaskAgentBindingStatus",
    tags: ["Agent Sessions"],
  }),
  validator("param", v.object({ taskId: v.pipe(v.string(), v.minLength(1)) })),
  workspaceAccess.fromTask("taskId"),
  async (c) => {
    const { taskId } = c.req.valid("param");
    const binding = await findActiveBindingForTask(taskId);
    if (!binding) {
      // Spec T5: the owner must be able to tell "never bound" apart from
      // "a formal run owns this card", so the UI can explain why Send-to-Pi
      // disappeared instead of silently hiding it.
      const formalRunOwned = await isTaskAgentControlled(taskId);
      return c.json({ bound: false, online: false, formalRunOwned });
    }
    const [task] = await db
      .select({ projectId: schema.taskTable.projectId })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, taskId))
      .limit(1);
    if (!task || task.projectId !== binding.projectId) {
      return c.json({ bound: false, online: false });
    }
    const online = Boolean(
      binding.lastHeartbeatAt &&
        Date.now() - binding.lastHeartbeatAt.getTime() <= 90_000,
    );
    return c.json({
      bound: true,
      online,
      hostId: binding.hostId,
      bindingId: binding.id,
      rootTaskId: binding.taskId,
      sessionId: binding.sessionId,
      bindingGeneration: binding.bindingGeneration,
    });
  },
);

app.post(
  "/bindings",
  describeRoute({
    operationId: "bindAgentSession",
    tags: ["Agent Sessions"],
    description: "Bind one exact Pi session to one card",
  }),
  validator(
    "json",
    v.object({
      taskId: v.pipe(v.string(), v.minLength(1)),
      agentPrincipalId: v.pipe(v.string(), v.minLength(1)),
      sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    }),
  ),
  authorizeBindTask,
  async (c) => {
    const body = c.req.valid("json");
    const binding = await bindAgentSession({
      userId: getUserId(c),
      taskId: body.taskId,
      agentPrincipalId: body.agentPrincipalId,
      sessionId: body.sessionId,
    });
    return c.json(binding);
  },
);

app.get(
  "/bindings/:bindingId",
  describeRoute({
    operationId: "showAgentSessionBinding",
    tags: ["Agent Sessions"],
  }),
  validator("query", bindingQueryCtxSchema),
  async (c) => {
    const query = c.req.valid("query");
    const binding = await showAgentSessionBinding({
      userId: getUserId(c),
      bindingId: c.req.param("bindingId"),
      sessionId: query.sessionId,
      generation: query.generation,
    });
    return c.json(binding);
  },
);

app.delete(
  "/bindings/:bindingId",
  describeRoute({
    operationId: "unbindAgentSession",
    tags: ["Agent Sessions"],
  }),
  validator("query", bindingQueryCtxSchema),
  async (c) => {
    const query = c.req.valid("query");
    const result = await unbindAgentSession({
      userId: getUserId(c),
      bindingId: c.req.param("bindingId"),
      sessionId: query.sessionId,
      generation: query.generation,
    });
    return c.json(result);
  },
);

app.post(
  "/bindings/:bindingId/deliveries",
  describeRoute({
    operationId: "queueAgentSessionCommentDelivery",
    tags: ["Agent Sessions"],
  }),
  validator(
    "json",
    v.object({
      sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
      commentId: v.pipe(v.string(), v.minLength(1)),
      clientActionKey: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
  ),
  async (c) => {
    if (requestActorIsAgent(c)) {
      throw new HTTPException(403, {
        message: "Only an authenticated browser actor can send a comment to Pi",
      });
    }
    const body = c.req.valid("json");
    const result = await queueCommentDelivery({
      userId: getUserId(c),
      bindingId: c.req.param("bindingId") ?? "",
      sessionId: body.sessionId,
      generation: body.generation,
      commentId: body.commentId,
      clientActionKey: body.clientActionKey,
    });
    return c.json(result);
  },
);

// Pi holds one bounded long-poll for this exact binding/session/generation.
// Workspace-member read: latest receipt for one comment (post-reload
// restore). No principal ownership check; receipts carry no content.
app.get(
  "/bindings/:bindingId/deliveries/by-comment/:commentId",
  describeRoute({
    operationId: "getCommentDeliveryByComment",
    tags: ["Agent Sessions"],
  }),
  async (c) => {
    const result = await getLatestDeliveryForComment({
      userId: getUserId(c),
      bindingId: c.req.param("bindingId") ?? "",
      commentId: c.req.param("commentId") ?? "",
    });
    return c.json({ delivery: result });
  },
);

app.get(
  "/bindings/:bindingId/deliveries/claim",
  describeRoute({
    operationId: "claimAgentSessionCommentDelivery",
    tags: ["Agent Sessions"],
  }),
  validator(
    "query",
    v.object({
      sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      generation: queryGeneration,
      waitMs: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0), v.maxValue(25_000))),
    }),
  ),
  async (c) => {
    const query = c.req.valid("query");
    const bindingId = c.req.param("bindingId") ?? "";
    await assertBindingPrincipalOwner(getUserId(c), bindingId);
    const result = await claimNextCommentDelivery({
      userId: getUserId(c),
      bindingId,
      sessionId: query.sessionId,
      generation: query.generation,
      waitMs: query.waitMs,
      signal: c.req.raw.signal,
    });
    return c.json(result);
  },
);

app.post(
  "/bindings/:bindingId/deliveries/:deliveryId/ack",
  describeRoute({
    operationId: "ackAgentSessionCommentDelivery",
    tags: ["Agent Sessions"],
  }),
  validator(
    "json",
    v.object({
      sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
      outcome: v.picklist(["enqueued", "failed_before_send"]),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const bindingId = c.req.param("bindingId") ?? "";
    await assertBindingPrincipalOwner(getUserId(c), bindingId);
    const result = await acknowledgeCommentDelivery({
      userId: getUserId(c),
      bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
      deliveryId: c.req.param("deliveryId") ?? "",
      outcome: body.outcome,
    });
    return c.json(result);
  },
);

app.get(
  "/bindings/:bindingId/deliveries/:deliveryId",
  describeRoute({
    operationId: "getAgentSessionCommentDeliveryStatus",
    tags: ["Agent Sessions"],
  }),
  async (c) => {
    const result = await getCommentDeliveryStatus({
      bindingId: c.req.param("bindingId") ?? "",
      deliveryId: c.req.param("deliveryId") ?? "",
    });
    return c.json(result);
  },
);

app.post(
  "/bindings/:bindingId/heartbeat",
  describeRoute({
    operationId: "heartbeatAgentSessionBinding",
    tags: ["Agent Sessions"],
  }),
  validator(
    "json",
    v.object({
      sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const bindingId = c.req.param("bindingId");
    const binding = await heartbeatAgentSessionBinding({
      userId: getUserId(c),
      bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    });
    return c.json(binding);
  },
);

// Binding-scoped inbox: pending control requests for the bound card. The
// poll and every ack carry bindingId+sessionId+generation; a mismatch is a
// typed stale binding, never a silent retarget.
app.get(
  "/bindings/:bindingId/inbox",
  describeRoute({
    operationId: "pollAgentSessionInbox",
    tags: ["Agent Sessions"],
  }),
  validator(
    "query",
    v.object({
      sessionId: v.pipe(v.string(), v.minLength(1)),
      generation: queryGeneration,
    }),
  ),
  async (c) => {
    const query = c.req.valid("query");
    const { binding, scope } = await bindingTaskScope({
      userId: getUserId(c),
      bindingId: c.req.param("bindingId"),
      sessionId: query.sessionId,
      generation: query.generation,
    });
    const taskIds = scope.tasks.map((task) => task.id);
    const requests = await db
      .select()
      .from(schema.executionControlRequestTable)
      .where(
        and(
          eq(schema.executionControlRequestTable.state, "pending"),
          eq(schema.executionControlRequestTable.taskId, binding.taskId),
        ),
      )
      .orderBy(desc(schema.executionControlRequestTable.createdAt))
      .limit(20);
    void taskIds;
    return c.json({
      binding: {
        bindingId: binding.id,
        bindingGeneration: binding.bindingGeneration,
        status: binding.status,
        hostId: binding.hostId,
      },
      items: requests,
    });
  },
);

app.post(
  "/card/get",
  describeRoute({ operationId: "kaneoCardGet", tags: ["Agent Card"] }),
  validator("json", v.object({ ...bindingCtxEntries })),
  async (c) => {
    const body = c.req.valid("json");
    const ctx = {
      userId: getUserId(c),
      bindingId: body.bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    };
    return c.json(await bindingCardGet(ctx));
  },
);

app.post(
  "/card/update",
  describeRoute({ operationId: "kaneoCardUpdate", tags: ["Agent Card"] }),
  validator(
    "json",
    v.object({
      ...bindingCtxEntries,
      patch: v.object({
        title: v.optional(v.string()),
        description: v.optional(v.string()),
        status: v.optional(v.string()),
        priority: v.optional(v.string()),
        startDate: v.optional(v.nullable(v.string())),
        dueDate: v.optional(v.nullable(v.string())),
      }),
      expectedContentRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const ctx = {
      userId: getUserId(c),
      bindingId: body.bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    };
    const result = await bindingCardUpdate(ctx, {
      patch: body.patch,
      expectedContentRevision: body.expectedContentRevision,
    });
    return c.json(result);
  },
);

app.post(
  "/card/subtasks",
  describeRoute({ operationId: "kaneoCardCreateSubtask", tags: ["Agent Card"] }),
  validator(
    "json",
    v.object({
      ...bindingCtxEntries,
      title: v.pipe(v.string(), v.minLength(1)),
      description: v.optional(v.string()),
      status: v.optional(v.string()),
      priority: v.optional(v.string()),
      expectedParentContentRevision: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
      ),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const ctx = {
      userId: getUserId(c),
      bindingId: body.bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    };
    const result = await bindingCardCreateSubtask(ctx, {
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      expectedParentContentRevision: body.expectedParentContentRevision,
    });
    return c.json(result);
  },
);

app.post(
  "/card/subtasks/:subtaskId/update",
  describeRoute({
    operationId: "kaneoCardUpdateSubtask",
    tags: ["Agent Card"],
  }),
  validator(
    "json",
    v.object({
      ...bindingCtxEntries,
      patch: v.object({
        title: v.optional(v.string()),
        description: v.optional(v.string()),
        status: v.optional(v.string()),
        priority: v.optional(v.string()),
        startDate: v.optional(v.nullable(v.string())),
        dueDate: v.optional(v.nullable(v.string())),
      }),
      expectedContentRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const subtaskId = c.req.param("subtaskId");
    const ctx = {
      userId: getUserId(c),
      bindingId: body.bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    };
    const result = await bindingCardUpdateSubtask(ctx, subtaskId, {
      patch: body.patch,
      expectedContentRevision: body.expectedContentRevision,
    });
    return c.json(result);
  },
);

app.post(
  "/card/subtasks/:subtaskId/delete",
  describeRoute({
    operationId: "kaneoCardDeleteSubtask",
    tags: ["Agent Card"],
  }),
  validator(
    "json",
    v.object({
      ...bindingCtxEntries,
      expectedParentContentRevision: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
      ),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const subtaskId = c.req.param("subtaskId");
    const ctx = {
      userId: getUserId(c),
      bindingId: body.bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    };
    const result = await bindingCardDeleteSubtask(ctx, subtaskId, {
      expectedParentContentRevision: body.expectedParentContentRevision,
    });
    return c.json(result);
  },
);

app.post(
  "/card/comments",
  describeRoute({ operationId: "kaneoCardListComments", tags: ["Agent Card"] }),
  validator(
    "json",
    v.object({
      ...bindingCtxEntries,
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      cursor: v.optional(v.string()),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const ctx = {
      userId: getUserId(c),
      bindingId: body.bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    };
    const result = await bindingCardListComments(ctx, body.limit, body.cursor);
    return c.json(result);
  },
);

app.post(
  "/card/comments/create",
  describeRoute({ operationId: "kaneoCardCreateComment", tags: ["Agent Card"] }),
  validator(
    "json",
    v.object({
      ...bindingCtxEntries,
      content: v.pipe(v.string(), v.minLength(1)),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const ctx = {
      userId: getUserId(c),
      bindingId: body.bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    };
    const result = await bindingCardCreateComment(ctx, body.content);
    return c.json(result);
  },
);

app.post(
  "/card/work-markers",
  describeRoute({
    operationId: "kaneoCardUpdateWorkMarkers",
    tags: ["Agent Card"],
  }),
  validator(
    "json",
    v.object({
      ...bindingCtxEntries,
      workMarkerCounts: v.record(v.string(), v.number()),
      expectedContentRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const ctx = {
      userId: getUserId(c),
      bindingId: body.bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    };
    const result = await bindingCardUpdateWorkMarkers(ctx, {
      workMarkerCounts: body.workMarkerCounts,
      expectedContentRevision: body.expectedContentRevision,
    });
    return c.json(result);
  },
);

app.post(
  "/card/assets/upload-ticket",
  describeRoute({
    operationId: "kaneoCardUploadTicket",
    tags: ["Agent Card"],
  }),
  validator(
    "json",
    v.object({
      ...bindingCtxEntries,
      ownerType: v.picklist(["task_description", "task_comment"]),
      ownerId: v.pipe(v.string(), v.minLength(1)),
      filename: v.pipe(v.string(), v.minLength(1)),
      contentType: v.pipe(v.string(), v.minLength(1)),
      size: v.pipe(v.number(), v.minValue(1)),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const ctx = {
      userId: getUserId(c),
      bindingId: body.bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    };
    const result = await bindingCardCreateUploadTicket(ctx, {
      ownerType: body.ownerType,
      ownerId: body.ownerId,
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
    });
    return c.json(result);
  },
);

app.post(
  "/card/assets/finalize",
  describeRoute({
    operationId: "kaneoCardFinalizeUpload",
    tags: ["Agent Card"],
  }),
  validator(
    "json",
    v.object({
      ...bindingCtxEntries,
      ownerType: v.picklist(["task_description", "task_comment"]),
      ownerId: v.pipe(v.string(), v.minLength(1)),
      key: v.pipe(v.string(), v.minLength(1)),
      filename: v.pipe(v.string(), v.minLength(1)),
      contentType: v.pipe(v.string(), v.minLength(1)),
      size: v.pipe(v.number(), v.minValue(1)),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    const ctx = {
      userId: getUserId(c),
      bindingId: body.bindingId,
      sessionId: body.sessionId,
      generation: body.generation,
    };
    const result = await bindingCardFinalizeUpload(ctx, {
      ownerType: body.ownerType,
      ownerId: body.ownerId,
      key: body.key,
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
    });
    return c.json(result);
  },
);

// Typed stale-binding errors surface as 409 with the stable code so the
// extension can distinguish them from ordinary failures.
app.onError((error, c) => {
  if (error instanceof Error && error.message === "stale_binding") {
    return c.json({ error: "stale_binding" }, 409);
  }
  throw error;
});

app.get(
  "/bindings/:bindingId/card/assets/:assetId",
  describeRoute({ operationId: "kaneoCardGetAsset", tags: ["Agent Card"] }),
  validator("query", bindingQueryCtxSchema),
  async (c) => {
    const query = c.req.valid("query");
    const assetId = c.req.param("assetId");
    const { scope } = await bindingTaskScope({
      userId: getUserId(c),
      bindingId: c.req.param("bindingId") ?? "",
      sessionId: query.sessionId,
      generation: query.generation ?? 1,
    });
    const [asset] = await db
      .select({
        id: schema.assetTable.id,
        objectKey: schema.assetTable.objectKey,
        filename: schema.assetTable.filename,
        mimeType: schema.assetTable.mimeType,
        taskId: schema.assetTable.taskId,
        surface: schema.assetTable.surface,
      })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.id, assetId))
      .limit(1);
    if (!asset || !(await canBindingReadAsset(scope, asset))) {
      throw new HTTPException(404, { message: "Not found" });
    }
    try {
      const object = await getPrivateObject(asset.objectKey);
      return buildAssetResponse(asset, object, "private, no-store");
    } catch {
      throw new HTTPException(404, { message: "Not found" });
    }
  },
);

export default app;
