import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { activitySchema, projectSchema } from "../schemas";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import globalSearch from "./controllers/global-search";

const workspaceSchema = v.object({
  id: v.string(),
  name: v.string(),
  slug: v.string(),
  logo: v.nullable(v.string()),
  metadata: v.nullable(v.string()),
  description: v.nullable(v.string()),
  createdAt: v.date(),
});

const searchTaskSchema = v.object({
  id: v.string(),
  type: v.literal("task"),
  title: v.string(),
  description: v.optional(v.string()),
  projectId: v.optional(v.string()),
  projectName: v.optional(v.string()),
  projectSlug: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  workspaceName: v.optional(v.string()),
  userId: v.optional(v.string()),
  userName: v.optional(v.string()),
  createdAt: v.date(),
  relevanceScore: v.number(),
  taskNumber: v.optional(v.number()),
  priority: v.optional(v.string()),
  status: v.optional(v.string()),
});

const searchResultSchema = v.object({
  // Search hits are intentionally a smaller projection than task detail; do
  // not claim they contain marker counts that this query does not fetch.
  tasks: v.optional(v.array(searchTaskSchema)),
  projects: v.optional(v.array(projectSchema)),
  workspaces: v.optional(v.array(workspaceSchema)),
  comments: v.optional(v.array(activitySchema)),
  activities: v.optional(v.array(activitySchema)),
});

const search = new Hono<{
  Variables: {
    userId: string;
  };
}>().get(
  "/",
  describeRoute({
    operationId: "globalSearch",
    tags: ["Search"],
    description:
      "Search across tasks, projects, workspaces, comments, and activities",
    responses: {
      200: {
        description: "Search results",
        content: {
          "application/json": { schema: resolver(searchResultSchema) },
        },
      },
    },
  }),
  validator(
    "query",
    v.object({
      q: v.pipe(
        v.string(),
        v.minLength(1, "Query must be at least 1 character"),
      ),
      type: v.optional(
        v.picklist([
          "all",
          "tasks",
          "projects",
          "workspaces",
          "comments",
          "activities",
        ]),
        "all",
      ),
      workspaceId: v.optional(v.string()),
      projectId: v.optional(v.string()),
      limit: v.optional(
        v.pipe(
          v.string(),
          v.transform(Number),
          v.number(),
          v.integer("Limit must be an integer"),
          v.minValue(1, "Limit must be at least 1"),
          v.maxValue(50, "Limit must not exceed 50"),
        ),
        "20",
      ),
      userEmail: v.optional(v.pipe(v.string(), v.email())),
    }),
  ),
  workspaceAccess.fromQuery(),
  async (c) => {
    const { q, type, workspaceId, projectId, limit, userEmail } =
      c.req.valid("query");
    const userId = c.get("userId");

    const results = await globalSearch({
      query: q,
      userId,
      userEmail,
      type,
      workspaceId,
      projectId,
      limit,
    });

    return c.json(results);
  },
);

export default search;
