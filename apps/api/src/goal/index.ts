import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import {
  assertDateString,
  assertNotArchived,
  canReadGoal,
  canWriteGoal,
  createGoal,
  getCheckinsInRange,
  getCompletedCountsByGoal,
  getGoal,
  getGoalCheckin,
  listCheckinsForGoal,
  listGoalsForWorkspace,
  setGoalArchived,
  toggleCheckin,
  updateCheckinNote,
  updateGoal,
} from "./controllers/goal-controllers";

// SPEC-2026-10-08-kaneo-workspace-collaboration T5: workspace-level goals and
// date-only check-ins. Route-level access: workspace membership via the
// standard middleware; goal-level rules (private vs shared, owner vs
// collaborator) are enforced in the handlers below.

function goalResponseError(status: 403 | 404) {
  return new Response(null, { status });
}

const goal = new Hono<{
  Variables: {
    userId: string;
    workspaceId: string;
  };
}>()
  .post(
    "/",
    describeRoute({
      operationId: "createGoal",
      tags: ["Goals"],
      description:
        "Create a weekly goal (private by default, optionally project-linked)",
      responses: {
        200: {
          description: "Created goal",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator(
      "json",
      v.object({
        workspaceId: v.string(),
        name: v.string(),
        visibility: v.optional(v.picklist(["private", "workspace"])),
        projectId: v.optional(v.nullable(v.string())),
        targetPerWeek: v.optional(v.nullable(v.number())),
        timezone: v.optional(v.string()),
        position: v.optional(v.number()),
      }),
    ),
    workspaceAccess.fromBody(),
    async (c) => {
      const body = c.req.valid("json");
      const userId = c.get("userId");
      const created = await createGoal({
        workspaceId: body.workspaceId,
        ownerUserId: userId,
        name: body.name,
        visibility: body.visibility ?? "private",
        projectId: body.projectId ?? null,
        targetPerWeek: body.targetPerWeek ?? null,
        timezone: body.timezone ?? "UTC",
        position: body.position,
      });
      return c.json(created);
    },
  )
  .get(
    "/",
    describeRoute({
      operationId: "listGoals",
      tags: ["Goals"],
      description:
        "List visible goals with check-ins in an optional date range and computed totals",
      responses: {
        200: {
          description: "Goals with aggregated check-in rows",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator(
      "query",
      v.object({
        workspaceId: v.string(),
        includeArchived: v.optional(v.string()),
        from: v.optional(v.string()),
        to: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromQuery(),
    async (c) => {
      const { workspaceId, includeArchived, from, to } = c.req.valid("query");
      const userId = c.get("userId");

      const goals = await listGoalsForWorkspace(workspaceId, userId, {
        includeArchived: includeArchived === "true",
      });

      const rangeValid =
        from &&
        to &&
        /^\d{4}-\d{2}-\d{2}$/.test(from) &&
        /^\d{4}-\d{2}-\d{2}$/.test(to);
      const checkinsByGoal: Awaited<ReturnType<typeof getCheckinsInRange>> =
        rangeValid
          ? await getCheckinsInRange(
              goals.map((g) => g.id),
              from,
              to,
            )
          : new Map();
      const completedCounts = await getCompletedCountsByGoal(
        goals.map((g) => g.id),
      );

      return c.json(
        goals.map((goal) => {
          const checkins = checkinsByGoal.get(goal.id) ?? [];
          const totalCompleted = checkins.filter((ci) => ci.completed).length;
          return {
            ...goal,
            checkins,
            totalCompleted,
            totalAllTime: completedCounts.get(goal.id) ?? 0,
          };
        }),
      );
    },
  )
  .get(
    "/:id/checkins",
    describeRoute({
      operationId: "listGoalCheckins",
      tags: ["Goals"],
      description:
        "List every check-in row of one goal (any week) for the note history sheet",
      responses: {
        200: {
          description: "Check-in rows ordered by date",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromGoal(),
    async (c) => {
      const { id } = c.req.valid("param");
      const userId = c.get("userId");

      const goal = await getGoal(id);
      if (!canReadGoal(goal, userId)) {
        // 404 to match sibling read paths and avoid existence disclosure.
        return goalResponseError(404);
      }
      return c.json(await listCheckinsForGoal(id));
    },
  )
  .put(
    "/:id",
    describeRoute({
      operationId: "updateGoal",
      tags: ["Goals"],
      description: "Update goal name/visibility/project/target/timezone/order",
      responses: {
        200: {
          description: "Updated goal",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        name: v.optional(v.string()),
        visibility: v.optional(v.picklist(["private", "workspace"])),
        projectId: v.optional(v.nullable(v.string())),
        targetPerWeek: v.optional(v.nullable(v.number())),
        timezone: v.optional(v.string()),
        position: v.optional(v.number()),
      }),
    ),
    workspaceAccess.fromGoal(),
    async (c) => {
      const { id } = c.req.valid("param");
      const updates = c.req.valid("json");
      const userId = c.get("userId");

      const existing = await getGoal(id);
      if (!(await canWriteGoal(existing, userId))) {
        return goalResponseError(403);
      }

      const updated = await updateGoal(id, {
        name: updates.name,
        visibility: updates.visibility,
        projectId: updates.projectId,
        targetPerWeek: updates.targetPerWeek,
        timezone: updates.timezone,
        position: updates.position,
      });
      return c.json(updated);
    },
  )
  .put(
    "/:id/archive",
    describeRoute({
      operationId: "archiveGoal",
      tags: ["Goals"],
      description:
        "Archive a goal: hidden from the active list, history preserved",
      responses: {
        200: {
          description: "Archived goal",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromGoal(),
    async (c) => {
      const { id } = c.req.valid("param");
      const userId = c.get("userId");
      const existing = await getGoal(id);
      if (!(await canWriteGoal(existing, userId))) {
        return goalResponseError(403);
      }
      const archived = await setGoalArchived(id, true);
      return c.json(archived);
    },
  )
  .put(
    "/:id/unarchive",
    describeRoute({
      operationId: "unarchiveGoal",
      tags: ["Goals"],
      description: "Restore an archived goal to the active list",
      responses: {
        200: {
          description: "Restored goal",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromGoal(),
    async (c) => {
      const { id } = c.req.valid("param");
      const userId = c.get("userId");
      const existing = await getGoal(id);
      if (!(await canWriteGoal(existing, userId))) {
        return goalResponseError(403);
      }
      const restored = await setGoalArchived(id, false);
      return c.json(restored);
    },
  )
  .post(
    "/:id/checkin",
    describeRoute({
      operationId: "toggleGoalCheckin",
      tags: ["Goals"],
      description:
        "Toggle completion for one calendar date (YYYY-MM-DD); idempotent row, never deleted",
      responses: {
        200: {
          description: "Check-in row after toggle",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
        409: { description: "Goal archived" },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        date: v.string(),
        ensureOnly: v.optional(v.boolean()),
      }),
    ),
    workspaceAccess.fromGoal(),
    async (c) => {
      const { id } = c.req.valid("param");
      const { date, ensureOnly } = c.req.valid("json");
      const userId = c.get("userId");

      assertDateString(date);
      const existing = await getGoal(id);
      if (!canReadGoal(existing, userId)) {
        return goalResponseError(404);
      }
      if (!(await canWriteGoal(existing, userId))) {
        return goalResponseError(403);
      }
      assertNotArchived(existing);

      const { row } = await toggleCheckin(id, date, userId, { ensureOnly });
      return c.json(row);
    },
  )
  .put(
    "/checkin/:id",
    describeRoute({
      operationId: "updateGoalCheckinNote",
      tags: ["Goals"],
      description:
        "Update the Markdown note of a check-in with noteRevision CAS",
      responses: {
        200: {
          description: "Updated check-in row",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
        409: { description: "Note revision conflict or archived goal" },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ note: v.string(), noteRevision: v.number() })),
    workspaceAccess.fromGoalCheckin(),
    async (c) => {
      const { id } = c.req.valid("param");
      const { note, noteRevision } = c.req.valid("json");
      const userId = c.get("userId");

      const existing = await getGoalCheckin(id);
      const goal = await getGoal(existing.goalId);
      if (!canReadGoal(goal, userId)) {
        return goalResponseError(404);
      }
      if (!(await canWriteGoal(goal, userId))) {
        return goalResponseError(403);
      }
      assertNotArchived(goal);

      const updated = await updateCheckinNote(id, note, noteRevision);
      return c.json(updated);
    },
  );

export default goal;
