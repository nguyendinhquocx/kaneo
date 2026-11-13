import { ArrowLeft, ChevronRight, Send } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SharedMarkdown, ShareScopeBadge } from "@/components/share/goal-share-reader";
import type {
  ShareTaskCard,
  TaskShareRootPayload,
  TaskShareSubtreePayload,
} from "@/fetchers/share/share-task-api";
import {
  ShareTaskConflictError,
  createTaskShareComment,
  createTaskShareSubtask,
  detachTaskShareLabel,
  reorderTaskShareSubtask,
  updateTaskShareTask,
  updateTaskShareWorkMarkers,
} from "@/fetchers/share/share-task-api";
import { cn } from "@/lib/cn";

// SPEC-2026-11-10 T3: guest task surface. One card + its live subtask tree,
// rendered from the explicit task-share DTO. View links get zero mutation
// affordances; edit links expose only the action-matrix controls (card
// fields, description when not manifest-redacted, comments, marker edits,
// subtask create/reorder). No assignee, no delete, no move, no relations,
// no share management, no Send-to-Pi.

type TaskShareRelation = {
  relationId: string;
  targetTaskId: string;
  position: number | null;
};

type TaskShareReaderProps = {
  token: string;
  projectId: string;
  rootTaskId: string;
  permission: "view" | "edit";
  card: ShareTaskCard;
  subtasks: ShareTaskCard[];
  subtaskRelations?: TaskShareRelation[];
  comments: TaskShareRootPayload["commentsPage"]["items"];
  parent: TaskShareSubtreePayload["parent"];
  statusOptions: Array<{ slug: string; name: string; isFinal: boolean }>;
  childRouteEnabled?: boolean;
  onRefresh: () => void;
  refreshing?: boolean;
};

const PRIORITY_OPTIONS = [
  "no-priority",
  "low",
  "medium",
  "high",
  "urgent",
] as const;

export default function TaskShareReader({
  token,
  permission,
  card,
  subtasks,
  subtaskRelations = [],
  comments,
  parent,
  statusOptions,
  childRouteEnabled = true,
  onRefresh,
  refreshing = false,
}: TaskShareReaderProps) {
  const { t } = useTranslation("share");
  const canEdit = permission === "edit";
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState(card.description ?? "");
  const [titleDraft, setTitleDraft] = useState(card.title);
  const [commentDraft, setCommentDraft] = useState("");
  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const resetFeedback = () => {
    setConflict(false);
    setError(null);
  };

  const runWrite = async (
    write: () => Promise<unknown>,
    options: { keepInput?: boolean } = {},
  ) => {
    setSaving(true);
    resetFeedback();
    try {
      await write();
      onRefresh();
      return true;
    } catch (caught) {
      if (caught instanceof ShareTaskConflictError) {
        // Recoverable conflict: keep the editor input, refetch current
        // state, and show the inline banner.
        setConflict(true);
        onRefresh();
        if (!options.keepInput) {
          setDescriptionDraft(card.description ?? "");
          setTitleDraft(card.title);
        }
        return false;
      }
      setError(
        caught instanceof Error && caught.message !== "error"
          ? caught.message
          : t("project.saveFailed"),
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveDescription = () => {
    if (descriptionDraft === (card.description ?? "")) return;
    void runWrite(() =>
      updateTaskShareTask({
        token,
        taskId: card.id,
        patch: { description: descriptionDraft },
        expectedContentRevision: card.contentRevision,
      }),
      { keepInput: true },
    );
  };

  const saveTitle = () => {
    if (titleDraft === card.title || !titleDraft.trim()) return;
    void runWrite(() =>
      updateTaskShareTask({
        token,
        taskId: card.id,
        patch: { title: titleDraft.trim() },
        expectedContentRevision: card.contentRevision,
      }),
      { keepInput: true },
    );
  };

  const changeStatus = (status: string) => {
    if (status === card.status) return;
    void runWrite(() =>
      updateTaskShareTask({
        token,
        taskId: card.id,
        patch: { status },
        expectedContentRevision: card.contentRevision,
      }),
    );
  };

  const changePriority = (priority: string) => {
    if (priority === (card.priority ?? "no-priority")) return;
    void runWrite(() =>
      updateTaskShareTask({
        token,
        taskId: card.id,
        patch: { priority },
        expectedContentRevision: card.contentRevision,
      }),
    );
  };

  const bumpMarker = (key: keyof ShareTaskCard["workMarkerCounts"], delta: number) => {
    const next = {
      ...card.workMarkerCounts,
      [key]: Math.max(0, card.workMarkerCounts[key] + delta),
    };
    void runWrite(() =>
      updateTaskShareWorkMarkers({
        token,
        taskId: card.id,
        workMarkerCounts: next,
        expectedContentRevision: card.contentRevision,
      }),
    );
  };

  const postComment = () => {
    const content = commentDraft.trim();
    if (!content) return;
    void runWrite(async () => {
      await createTaskShareComment({ token, taskId: card.id, content });
      // Keep the input until success; clear it after.
      setCommentDraft("");
    }).then((ok) => {
      if (!ok) setCommentDraft(content);
    });
  };

  const addSubtask = () => {
    const title = newSubtaskTitle.trim();
    if (!title) return;
    void runWrite(async () => {
      await createTaskShareSubtask({
        token,
        parentTaskId: card.id,
        expectedParentContentRevision: card.contentRevision,
        title,
      });
      setNewSubtaskTitle("");
    }).then((ok) => {
      if (!ok) setNewSubtaskTitle(title);
    });
  };

  const moveSubtask = (taskId: string, direction: -1 | 1) => {
    const index = subtasks.findIndex((candidate) => candidate.id === taskId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= subtasks.length) return;
    const relation = subtaskRelations.find(
      (candidate) => candidate.targetTaskId === taskId,
    );
    if (!relation) return;
    void runWrite(() =>
      reorderTaskShareSubtask({
        token,
        relationId: relation.relationId,
        position: target,
        expectedParentContentRevision: card.contentRevision,
      }),
    );
  };

  const removeLabel = (labelId: string) => {
    void runWrite(() =>
      detachTaskShareLabel({ token, taskId: card.id, labelId }),
    );
  };

  const markerKeys = Object.keys(card.workMarkerCounts) as Array<
    keyof ShareTaskCard["workMarkerCounts"]
  >;

  return (
    <div className="flex h-svh w-full flex-col overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-border/80 border-b bg-background px-3">
        {parent && childRouteEnabled ? (
          <Link
            to="/share/task/$token/task/$taskId"
            params={{ token, taskId: parent.id }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            <span className="max-w-48 truncate">{parent.title}</span>
          </Link>
        ) : null}
        <ShareScopeBadge scope={permission} />
        {refreshing ? (
          <span className="text-[11px] text-muted-foreground" role="status">
            {t("loading")}
          </span>
        ) : null}
      </header>

      <div className="mx-auto w-full max-w-3xl space-y-5 p-4 pb-16">
        {conflict ? (
          <p
            role="alert"
            className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs text-warning-foreground"
          >
            {t("taskConflict")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {/* Title + number */}
        <div className="space-y-1.5">
          {canEdit ? (
            <Input
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={saveTitle}
              aria-label={t("project.titleLabel")}
              className="text-lg font-semibold"
            />
          ) : (
            <h1 className="text-lg font-semibold text-foreground">
              {card.number ? (
                <span className="mr-1.5 text-muted-foreground">#{card.number}</span>
              ) : null}
              {card.title}
            </h1>
          )}
        </div>

        {/* Status / priority / markers row */}
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && statusOptions.length > 0 ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {t("project.statusLabel")}
              <select
                value={card.status}
                onChange={(event) => changeStatus(event.target.value)}
                className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                aria-label={t("project.statusLabel")}
              >
                {statusOptions.map((option) => (
                  <option key={option.slug} value={option.slug}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {card.statusLabel ?? card.status}
            </span>
          )}

          {canEdit ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {t("project.priorityLabel")}
              <select
                value={card.priority ?? "no-priority"}
                onChange={(event) => changePriority(event.target.value)}
                className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                aria-label={t("project.priorityLabel")}
              >
                {PRIORITY_OPTIONS.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </label>
          ) : card.priority ? (
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {card.priority}
            </span>
          ) : null}

          {/* Marker edits: edit links only (task DTO driven) */}
          {canEdit ? (
            <div
              className="flex items-center gap-1"
              aria-label={t("taskMarkers")}
            >
              {markerKeys.map((key) => (
                <span
                  key={key}
                  className="flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[11px]"
                >
                  <button
                    type="button"
                    className="px-1 text-muted-foreground hover:text-foreground"
                    aria-label={`+ ${key}`}
                    onClick={() => bumpMarker(key, 1)}
                  >
                    +
                  </button>
                  <span className="min-w-4 text-center font-medium">
                    {card.workMarkerCounts[key]}
                  </span>
                  <button
                    type="button"
                    className="px-1 text-muted-foreground hover:text-foreground"
                    aria-label={`- ${key}`}
                    onClick={() => bumpMarker(key, -1)}
                  >
                    −
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {/* Labels: detach-only for edit links (no guest label catalog) */}
        {card.labels.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {card.labels.map((label) => (
              <span
                key={label.id}
                className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground"
              >
                {label.name}
                {canEdit ? (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`${t("revoke")}: ${label.name}`}
                    onClick={() => removeLabel(label.id)}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}

        {/* Description: hidden/read-only under a manifest project */}
        <section className="space-y-2">
          <h2 className="text-xs font-medium text-foreground/70">
            {t("project.descriptionLabel")}
          </h2>
          {canEdit && card.description !== null ? (
            <div className="space-y-2">
              <Textarea
                value={descriptionDraft}
                onChange={(event) => setDescriptionDraft(event.target.value)}
                onBlur={saveDescription}
                rows={8}
                aria-label={t("project.descriptionLabel")}
              />
              {descriptionDraft !== (card.description ?? "") ? (
                <Button
                  size="xs"
                  className="min-h-11 sm:min-h-6"
                  disabled={saving}
                  onClick={saveDescription}
                >
                  {saving ? t("project.saving") : t("project.save")}
                </Button>
              ) : null}
            </div>
          ) : card.description !== null ? (
            <div className="text-sm text-foreground">
              <SharedMarkdown
                content={card.description}
                resourceType="task"
                token={token}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("project.noDescription")}
            </p>
          )}
        </section>

        {/* Subtasks */}
        <section className="space-y-2">
          <h2 className="text-xs font-medium text-foreground/70">
            {t("taskSubtasks")}
          </h2>
          <ul className="space-y-1.5">
            {subtasks.map((subtask) => (
              <li
                key={subtask.id}
                className="flex items-center gap-2 rounded-lg border border-border/80 px-2.5 py-1.5"
              >
                {childRouteEnabled ? (
                  <Link
                    to="/share/task/$token/task/$taskId"
                    params={{ token, taskId: subtask.id }}
                    className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
                  >
                    {subtask.title}
                    <ChevronRight className="ml-1 inline size-3.5 text-muted-foreground" />
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {subtask.title}
                  </span>
                )}
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {subtask.statusLabel ?? subtask.status}
                </span>
                {canEdit ? (
                  <span className="flex shrink-0 items-center">
                    <button
                      type="button"
                      className="px-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                      aria-label="move up"
                      onClick={() => moveSubtask(subtask.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="px-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                      aria-label="move down"
                      onClick={() => moveSubtask(subtask.id, 1)}
                    >
                      ↓
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {canEdit ? (
            <div className="flex gap-1.5">
              <Input
                value={newSubtaskTitle}
                onChange={(event) => setNewSubtaskTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addSubtask();
                  }
                }}
                placeholder={t("taskNewSubtask")}
                aria-label={t("taskNewSubtask")}
                className="h-11 text-sm sm:h-8"
              />
              <Button
                size="xs"
                className="min-h-11 sm:min-h-8"
                disabled={saving || !newSubtaskTitle.trim()}
                onClick={addSubtask}
              >
                {t("taskAddSubtask")}
              </Button>
            </div>
          ) : null}
        </section>

        {/* Comments */}
        <section className="space-y-2">
          <h2 className="text-xs font-medium text-foreground/70">
            {t("taskComments")}
          </h2>
          <ul className="space-y-2">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className="rounded-lg border border-border/80 px-3 py-2"
              >
                <p className="text-[11px] text-muted-foreground">
                  {comment.authorName}
                </p>
                <div className="mt-1 text-sm text-foreground">
                  <SharedMarkdown
                    content={comment.content}
                    resourceType="task"
                    token={token}
                  />
                </div>
              </li>
            ))}
            {comments.length === 0 ? (
              <li className="text-xs text-muted-foreground">
                {t("taskNoComments")}
              </li>
            ) : null}
          </ul>
          {canEdit ? (
            <div className="space-y-1.5">
              <Textarea
                value={commentDraft}
                onChange={(event) => setCommentDraft(event.target.value)}
                rows={3}
                aria-label={t("taskCommentPlaceholder")}
                placeholder={t("taskCommentPlaceholder")}
              />
              <Button
                size="xs"
                className={cn("min-h-11 gap-1.5 sm:min-h-7")}
                disabled={saving || !commentDraft.trim()}
                onClick={postComment}
              >
                <Send className="size-3.5" />
                {t("taskPostComment")}
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}


