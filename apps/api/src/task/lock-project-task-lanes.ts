import { asc, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Shared serialization point for lane membership/order writes. Writers that
// insert, move, reindex, or change status acquire project rows in sorted ID
// order before task rows; this also serializes empty-lane moves. Deletes
// serialize on their locked task rows.
export async function lockProjectTaskLanes(
  tx: Transaction,
  projectIds: string[],
): Promise<void> {
  const orderedIds = [...new Set(projectIds)].sort();
  if (orderedIds.length === 0) return;

  const projects = await tx
    .select({ id: schema.projectTable.id })
    .from(schema.projectTable)
    .where(inArray(schema.projectTable.id, orderedIds))
    .orderBy(asc(schema.projectTable.id))
    .for("update");

  if (projects.length !== orderedIds.length) {
    throw new HTTPException(404, { message: "Project not found" });
  }
}
