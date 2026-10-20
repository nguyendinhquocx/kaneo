import { resolveApiBaseUrl } from "@kaneo/libs";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ShareConflictError,
  type SharedDocumentPayload,
  updateSharedDocument,
} from "@/fetchers/share/share-public-api";
import { SharedMarkdown, ShareScopeBadge } from "./goal-share-reader";

const shareApiBase = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL as string | undefined,
);

type DocumentShareReaderProps = {
  data: SharedDocumentPayload;
  token: string;
};

// R4-T4: a document link renders read-only unless the link's scope is edit.
// The edit control saves title+body through the audited capability PUT with
// the document revision as CAS — a concurrent edit surfaces a conflict
// instead of silently overwriting the other writer.
export default function DocumentShareReader({
  data,
  token,
}: DocumentShareReaderProps) {
  const { t } = useTranslation("share");
  const queryClient = useQueryClient();
  const canEdit = data.scope === "edit";
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(data.title);
  const [content, setContent] = useState(data.content);
  const [revision, setRevision] = useState(data.revision);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">(
    "idle",
  );
  const [conflict, setConflict] = useState(false);
  const dirtyRef = useRef(false);

  const startEditing = () => {
    setTitle(data.title);
    setContent(data.content);
    setRevision(data.revision);
    setConflict(false);
    setSaveState("idle");
    dirtyRef.current = false;
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setConflict(false);
    setSaveState("idle");
  };

  const handleSave = async () => {
    setSaveState("saving");
    setConflict(false);
    try {
      const updated = await updateSharedDocument({
        token,
        title,
        content,
        revision,
      });
      setRevision(updated.revision);
      setSaveState("idle");
      dirtyRef.current = false;
      setIsEditing(false);
      await queryClient.invalidateQueries({
        queryKey: ["share", "document", token],
      });
    } catch (error) {
      if (error instanceof ShareConflictError) {
        setConflict(true);
        setSaveState("idle");
      } else {
        setSaveState("error");
      }
    }
  };

  const reloadServerVersion = async () => {
    const fresh = await queryClient.fetchQuery({
      queryKey: ["share", "document", token],
      queryFn: async () => {
        const response = await fetch(`${shareApiBase}/share/document/${token}`);
        if (!response.ok) throw new Error("error");
        return (await response.json()) as SharedDocumentPayload;
      },
    });
    setTitle(fresh.title);
    setContent(fresh.content);
    setRevision(fresh.revision);
    setConflict(false);
    dirtyRef.current = false;
    setSaveState("idle");
  };

  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-foreground">
          {isEditing ? title : data.title}
        </h1>
        <ShareScopeBadge scope={canEdit ? "edit" : "view"} />
        <div className="flex-1" />
        {canEdit && !isEditing ? (
          <Button
            size="sm"
            variant="secondary"
            className="min-h-11 gap-1.5 sm:min-h-8"
            onClick={startEditing}
          >
            <Pencil className="size-3.5" />
            {t("edit")}
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {data.updatedAt
          ? t("document.updated", {
              date: new Date(String(data.updatedAt)).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })
          : null}
      </p>

      {canEdit ? (
        <p className="text-xs text-muted-foreground">
          {isEditing ? t("document.editingHint") : t("document.editHint")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("document.viewHint")}
        </p>
      )}

      {conflict ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
          <p className="text-xs text-foreground">{t("document.conflict")}</p>
          <div className="flex-1" />
          <Button
            size="xs"
            variant="secondary"
            onClick={() => void reloadServerVersion()}
          >
            {t("document.conflictReload")}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConflict(false)}>
            {t("document.conflictKeepEditing")}
          </Button>
        </div>
      ) : null}

      {isEditing ? (
        <div className="space-y-3">
          <Input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              dirtyRef.current = true;
            }}
            aria-label={t("document.titleLabel")}
            className="text-lg font-semibold"
          />
          <Textarea
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              dirtyRef.current = true;
            }}
            placeholder={t("document.contentPlaceholder")}
            aria-label={t("document.contentLabel")}
            rows={20}
            className="min-h-[45vh] font-mono text-sm leading-6"
          />
          <div className="flex items-center justify-end gap-2">
            {saveState === "error" ? (
              <span className="text-xs text-foreground" role="alert">
                {t("document.saveFailed")}
              </span>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11 sm:min-h-8"
              disabled={saveState === "saving"}
              onClick={cancelEditing}
            >
              {t("document.cancel")}
            </Button>
            <Button
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={saveState === "saving" || !dirtyRef.current}
              onClick={() => void handleSave()}
            >
              {saveState === "saving"
                ? t("document.saving")
                : t("document.save")}
            </Button>
          </div>
        </div>
      ) : (
        <SharedMarkdown
          content={data.content ?? ""}
          resourceType="document"
          token={token}
        />
      )}
    </article>
  );
}
