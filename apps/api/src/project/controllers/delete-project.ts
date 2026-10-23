import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";
import { projectTable } from "../../database/schema";
import getProject from "./get-project";

async function deleteProject(id: string, workspaceId: string) {
  const existingProject = await getProject(id, workspaceId);

  // SPEC-2026-10-22 full-project-share-link: share_link.resourceId is
  // polymorphic (no FK), so deleting a project would leave capabilities
  // dangling. Revoke every link pointing at the project in the same
  // transaction as the cascade delete.
  const [deletedProject] = await db.transaction(async (tx) => {
    await tx
      .update(schema.shareLinkTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.shareLinkTable.resourceType, "project"),
          eq(schema.shareLinkTable.resourceId, id),
        ),
      );
    return tx
      .delete(projectTable)
      .where(eq(projectTable.id, id))
      .returning();
  });

  if (!deletedProject) {
    throw new HTTPException(500, {
      message: "Failed to delete project",
    });
  }

  return existingProject;
}

export default deleteProject;
