import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import db from "../database";
import { projectTable, taskRelationTable, taskTable } from "../database/schema";
import {
  assertRelationTargetsGuard,
  requestActorIsAgent,
} from "../execution/phase-progress";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { validateWorkspaceAccess } from "../utils/validate-workspace-access";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import createTaskRelation from "./controllers/create-task-relation";
import deleteTaskRelation from "./controllers/delete-task-relation";
import getTaskRelations from "./controllers/get-task-relations";

function hasTaskReadScope(
  apiKey: { permissions: Record<string, string[]> | null } | undefined,
): boolean {
  return (
    apiKey === undefined ||
    (apiKey.permissions !== null &&
      apiKey.permissions?.task?.includes("read") === true)
  );
}

const taskRelationSchema = v.object({
  id: v.string(),
  sourceTaskId: v.string(),
  targetTaskId: v.string(),
  relationType: v.string(),
  createdAt: v.date(),
});

const taskRelation = new Hono<{
  Variables: {
    userId: string;
    workspaceId: string;
    apiKey?: {
      id: string;
      permissions: Record<string, string[]> | null;
    };
  };
}>()
  .get(
    "/:taskId",
    describeRoute({
      operationId: "getTaskRelations",
      tags: ["Task Relations"],
      description: "Get all relations for a task",
      responses: {
        200: {
          description: "Task relations with associated task data",
          content: {
            "application/json": { schema: resolver(v.any()) },
          },
        },
      },
    }),
    validator("param", v.object({ taskId: v.string() })),
    workspaceAccess.fromTaskId("taskId"),
    async (c) => {
      const { taskId } = c.req.valid("param");
      const relations = await getTaskRelations(taskId, c.get("workspaceId"));
      return c.json(relations);
    },
  )
  .post(
    "/",
    describeRoute({
      operationId: "createTaskRelation",
      tags: ["Task Relations"],
      description: "Create a relation between two tasks",
      responses: {
        200: {
          description: "Task relation created successfully",
          content: {
            "application/json": { schema: resolver(taskRelationSchema) },
          },
        },
      },
    }),
    validator(
      "json",
      v.object({
        sourceTaskId: v.string(),
        targetTaskId: v.string(),
        relationType: v.picklist(["subtask", "blocks", "related"]),
      }),
    ),
    async (c, next) => {
      const userId = c.get("userId");
      if (!userId) {
        throw new HTTPException(401, { message: "Unauthorized" });
      }
      const { sourceTaskId } = c.req.valid("json");
      const [task] = await db
        .select({ workspaceId: projectTable.workspaceId })
        .from(taskTable)
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .where(eq(taskTable.id, sourceTaskId))
        .limit(1);
      if (!task) {
        throw new HTTPException(404, { message: "Source task not found" });
      }
      await validateWorkspaceAccess(
        userId,
        task.workspaceId,
        c.get("apiKey")?.id,
      );
      if (!hasTaskReadScope(c.get("apiKey"))) {
        throw new HTTPException(403, {
          message: "Insufficient API key scope",
        });
      }
      c.set("workspaceId", task.workspaceId);
      // SPEC-kaneo-phase-cards-full-run-server-v0-1: relation forge guard.
      await assertRelationTargetsGuard(db, {
        sourceTaskId: c.req.valid("json").sourceTaskId,
        targetTaskId: c.req.valid("json").targetTaskId,
        actorIsAgent: requestActorIsAgent(c),
      });
      return next();
    },
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const userId = c.get("userId");
      const { sourceTaskId, targetTaskId, relationType } = c.req.valid("json");
      const relation = await createTaskRelation({
        sourceTaskId,
        targetTaskId,
        relationType,
        userId,
        workspaceId: c.get("workspaceId"),
      });
      return c.json(relation);
    },
  )
  .delete(
    "/:id",
    describeRoute({
      operationId: "deleteTaskRelation",
      tags: ["Task Relations"],
      description: "Delete a task relation",
      responses: {
        200: {
          description: "Task relation deleted successfully",
          content: {
            "application/json": { schema: resolver(taskRelationSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    async (c, next) => {
      const userId = c.get("userId");
      if (!userId) {
        throw new HTTPException(401, { message: "Unauthorized" });
      }
      const { id } = c.req.valid("param");
      const [rel] = await db
        .select({
          sourceTaskId: taskRelationTable.sourceTaskId,
          targetTaskId: taskRelationTable.targetTaskId,
        })
        .from(taskRelationTable)
        .where(eq(taskRelationTable.id, id))
        .limit(1);
      if (!rel) {
        throw new HTTPException(404, { message: "Task relation not found" });
      }
      const [task] = await db
        .select({ workspaceId: projectTable.workspaceId })
        .from(taskTable)
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .where(eq(taskTable.id, rel.sourceTaskId))
        .limit(1);
      if (!task) {
        throw new HTTPException(404, { message: "Task not found" });
      }
      await validateWorkspaceAccess(
        userId,
        task.workspaceId,
        c.get("apiKey")?.id,
      );
      if (!hasTaskReadScope(c.get("apiKey"))) {
        throw new HTTPException(403, {
          message: "Insufficient API key scope",
        });
      }
      c.set("workspaceId", task.workspaceId);
      // SPEC-kaneo-phase-cards-full-run-server-v0-1: relation delete guard —
      // deny when the relation touches a phase child or, for agent callers,
      // a FULL run task.
      await assertRelationTargetsGuard(db, {
        sourceTaskId: rel?.sourceTaskId,
        targetTaskId: rel?.targetTaskId,
        actorIsAgent: requestActorIsAgent(c),
      });
      return next();
    },
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const relation = await deleteTaskRelation(id, userId);
      return c.json(relation);
    },
  );

export default taskRelation;
