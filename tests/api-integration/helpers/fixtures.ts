import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import db, { schema } from "../../../apps/api/src/database";
import { DEFAULT_PROJECT_COLUMNS } from "../../../apps/api/src/project/controllers/create-project";

export type SeededMemberContext = {
  user: typeof schema.userTable.$inferSelect;
  workspace: typeof schema.workspaceTable.$inferSelect;
};

export async function createWorkspaceMember(
  overrides?: Partial<{
    userName: string;
    workspaceName: string;
    role: string;
  }>,
): Promise<SeededMemberContext> {
  const userId = `user-${randomUUID()}`;
  const workspaceId = `workspace-${randomUUID()}`;

  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: userId,
      email: `${userId}@example.com`,
      emailVerified: true,
      name: overrides?.userName || "Integration Test User",
    })
    .returning();

  const [workspace] = await db
    .insert(schema.workspaceTable)
    .values({
      id: workspaceId,
      createdAt: new Date(),
      name: overrides?.workspaceName || "Integration Test Workspace",
      slug: `workspace-${randomUUID()}`,
    })
    .returning();

  await db.insert(schema.workspaceUserTable).values({
    workspaceId: workspace.id,
    userId: user.id,
    role: overrides?.role ?? "member",
    joinedAt: new Date(),
  });

  return { user, workspace };
}

export async function createProjectFixture({
  workspaceId,
  name = "Integration Project",
  icon = "Folder",
  slug = `project-${randomUUID()}`,
}: {
  workspaceId: string;
  name?: string;
  icon?: string;
  slug?: string;
}) {
  const [project] = await db
    .insert(schema.projectTable)
    .values({
      workspaceId,
      name,
      icon,
      slug,
    })
    .returning();

  const insertedColumns: (typeof schema.columnTable.$inferSelect)[] = [];

  for (const col of DEFAULT_PROJECT_COLUMNS) {
    const [inserted] = await db
      .insert(schema.columnTable)
      .values({
        projectId: project.id,
        name: col.name,
        slug: col.slug,
        position: col.position,
        isFinal: col.isFinal,
      })
      .returning();
    if (inserted) {
      insertedColumns.push(inserted);
    }
  }

  const columnsBySlug = new Map(
    insertedColumns.map((column) => [column.slug, column]),
  );

  const todo = columnsBySlug.get("to-do");
  const inProgress = columnsBySlug.get("in-progress");
  const inReview = columnsBySlug.get("in-review");
  const done = columnsBySlug.get("done");

  if (!todo || !inProgress || !inReview || !done) {
    throw new Error("Failed to seed default project columns");
  }

  return {
    project,
    columns: {
      todo,
      inProgress,
      inReview,
      done,
    },
  };
}

// SPEC-2026-11-10-kaneo-card-agent-collaboration T2: every task-field,
// marker, and subtask-order write carries the contentRevision the client
// last read. Integration tests read the current token straight from the DB
// before each mutation, mirroring what the web/MCP clients do.
export async function getTaskContentRevision(taskId: string): Promise<number> {
  const [row] = await db
    .select({ contentRevision: schema.taskTable.contentRevision })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, taskId))
    .limit(1);
  if (!row) {
    throw new Error(`Task ${taskId} not found for contentRevision lookup`);
  }
  return row.contentRevision;
}

// SPEC-2026-11-25-kaneo-ui-agent-binding D3: a web (session-cookie) bind now
// requires the target session to have announced presence for the caller.
// Integration tests that bind through the session path seed the presence row
// first, mirroring a real unbound session that announced at tick 0.
export async function seedSessionPresence(input: {
  userId: string;
  sessionId: string;
  agentPrincipalId: string;
  host?: string;
  title?: string;
}) {
  await db
    .insert(schema.agentSessionPresenceTable)
    .values({
      sessionId: input.sessionId,
      agentPrincipalId: input.agentPrincipalId,
      host: input.host ?? "test-host",
      title: input.title ?? "",
    })
    .onConflictDoNothing();
}
