import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type db from "../database";
import { workspaceUserTable } from "../database/schema";

type AssigneeMembershipExecutor = Pick<typeof db, "select">;

/**
 * Task assignees are workspace data, not just globally valid user IDs. Keep
 * this check beside every task-assignee mutation so a user from another
 * workspace cannot be attached through a foreign-key-valid ID.
 */
export async function assertTaskAssigneeInWorkspace(
  tx: AssigneeMembershipExecutor,
  userId: string | null | undefined,
  workspaceId: string,
): Promise<void> {
  if (!userId) return;

  const [membership] = await tx
    .select({ id: workspaceUserTable.id })
    .from(workspaceUserTable)
    .where(
      and(
        eq(workspaceUserTable.userId, userId),
        eq(workspaceUserTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new HTTPException(400, {
      message: "Assignee must be a member of the task workspace",
    });
  }
}
