import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveDocument,
  createDocument,
  createDocumentComment,
  type DocumentComment,
  type DocumentFull,
  type DocumentSummary,
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

function useInvalidateDocument() {
  const queryClient = useQueryClient();
  return (documentId?: string, projectId?: string) => {
    if (documentId) {
      queryClient.invalidateQueries({ queryKey: ["document", documentId] });
    }
    if (projectId) {
      queryClient.invalidateQueries({ queryKey: ["documents", projectId] });
    }
  };
}

export function useCreateDocument() {
  const invalidate = useInvalidateDocument();
  return useMutation({
    mutationFn: createDocument,
    onSuccess: (document: DocumentFull) =>
      invalidate(document.id, document.projectId),
  });
}

export function useUpdateDocument() {
  const invalidate = useInvalidateDocument();
  return useMutation({
    mutationFn: updateDocument,
    onSuccess: (result) => {
      if (!("conflict" in result)) {
        invalidate(result.id, result.projectId);
      }
    },
  });
}

export function useArchiveDocument() {
  const invalidate = useInvalidateDocument();
  return useMutation({
    mutationFn: (input: { id: string; archived: boolean; projectId: string }) =>
      archiveDocument(input.id, input.archived),
    onSuccess: (document: DocumentFull) =>
      invalidate(document.id, document.projectId),
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

export type DocumentSummaryType = DocumentSummary;
