import { Archive, ArchiveRestore, ArrowLeft, FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CommentEditor from "@/components/activity/comment-editor";
import { MarkdownRenderer } from "@/components/public-project/markdown-renderer";
import ShareDialog from "@/components/share/share-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useArchiveDocument,
  useCreateDocumentComment,
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
    <section className="mx-auto w-full max-w-3xl space-y-3 px-4 pb-16">
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
                  className="opacity-0 transition-opacity group-hover:opacity-100"
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
        />
        <div className="mt-2 flex justify-end">
          <Button
            size="xs"
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
  const { data: document, isLoading } = useGetDocument(documentId);
  const updateDocument = useUpdateDocument();
  const archiveDocument = useArchiveDocument();
  const { canWriteDocuments } = useWorkspacePermission();
  const canWrite = canWriteDocuments();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [draftSnapshot, setDraftSnapshot] = useState<string | null>(null);
  const loadedDocId = useRef<string | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (document && loadedDocId.current !== document.id) {
      loadedDocId.current = document.id;
      setTitle(document.title);
      setContent(document.content);
      setRevision(document.revision);
      setSaveState("saved");
      setDraftSnapshot(null);
      dirtyRef.current = false;
    }
  }, [document]);

  const save = useCallback(
    async (nextTitle: string, nextContent: string) => {
      if (!document) return;
      setSaveState("saving");
      const result = await updateDocument.mutateAsync({
        id: document.id,
        title: nextTitle,
        content: nextContent,
        revision,
      });
      if ("conflict" in result) {
        setSaveState("conflict");
        setDraftSnapshot(nextContent);
        return;
      }
      setRevision(result.revision);
      setSaveState("saved");
      dirtyRef.current = false;
    },
    [document, revision, updateDocument],
  );

  // Debounced autosave while typing.
  useEffect(() => {
    if (!document || !dirtyRef.current) return;
    if (saveState === "conflict") return;
    const timer = window.setTimeout(() => {
      void save(title, content);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [title, content, document, save, saveState]);

  const handleContentChange = useCallback(
    (next: string) => {
      setContent(next);
      dirtyRef.current = true;
      if (saveState !== "conflict") {
        setSaveState("saving");
      }
    },
    [saveState],
  );

  const handleTitleChange = (next: string) => {
    setTitle(next);
    dirtyRef.current = true;
    if (saveState !== "conflict") {
      setSaveState("saving");
    }
  };

  const handleReloadServerVersion = () => {
    if (!document) return;
    loadedDocId.current = null;
    // Refetch by clearing the cache entry key content: useQuery refetches on
    // invalidation; simplest path is re-mount through the document payload.
    setTitle(document.title);
    setContent(document.content);
    setRevision(document.revision);
    setSaveState("saved");
    setDraftSnapshot(null);
    dirtyRef.current = false;
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
          className="h-7 gap-1.5 text-xs"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          {t("backToDocs")}
        </Button>
        <div className="flex-1" />
        <span
          aria-live="polite"
          className={cn(
            "text-[11px]",
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
            className="h-7 gap-1.5 text-xs"
            disabled={archiveDocument.isPending}
            onClick={async () => {
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
        <ShareDialog
          resourceType="document"
          resourceId={document.id}
          resourceLabel={document.title}
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
            variant="outline"
            onClick={handleReloadServerVersion}
          >
            {t("conflict.reload")}
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-4">
          <Input
            value={title}
            onChange={(event) => handleTitleChange(event.target.value)}
            disabled={!canWrite}
            placeholder={t("titlePlaceholder")}
            aria-label={t("titlePlaceholder")}
            className="border-none bg-transparent px-0 text-xl font-semibold shadow-none focus-visible:ring-0"
          />
          <div className={cn(!canWrite && "pointer-events-none opacity-80")}>
            <CommentEditor
              value={content}
              onChange={handleContentChange}
              placeholder={t("contentPlaceholder")}
            />
          </div>
        </div>

        <DocumentComments documentId={document.id} />
      </div>
    </div>
  );
}
