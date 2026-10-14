import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";

// SPEC-2026-10-08-kaneo-workspace-collaboration T3: document comments are
// member-authored records on their own table (the task `activity` table
// requires a taskId and cannot host document discussions).

export async function createDocumentComment(
  documentId: string,
  userId: string,
  content: string,
) {
  const [comment] = await db
    .insert(schema.documentCommentTable)
    .values({ documentId, userId, content })
    .returning();

  if (!comment) {
    throw new HTTPException(500, { message: "Failed to create comment" });
  }
  return comment;
}

export async function getDocumentComments(documentId: string) {
  return db
    .select({
      id: schema.documentCommentTable.id,
      documentId: schema.documentCommentTable.documentId,
      userId: schema.documentCommentTable.userId,
      userName: schema.userTable.name,
      userImage: schema.userTable.image,
      content: schema.documentCommentTable.content,
      createdAt: schema.documentCommentTable.createdAt,
      updatedAt: schema.documentCommentTable.updatedAt,
    })
    .from(schema.documentCommentTable)
    .innerJoin(
      schema.userTable,
      eq(schema.documentCommentTable.userId, schema.userTable.id),
    )
    .where(eq(schema.documentCommentTable.documentId, documentId))
    .orderBy(asc(schema.documentCommentTable.createdAt));
}

// Authors may delete their own comment; admins/owners may moderate. The route
// layer enforces workspace access, this controller enforces authorship.
export async function deleteDocumentComment(
  commentId: string,
  userId: string,
  isModerator: boolean,
) {
  const [comment] = await db
    .select()
    .from(schema.documentCommentTable)
    .where(eq(schema.documentCommentTable.id, commentId))
    .limit(1);

  if (!comment) {
    throw new HTTPException(404, { message: "Comment not found" });
  }
  if (comment.userId !== userId && !isModerator) {
    throw new HTTPException(403, {
      message: "Only the author can delete this comment",
    });
  }

  await db
    .delete(schema.documentCommentTable)
    .where(
      and(
        eq(schema.documentCommentTable.id, commentId),
        eq(schema.documentCommentTable.documentId, comment.documentId),
      ),
    );

  return { success: true };
}
