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
import {
  createShareFullDocument,
  deleteShareFullDocument,
  getShareFullDocument,
  listShareFullDocuments,
  setShareFullDocumentArchived,
  updateShareFullDocument,
} from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";

export function useGetDocuments(projectId: string, includeArchived = false) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? ["share-full", capability.token, "documents", includeArchived]
      : ["documents", projectId, includeArchived],
    queryFn: () => {
      if (capability) {
        return listShareFullDocuments(capability.token).then((rows): DocumentSummary[] =>
          rows
            .filter((row) => includeArchived || row.archivedAt === null)
            .map((row) => ({
              ...row,
              projectId: capability.projectId,
              createdByUserId: null,
            })),
        );
      }
      return listDocuments(projectId, includeArchived);
    },
    enabled: Boolean(capability || projectId),
    // A 429/invalid error must not keep a 10s poll hammering the share
    // limiter; the error state shows recovery UI and polling resumes on the
    // next successful fetch.
    refetchInterval: capability
      ? (query) => (query.state.error ? false : 10_000)
      : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: capability ? false : undefined,
  });
}

export function useGetDocument(id: string | null) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? ["share-full", capability.token, "document", id]
      : ["document", id],
    queryFn: () => {
      if (capability) {
        return getShareFullDocument(capability.token, id as string).then(
          (row): DocumentFull => ({
            ...row,
            projectId: capability.projectId,
            createdByUserId: null,
            archivedAt: null,
            createdAt: row.updatedAt,
          }),
        );
      }
      return getDocument(id as string);
    },
    enabled: Boolean(id),
    refetchInterval: capability
      ? (query) => (query.state.error ? false : 10_000)
      : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: capability ? false : undefined,
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
    mutationFn: (input: { projectId: string; title: string; content: string }) => {
      const capability = getShareCapability();
      if (capability) {
        return createShareFullDocument(capability.token, {
          title: input.title,
          content: input.content,
        }).then((created): DocumentFull => ({
          id: created.id,
          projectId: capability.projectId,
          title: input.title,
          content: input.content,
          revision: created.revision,
          archivedAt: null,
          createdByUserId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
      }
      return createDocument(input);
    },
    onSuccess: (document: DocumentFull) => {
      invalidateShareQueries(queryClient);
      return syncDocumentQueries(queryClient, document);
    },
  });
}

export function useUpdateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      title: string;
      content: string;
      revision: number;
      projectId?: string;
    }) => {
      const capability = getShareCapability();
      if (capability) {
        return updateShareFullDocument(capability.token, input.id, {
          title: input.title,
          content: input.content,
          revision: input.revision,
        }).then((updated): DocumentFull => ({
          id: updated.id,
          projectId: capability.projectId,
          title: updated.title,
          content: updated.content,
          revision: updated.revision,
          archivedAt: null,
          createdByUserId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
      }
      return updateDocument(input);
    },
    onSuccess: (result) => {
      invalidateShareQueries(queryClient);
      if (!("conflict" in result)) {
        return syncDocumentQueries(queryClient, result);
      }
    },
  });
}

export function useArchiveDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; archived: boolean; projectId: string }) => {
      const capability = getShareCapability();
      if (capability) {
        return setShareFullDocumentArchived(
          capability.token,
          input.id,
          input.archived,
        ).then(() =>
          getShareFullDocument(capability.token, input.id).then((row): DocumentFull => ({
            ...row,
            projectId: capability.projectId,
            createdByUserId: null,
            archivedAt: input.archived ? new Date().toISOString() : null,
            createdAt: row.updatedAt,
          })),
        );
      }
      return archiveDocument(input.id, input.archived);
    },
    onSuccess: (document: DocumentFull) => {
      invalidateShareQueries(queryClient);
      return syncDocumentQueries(queryClient, document);
    },
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
    mutationFn: (id: string) => {
      const capability = getShareCapability();
      if (capability) {
        return deleteShareFullDocument(capability.token, id).then((): DocumentFull => ({
          id,
          projectId: capability.projectId,
          title: '',
          content: '',
          revision: 0,
          archivedAt: null,
          createdByUserId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
      }
      return deleteDocument(id);
    },
    onSuccess: (deleted: DocumentFull) => {
      invalidateShareQueries(queryClient);
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
