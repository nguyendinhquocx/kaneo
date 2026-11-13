// SPEC-2026-11-10-kaneo-card-agent-collaboration T2: shared optimistic
// concurrency token for ordinary card content (fields, markers, subtask
// structure/order). `contentRevision` is deliberately separate from the
// execution `taskRevision`: no ordinary edit ever bumps or exposes the
// execution revision, and no execution transition bumps this token.
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type db from "../database";
import { taskTable } from "../database/schema";

type RevisionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbExecutor = typeof db | RevisionTransaction;

export function parseExpectedContentRevision(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new HTTPException(400, {
      message: "expectedContentRevision must be a positive integer",
    });
  }
  return value;
}

// Stale writers get 409 plus the current token so the client can refetch and
// retry instead of silently overwriting concurrent work. The custom response
// body is what actually reaches the client (HTTPException message-only
// responses stay plain text).
export function contentRevisionConflict(current: number): HTTPException {
  return new HTTPException(409, {
    res: contentRevisionConflictResponse(current),
  });
}

export function contentRevisionConflictResponse(current: number): Response {
  return Response.json(
    {
      message: "Card content changed; reload and retry the update",
      currentContentRevision: current,
    },
    { status: 409 },
  );
}

// Read + validate under the caller's row lock (the writer must lock the task
// FOR UPDATE first). Returns the current revision; throws a 409 carrying the
// current token when the client expectation is stale.
export async function assertTaskContentRevision(
  executor: DbExecutor,
  taskId: string,
  expectedContentRevision: unknown,
): Promise<number> {
  const expected = parseExpectedContentRevision(expectedContentRevision);
  const [row] = await executor
    .select({ contentRevision: taskTable.contentRevision })
    .from(taskTable)
    .where(eq(taskTable.id, taskId))
    .limit(1);
  if (!row) {
    throw new HTTPException(404, { message: "Task not found" });
  }
  if (row.contentRevision !== expected) {
    throw contentRevisionConflict(row.contentRevision);
  }
  return row.contentRevision;
}

// Applied on every ordinary content mutation inside the writer's own
// transaction. Execution `taskRevision` is intentionally untouched.
export function advanceContentRevision(row: {
  contentRevision: number;
}): number {
  return row.contentRevision + 1;
}
