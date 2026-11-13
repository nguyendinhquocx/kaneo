// SPEC-2026-11-10-kaneo-card-agent-collaboration T4: agent-session binding
// routes. Authenticated (session or API key). The agentPrincipalId comes
// from the caller's local config (extension env), never from model args,
// and the server re-proves ownership against the principal row.
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, validator } from "hono-openapi";
import * as v from "valibot";
import db, { schema } from "../database";
import { authenticateApiRequest } from "../utils/authenticate-api-request";
import {
  bindAgentSession,
  bindingTaskScope,
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
} from "./card-tools";

const app = new Hono();

app.use("*", async (c, next) => {
  await authenticateApiRequest(c);
  await next();
});

const bindingCtxEntries = {
  bindingId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
};

const queryGeneration = v.pipe(
  v.string(),
  v.transform(Number),
  v.integer(),
  v.minValue(1),
);

const bindingQueryCtxSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  generation: v.optional(queryGeneration),
});

const getUserId = (c: { get: (key: string) => unknown }) =>
  (c.get("userId") as string) ?? "";

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
      sessionId: v.pipe(v.string(), v.minLength(1)),
    }),
  ),
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
  "/bindings/:bindingId/heartbeat",
  describeRoute({
    operationId: "heartbeatAgentSessionBinding",
    tags: ["Agent Sessions"],
  }),
  validator(
    "json",
    v.object({
      sessionId: v.pipe(v.string(), v.minLength(1)),
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

export default app;
