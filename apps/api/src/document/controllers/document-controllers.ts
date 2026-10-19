import { and, asc, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";

// SPEC-2026-10-08-kaneo-workspace-collaboration T3: project documents are
// plain Markdown entities with a CAS revision counter. Save conflicts are
// surfaced to the caller (409) instead of silently overwriting.

export async function createDocument(
  projectId: string,
  title: string,
  content: string,
  userId: string | null,
) {
  const [document] = await db
    .insert(schema.documentTable)
    .values({
      projectId,
      title,
      content,
      revision: 1,
      createdByUserId: userId,
    })
    .returning();

  if (!document) {
    throw new HTTPException(500, { message: "Failed to create document" });
  }
  return document;
}

export async function getDocuments(projectId: string, includeArchived = false) {
  const conditions = [eq(schema.documentTable.projectId, projectId)];
  if (!includeArchived) {
    conditions.push(isNull(schema.documentTable.archivedAt));
  }

  return db
    .select({
      id: schema.documentTable.id,
      projectId: schema.documentTable.projectId,
      title: schema.documentTable.title,
      revision: schema.documentTable.revision,
      archivedAt: schema.documentTable.archivedAt,
      createdByUserId: schema.documentTable.createdByUserId,
      createdAt: schema.documentTable.createdAt,
      updatedAt: schema.documentTable.updatedAt,
    })
    .from(schema.documentTable)
    .where(and(...conditions))
    .orderBy(asc(schema.documentTable.createdAt));
}

export async function getDocument(documentId: string) {
  const [document] = await db
    .select()
    .from(schema.documentTable)
    .where(eq(schema.documentTable.id, documentId))
    .limit(1);

  if (!document) {
    throw new HTTPException(404, { message: "Document not found" });
  }
  return document;
}

// CAS update: matches the expected revision; zero affected rows means someone
// else saved first, so we report 409 with the current server state.
export async function updateDocument(
  documentId: string,
  title: string,
  content: string,
  expectedRevision: number,
) {
  const [updated] = await db
    .update(schema.documentTable)
    .set({
      title,
      content,
      revision: expectedRevision + 1,
    })
    .where(
      and(
        eq(schema.documentTable.id, documentId),
        eq(schema.documentTable.revision, expectedRevision),
      ),
    )
    .returning();

  if (!updated) {
    // Someone else saved first: report conflict and let the client re-fetch.
    throw new HTTPException(409, {
      message: "Document was modified by someone else",
    });
  }
  return updated;
}

export async function archiveDocument(documentId: string) {
  const [archived] = await db
    .update(schema.documentTable)
    .set({ archivedAt: new Date() })
    .where(eq(schema.documentTable.id, documentId))
    .returning();

  if (!archived) {
    throw new HTTPException(404, { message: "Document not found" });
  }
  return archived;
}

export async function unarchiveDocument(documentId: string) {
  const [unarchived] = await db
    .update(schema.documentTable)
    .set({ archivedAt: null })
    .where(eq(schema.documentTable.id, documentId))
    .returning();

  if (!unarchived) {
    throw new HTTPException(404, { message: "Document not found" });
  }
  return unarchived;
}

// R2-T4: hard delete. Comments cascade via the document_comment FK; callers
// gate this behind task:delete (workspace admin/owner).
export async function deleteDocument(documentId: string) {
  const [deleted] = await db
    .delete(schema.documentTable)
    .where(eq(schema.documentTable.id, documentId))
    .returning();

  if (!deleted) {
    throw new HTTPException(404, { message: "Document not found" });
  }
  return deleted;
}
