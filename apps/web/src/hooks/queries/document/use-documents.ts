import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveDocument,
  createDocument,
  createDocumentComment,
  type DocumentComment,
  type DocumentFull,
  type DocumentSummary,
  deleteDocument,
  deleteDocumentComment,
  getDocument,
  listDocumentComments,
  listDocuments,
  updateDocument,
} from "@/fetchers/document/document-api";

export function useGetDocuments(projectId: string, includeArchived = false) {
  return useQuery({
    queryKey: ["documents", projectId, includeArchived],
    queryFn: () => listDocuments(projectId, includeArchived),
    enabled: Boolean(projectId),
  });
}

export function useGetDocument(id: string | null) {
  return useQuery({
    queryKey: ["document", id],
    queryFn: () => getDocument(id as string),
    enabled: Boolean(id),
  });
}

export function useGetDocumentComments(documentId: string | null) {
  return useQuery({
    queryKey: ["document-comments", documentId],
    queryFn: () => listDocumentComments(documentId as string),
    enabled: Boolean(documentId),
  });
}

async function syncDocumentQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  document: DocumentFull,
) {
  // The app disables refetch-on-mount globally. Cancel older reads, then write
  // the server result into every cached document view so navigation cannot
  // reveal an invalidated but stale list row after save/archive/restore.
  await Promise.all([
    queryClient.cancelQueries({
      queryKey: ["document", document.id],
      exact: true,
    }),
    queryClient.cancelQueries({
      queryKey: ["documents", document.projectId],
    }),
  ]);

  queryClient.setQueryData(["document", document.id], document);
  const summary: DocumentSummary = {
    id: document.id,
    projectId: document.projectId,
    title: document.title,
    revision: document.revision,
    archivedAt: document.archivedAt,
    createdByUserId: document.createdByUserId,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };

  for (const includeArchived of [false, true]) {
    const queryKey = [
      "documents",
      document.projectId,
      includeArchived,
    ] as const;
    queryClient.setQueryData<DocumentSummary[]>(queryKey, (current) => {
      if (!current) return current;
      const next = current.filter((item) => item.id !== document.id);
      if (includeArchived || document.archivedAt === null) {
        next.push(summary);
      }
      next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return next;
    });
  }
}

export function useCreateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createDocument,
    onSuccess: (document: DocumentFull) =>
      syncDocumentQueries(queryClient, document),
  });
}

export function useUpdateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateDocument,
    onSuccess: (result) => {
      if (!("conflict" in result)) {
        return syncDocumentQueries(queryClient, result);
      }
    },
  });
}

export function useArchiveDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; archived: boolean; projectId: string }) =>
      archiveDocument(input.id, input.archived),
    onSuccess: (document: DocumentFull) =>
      syncDocumentQueries(queryClient, document),
  });
}

export function useCreateDocumentComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createDocumentComment,
    onSuccess: (comment: DocumentComment) => {
      queryClient.invalidateQueries({
        queryKey: ["document-comments", comment.documentId],
      });
    },
  });
}

export function useDeleteDocumentComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteDocumentComment,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-comments"] });
    },
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteDocument,
    onSuccess: (deleted: DocumentFull) => {
      // R2-T4: hard delete — drop the detail cache and the row from both
      // list views instead of syncing a tombstone.
      queryClient.removeQueries({ queryKey: ["document", deleted.id] });
      for (const includeArchived of [false, true]) {
        queryClient.setQueryData<DocumentSummary[]>(
          ["documents", deleted.projectId, includeArchived],
          (current) =>
            current?.filter((item) => item.id !== deleted.id) ?? current,
        );
      }
    },
  });
}

export type DocumentSummaryType = DocumentSummary;
