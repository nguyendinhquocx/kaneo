import { client } from "@kaneo/libs";

export type DocumentSummary = {
  id: string;
  projectId: string;
  title: string;
  revision: number;
  archivedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentFull = DocumentSummary & {
  content: string;
};

export async function listDocuments(
  projectId: string,
  includeArchived = false,
) {
  const response = await client.document.$get({
    query: {
      projectId,
      ...(includeArchived ? { includeArchived: "true" } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as DocumentSummary[];
}

export async function getDocument(id: string) {
  const response = await client.document[":id"].$get({ param: { id } });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as DocumentFull;
}

export async function createDocument(input: {
  projectId: string;
  title: string;
  content?: string;
}) {
  const response = await client.document.$post({
    json: input,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as DocumentFull;
}

export type DocumentUpdateConflictError = { conflict: true };

export async function updateDocument(input: {
  id: string;
  title: string;
  content: string;
  revision: number;
}) {
  const response = await client.document[":id"].$put({
    param: { id: input.id },
    json: {
      title: input.title,
      content: input.content,
      revision: input.revision,
    },
  });
  if (response.status === 409) {
    return { conflict: true as const };
  }
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as DocumentFull;
}

export async function archiveDocument(id: string, archived: boolean) {
  const route = archived
    ? client.document[":id"].archive
    : client.document[":id"].unarchive;
  const response = await route.$put({ param: { id } });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as DocumentFull;
}

export async function deleteDocument(id: string) {
  const response = await client.document[":id"].$delete({ param: { id } });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as DocumentFull;
}

export type DocumentComment = {
  id: string;
  documentId: string;
  userId: string;
  userName: string;
  userImage: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export async function listDocumentComments(documentId: string) {
  const response = await client.document[":id"].comment.$get({
    param: { id: documentId },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as DocumentComment[];
}

export async function createDocumentComment(input: {
  documentId: string;
  content: string;
}) {
  const response = await client.document[":id"].comment.$post({
    param: { id: input.documentId },
    json: { content: input.content },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as DocumentComment;
}

export async function deleteDocumentComment(commentId: string) {
  const response = await client.document.comment[":id"].$delete({
    param: { id: commentId },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as { success: boolean };
}
