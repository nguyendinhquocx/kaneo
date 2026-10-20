import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  FileText,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CommentEditor from "@/components/activity/comment-editor";
import { MarkdownRenderer } from "@/components/public-project/markdown-renderer";
import ShareDialog from "@/components/share/share-dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useArchiveDocument,
  useCreateDocumentComment,
  useDeleteDocument,
  useDeleteDocumentComment,
  useGetDocument,
  useGetDocumentComments,
  useUpdateDocument,
} from "@/hooks/queries/document/use-documents";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

type SaveState = "saved" | "saving" | "error" | "conflict";

type DocumentWorkspaceProps = {
  documentId: string;
  onBack: () => void;
};

function DocumentComments({ documentId }: { documentId: string }) {
  const { t } = useTranslation("documents");
  const { data: comments = [], isLoading } = useGetDocumentComments(documentId);
  const createComment = useCreateDocumentComment();
  const deleteComment = useDeleteDocumentComment();
  const [draft, setDraft] = useState("");

  const handleSubmit = async () => {
    if (!draft.trim()) return;
    try {
      await createComment.mutateAsync({ documentId, content: draft });
      setDraft("");
    } catch {
      toast.error(t("comments.error"));
    }
  };

  return (
    // mt-auto pushes comments to the bottom edge for short documents while
    // long documents simply flow and the page scrolls.
    <section className="mx-auto mt-auto w-full max-w-3xl space-y-3 px-4 pb-16">
      <h2 className="text-sm font-semibold text-foreground">
        {t("comments.title")}{" "}
        <span className="font-normal text-muted-foreground">
          ({comments.length})
        </span>
      </h2>

      {isLoading ? (
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
      ) : (
        <div className="space-y-2">
          {comments.map((comment) => (
            <div
              key={comment.id}
              className="group rounded-lg border border-border/80 bg-card p-3"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">
                  {comment.userName}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {new Date(comment.createdAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={() => deleteComment.mutate(comment.id)}
                >
                  {t("comments.delete")}
                </Button>
              </div>
              <MarkdownRenderer content={comment.content} />
            </div>
          ))}
          {comments.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("comments.empty")}
            </p>
          ) : null}
        </div>
      )}

      <div className="rounded-lg border border-border/80 bg-card p-2">
        <CommentEditor
          value={draft}
          onChange={setDraft}
          placeholder={t("comments.placeholder")}
          onSubmitShortcut={handleSubmit}
          uploadOwner={{ ownerType: "document_comment", ownerId: documentId }}
        />
        <div className="mt-2 flex justify-end">
          <Button
            size="xs"
            className="min-h-11 sm:min-h-6"
            disabled={!draft.trim() || createComment.isPending}
            onClick={handleSubmit}
          >
            {t("comments.submit")}
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function DocumentWorkspace({
  documentId,
  onBack,
}: DocumentWorkspaceProps) {
  const { t } = useTranslation("documents");
  const { data: document, isLoading, refetch } = useGetDocument(documentId);
  const updateDocument = useUpdateDocument();
  const archiveDocument = useArchiveDocument();
  const { canWriteDocuments, canDeleteDocuments } = useWorkspacePermission();
  const canWrite = canWriteDocuments();
  const canDelete = canDeleteDocuments();
  const deleteDocument = useDeleteDocument();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [draftSnapshot, setDraftSnapshot] = useState<string | null>(null);
  const loadedDocId = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const pendingSaveRef = useRef<{ title: string; content: string } | null>(
    null,
  );
  const titleRef = useRef("");
  const contentRef = useRef("");

  useEffect(() => {
    if (!document) return;
    // UAT fix: navigating away and back served a stale cached copy (empty
    // content) and the id-only guard never re-initialized from the fresh
    // fetch. Re-init on a new id, or on fresh server data while not dirty —
    // a local unsaved draft always wins.
    const isNewDocument = loadedDocId.current !== document.id;
    // Reviewer P2: react-query invalidation refetches AFTER the save resolves,
    // so a stale cached copy (revision < local) must never overwrite state.
    // Only a strictly newer server revision re-initializes a clean editor.
    const hasFreshServerData =
      !dirtyRef.current &&
      saveState !== "conflict" &&
      document.revision > revision;
    if (isNewDocument || hasFreshServerData) {
      loadedDocId.current = document.id;
      titleRef.current = document.title;
      contentRef.current = document.content;
      setTitle(document.title);
      setContent(document.content);
      setRevision(document.revision);
      setSaveState("saved");
      setDraftSnapshot(null);
      dirtyRef.current = false;
    }
  }, [document, revision, saveState]);

  const save = useCallback(
    async (nextTitle: string, nextContent: string) => {
      if (!document) return;
      if (saveInFlightRef.current) {
        pendingSaveRef.current = { title: nextTitle, content: nextContent };
        return;
      }

      saveInFlightRef.current = true;
      let snapshot = { title: nextTitle, content: nextContent };
      let expectedRevision = revision;
      setSaveState("saving");
      try {
        while (true) {
          const result = await updateDocument.mutateAsync({
            id: document.id,
            title: snapshot.title,
            content: snapshot.content,
            revision: expectedRevision,
          });
          if ("conflict" in result) {
            setSaveState("conflict");
            setDraftSnapshot(contentRef.current);
            pendingSaveRef.current = null;
            return;
          }

          expectedRevision = result.revision;
          setRevision(result.revision);
          const draftMatchesSavedSnapshot =
            titleRef.current === snapshot.title &&
            contentRef.current === snapshot.content;
          if (draftMatchesSavedSnapshot) {
            dirtyRef.current = false;
            setSaveState("saved");
            pendingSaveRef.current = null;
            return;
          }

          dirtyRef.current = true;
          setSaveState("saving");
          const pending = pendingSaveRef.current;
          if (!pending) return;
          snapshot = pending;
          pendingSaveRef.current = null;
        }
      } catch {
        // P1-1 fix: network/server failures surface as a visible error state
        // instead of an unhandled rejection stuck on "saving".
        setSaveState("error");
      } finally {
        saveInFlightRef.current = false;
      }
    },
    [document, revision, updateDocument],
  );

  // Debounced autosave while typing.
  useEffect(() => {
    if (!document || !dirtyRef.current) return;
    if (saveState === "conflict" || saveState === "error") return;
    const timer = window.setTimeout(() => {
      if (!document || !dirtyRef.current) return;
      void save(title, content);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [title, content, document, save, saveState]);

  const handleContentChange = useCallback(
    (next: string) => {
      contentRef.current = next;
      if (saveInFlightRef.current) {
        pendingSaveRef.current = { title: titleRef.current, content: next };
      }
      setContent(next);
      dirtyRef.current = true;
      if (saveState !== "conflict") {
        setSaveState("saving");
      }
    },
    [saveState],
  );

  const handleTitleChange = (next: string) => {
    titleRef.current = next;
    if (saveInFlightRef.current) {
      pendingSaveRef.current = { title: next, content: contentRef.current };
    }
    setTitle(next);
    dirtyRef.current = true;
    if (saveState !== "conflict") {
      setSaveState("saving");
    }
  };

  const handleReloadServerVersion = useCallback(async () => {
    if (!document) return;
    // P1-2 fix: the cache holds our stale copy (conflict skips invalidation
    // and refetchOnMount is off), so reset must come from a fresh fetch.
    const result = await refetch();
    if (!result.isSuccess || !result.data) {
      toast.error(t("errors.loadFailed"));
      return;
    }
    titleRef.current = result.data.title;
    contentRef.current = result.data.content;
    setTitle(result.data.title);
    setContent(result.data.content);
    setRevision(result.data.revision);
    setSaveState("saved");
    setDraftSnapshot(null);
    dirtyRef.current = false;
  }, [document, refetch, t]);

  const flushDraft = useCallback(() => {
    if (dirtyRef.current) {
      void save(titleRef.current, contentRef.current);
    }
  }, [save]);

  const handleBack = async () => {
    if (dirtyRef.current) {
      await save(titleRef.current, contentRef.current);
      if (dirtyRef.current) return;
    }
    onBack();
  };

  const handleCopyDraft = async () => {
    if (draftSnapshot === null) return;
    try {
      await navigator.clipboard.writeText(draftSnapshot);
      toast.success(t("conflict.copied"));
    } catch {
      toast.error(t("conflict.copyFailed"));
    }
  };

  if (isLoading || !document) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-6">
        <div className="h-8 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/80 px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-11 min-h-11 gap-1.5 text-xs sm:h-7 sm:min-h-0"
          disabled={updateDocument.isPending}
          onClick={() => void handleBack()}
        >
          <ArrowLeft className="size-3.5" />
          {t("backToDocs")}
        </Button>
        <div className="flex-1" />
        <span
          aria-live="polite"
          className={cn(
            "shrink-0 whitespace-nowrap text-[11px]",
            saveState === "saved" && "text-muted-foreground",
            saveState === "saving" && "text-muted-foreground",
            saveState === "error" && "text-destructive",
            saveState === "conflict" && "text-warning-foreground",
          )}
        >
          {saveState === "saving" && t("saveState.saving")}
          {saveState === "saved" && t("saveState.saved")}
          {saveState === "error" && t("saveState.error")}
          {saveState === "conflict" && t("saveState.conflict")}
        </span>
        {canWrite ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-11 min-h-11 gap-1.5 text-xs sm:h-7 sm:min-h-0"
            disabled={archiveDocument.isPending || updateDocument.isPending}
            onClick={async () => {
              if (dirtyRef.current) {
                await save(titleRef.current, contentRef.current);
                if (dirtyRef.current) return;
              }
              await archiveDocument.mutateAsync({
                id: document.id,
                archived: document.archivedAt === null,
                projectId: document.projectId,
              });
              onBack();
            }}
          >
            {document.archivedAt === null ? (
              <>
                <Archive className="size-3.5" />
                {t("archive")}
              </>
            ) : (
              <>
                <ArchiveRestore className="size-3.5" />
                {t("unarchive")}
              </>
            )}
          </Button>
        ) : null}
        {canDelete ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-11 min-h-11 gap-1.5 text-xs text-muted-foreground hover:text-destructive sm:h-7 sm:min-h-0"
            disabled={deleteDocument.isPending}
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="size-3.5" />
            {t("deleteButton")}
          </Button>
        ) : null}
        <ShareDialog
          resourceType="document"
          resourceId={document.id}
          canShare={canWrite}
        />
      </div>

      {saveState === "conflict" ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2">
          <FileText className="size-4 text-warning-foreground" />
          <p className="text-xs text-foreground">{t("conflict.message")}</p>
          <div className="flex-1" />
          <Button size="xs" variant="secondary" onClick={handleCopyDraft}>
            {t("conflict.copyDraft")}
          </Button>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => void handleReloadServerVersion()}
          >
            {t("conflict.reload")}
          </Button>
        </div>
      ) : null}

      <div className="scrollbar-none flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* UAT: comments sit at the lower edge for short content and follow
        below the content once it grows. R3-T1: the editor wrapper is natural
        flow (no flex clamping) — content defines its own height, so it can
        never paint over the comments section. */}
        <div className="mx-auto flex w-full max-w-3xl flex-col px-4 py-4">
          <Input
            value={title}
            onChange={(event) => handleTitleChange(event.target.value)}
            onBlur={flushDraft}
            disabled={!canWrite}
            placeholder={t("titlePlaceholder")}
            aria-label={t("titlePlaceholder")}
            title={title}
            className="border-none bg-transparent px-0 text-xl font-semibold shadow-none focus-visible:ring-0 [&_[data-slot=input]]:truncate"
          />
          <div
            className={cn(
              "flex flex-col",
              !canWrite && "pointer-events-none opacity-80",
            )}
            onBlurCapture={(event) => {
              const nextTarget = event.relatedTarget;
              if (
                nextTarget instanceof Node &&
                event.currentTarget.contains(nextTarget)
              ) {
                return;
              }
              flushDraft();
            }}
          >
            <CommentEditor
              value={content}
              onChange={handleContentChange}
              placeholder={t("contentPlaceholder")}
              contentClassName="kaneo-comment-editor-fill"
              uploadOwner={{ ownerType: "document", ownerId: document.id }}
            />
          </div>
        </div>

        <DocumentComments documentId={document.id} />
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("delete.description", { name: document.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose>
              <Button variant="outline" size="sm">
                {t("delete.cancel")}
              </Button>
            </AlertDialogClose>
            <AlertDialogClose
              onClick={() => {
                deleteDocument.mutate(document.id, {
                  onSuccess: () => {
                    toast.success(t("delete.success"));
                    onBack();
                  },
                  onError: () => toast.error(t("delete.error")),
                });
              }}
            >
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteDocument.isPending}
              >
                {t("delete.action")}
              </Button>
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
