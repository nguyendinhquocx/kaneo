import { resolveApiBaseUrl } from "@kaneo/libs";
import { useMutation } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/public-project/markdown-renderer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ShareConflictError,
  updateSharedGoalNote,
} from "@/fetchers/share/share-public-api";
import { rewriteShareAssetUrls } from "@/lib/share-asset-url";

const apiBase = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL as string | undefined,
);

export type GoalShareCheckin = {
  id?: string;
  checkInDate: string;
  completed: boolean;
  note: string;
  noteRevision?: number;
};

export type GoalShareData = {
  name: string;
  archivedAt: string | null;
  scope?: "view" | "edit";
  targetPerWeek: number | null;
  checkins: GoalShareCheckin[];
};

// R4-T4: visible scope chip so a holder always knows what the link allows.
export function ShareScopeBadge({ scope }: { scope: "view" | "edit" }) {
  const { t } = useTranslation("share");
  return (
    <span
      className={
        scope === "edit"
          ? "shrink-0 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning-foreground"
          : "shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
      }
    >
      {scope === "edit" ? t("scope.edit") : t("scope.view")}
    </span>
  );
}

export function SharedMarkdown({
  content,
  resourceType,
  token,
}: {
  content: string;
  resourceType: string;
  token: string;
}) {
  return (
    <MarkdownRenderer
      content={rewriteShareAssetUrls(content, apiBase, resourceType, token)}
    />
  );
}

// Monday-based week start, matching the in-app matrix.
function startOfWeek(date: Date): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// R2-T8: the shared goal renders the same horizontal weekly matrix as the
// authenticated app — Mon–Sun columns, week navigation, an all-time total.
// Edit links toggle check-ins and edit notes through the audited capability
// endpoints; view links get a read-only grid. R4-T4: the scope is visible
// and note edits carry a real CAS/conflict state.
export default function GoalShareReader({
  data,
  token,
}: {
  data: GoalShareData;
  token: string;
}) {
  const { t } = useTranslation("share");
  const [weekOffset, setWeekOffset] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [checkins, setCheckins] = useState<GoalShareCheckin[]>(data.checkins);
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteConflict, setNoteConflict] = useState(false);
  const canEdit = data.scope === "edit" && data.archivedAt === null;
  const canEditNow = canEdit && isEditing;

  const byDate = useMemo(
    () => new Map(checkins.map((ci) => [ci.checkInDate, ci])),
    [checkins],
  );
  const totalAllTime = checkins.filter((ci) => ci.completed).length;
  const weekStart = useMemo(() => {
    const start = startOfWeek(new Date());
    start.setDate(start.getDate() + weekOffset * 7);
    return start;
  }, [weekOffset]);
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => {
        const day = new Date(weekStart);
        day.setDate(day.getDate() + index);
        return day;
      }),
    [weekStart],
  );
  const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
  });
  const rangeFormatter = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  });

  const noteSave = useMutation({
    mutationFn: updateSharedGoalNote,
    onSuccess: (row) => {
      setCheckins((current) =>
        current.map((ci) =>
          ci.checkInDate === row.checkInDate
            ? { ...ci, note: row.note, noteRevision: row.noteRevision }
            : ci,
        ),
      );
      setEditingDate(null);
      setNoteConflict(false);
      setNoteError(null);
    },
    onError: (error) => {
      if (error instanceof ShareConflictError) {
        setNoteConflict(true);
      } else {
        setNoteError(t("goal.noteSaveFailed"));
      }
    },
  });

  const toggle = async (dateKey: string) => {
    if (!canEditNow || pendingDate) return;
    const existing = byDate.get(dateKey);
    const nextCompleted = !(existing?.completed === true);
    setCheckins((current) =>
      existing
        ? current.map((ci) =>
            ci.checkInDate === dateKey
              ? { ...ci, completed: nextCompleted }
              : ci,
          )
        : [...current, { checkInDate: dateKey, completed: true, note: "" }],
    );
    setPendingDate(dateKey);
    try {
      const response = await fetch(`${apiBase}/share/goal/${token}/checkin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateKey }),
      });
      if (!response.ok) {
        throw new Error("toggle failed");
      }
      const row = (await response.json()) as {
        id: string;
        checkInDate: string;
        completed: boolean;
        note: string;
        noteRevision: number;
      };
      setCheckins((current) => {
        const exists = current.some((ci) => ci.checkInDate === row.checkInDate);
        if (exists) {
          return current.map((ci) =>
            ci.checkInDate === row.checkInDate
              ? {
                  ...ci,
                  completed: row.completed,
                  note: row.note,
                  noteRevision: row.noteRevision,
                  id: row.id ?? ci.id,
                }
              : ci,
          );
        }
        return [...current, { ...row, id: row.id }];
      });
    } catch {
      setCheckins((current) =>
        existing
          ? current.map((ci) => (ci.checkInDate === dateKey ? existing : ci))
          : current.filter((ci) => ci.checkInDate !== dateKey),
      );
    } finally {
      setPendingDate(null);
    }
  };

  const startNoteEdit = (ci: GoalShareCheckin) => {
    setEditingDate(ci.checkInDate);
    setNoteDraft(ci.note);
    setNoteConflict(false);
    setNoteError(null);
  };

  const saveNoteEdit = (ci: GoalShareCheckin) => {
    if (!ci.id || typeof ci.noteRevision !== "number") {
      setNoteError(t("goal.noteSaveFailed"));
      return;
    }
    noteSave.mutate({
      token,
      checkinId: ci.id,
      note: noteDraft,
      noteRevision: ci.noteRevision,
    });
  };

  const reloadLatestNoteRevision = async (ci: GoalShareCheckin) => {
    try {
      const response = await fetch(`${apiBase}/share/goal/${token}`);
      if (!response.ok) throw new Error("reload failed");
      const latest = (await response.json()) as GoalShareData;
      const latestCheckin = latest.checkins.find(
        (row) => row.checkInDate === ci.checkInDate,
      );
      if (!latestCheckin?.id) throw new Error("check-in unavailable");
      setCheckins((current) =>
        current.map((row) =>
          row.checkInDate === ci.checkInDate ? latestCheckin : row,
        ),
      );
      // Keep the local draft, but rebase it onto the latest revision so the
      // next save is an explicit overwrite rather than a repeated stale write.
      setNoteConflict(false);
      setNoteError(null);
    } catch {
      setNoteError(t("goal.noteReloadFailed"));
    }
  };

  // Rows worth showing: any note text, or any row that exists server-side
  // (so an edit-link holder can start a note on a completed day).
  const notes = checkins
    .filter((ci) => ci.note || ci.id)
    .sort((left, right) => right.checkInDate.localeCompare(left.checkInDate));

  return (
    <article className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold text-foreground">
            {data.name}
          </h1>
          <ShareScopeBadge scope={canEdit ? "edit" : "view"} />
          <div className="flex-1" />
          {canEdit ? (
            <Button
              size="sm"
              variant={isEditing ? "outline" : "secondary"}
              className="min-h-11 gap-1.5 sm:min-h-8"
              onClick={() => {
                if (isEditing) setEditingDate(null);
                setIsEditing((current) => !current);
              }}
            >
              {isEditing ? t("doneEditing") : t("edit")}
            </Button>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("goal.totalAllTime", { total: totalAllTime })}
          {typeof data.targetPerWeek === "number"
            ? t("goal.perWeek", { target: data.targetPerWeek })
            : null}
        </p>
        {/* R3-T3: make the link scope obvious — an edit link can tick and
        write notes, a view link cannot. */}
        {isEditing ? null : (
          <p className="mt-1 text-xs text-muted-foreground">
            {canEdit ? t("goal.editHint") : t("goal.viewHint")}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-xs"
          aria-label={t("goal.prevWeek")}
          onClick={() => setWeekOffset((value) => value - 1)}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <span className="text-sm font-medium text-foreground">
          {rangeFormatter.format(days[0])} – {rangeFormatter.format(days[6])}
        </span>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label={t("goal.nextWeek")}
          onClick={() => setWeekOffset((value) => value + 1)}
        >
          <ChevronRight className="size-3.5" />
        </Button>
        {weekOffset !== 0 ? (
          <Button variant="ghost" size="xs" onClick={() => setWeekOffset(0)}>
            {t("goal.thisWeek")}
          </Button>
        ) : null}
      </div>

      <div className="scrollbar-none overflow-x-auto rounded-lg border border-border/80">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-border/80">
              <th className="bg-card px-3 py-2 text-start text-xs font-medium text-muted-foreground">
                {t("goal.matrixGoal")}
              </th>
              {days.map((day) => (
                <th
                  key={formatDateKey(day)}
                  scope="col"
                  className="w-14 px-2 py-2 text-center"
                >
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    {weekdayFormatter.format(day)}
                  </span>
                  <span className="block text-xs font-medium text-foreground">
                    {day.getDate()}
                  </span>
                </th>
              ))}
              <th className="w-16 px-2 py-2 text-center text-xs font-medium text-muted-foreground">
                {t("goal.totalColumn")}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="max-w-48 truncate px-3 py-2.5 font-medium text-foreground">
                {data.name}
              </td>
              {days.map((day) => {
                const key = formatDateKey(day);
                const completed = byDate.get(key)?.completed === true;
                return (
                  <td key={key} className="px-2 py-2.5 text-center">
                    <input
                      type="checkbox"
                      checked={completed}
                      disabled={!canEditNow || pendingDate !== null}
                      onChange={() => void toggle(key)}
                      aria-label={`${data.name} — ${key}`}
                      className="size-4 accent-[var(--primary)]"
                    />
                  </td>
                );
              })}
              <td className="px-2 py-2.5 text-center font-medium tabular-nums text-foreground">
                {totalAllTime}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {notes.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">
            {t("goal.notesTitle")}
          </h2>
          {notes.map((ci) => {
            const isEditingNote = editingDate === ci.checkInDate && canEditNow;
            return (
              <div
                key={ci.checkInDate}
                className="rounded-lg border border-border/80 p-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {ci.checkInDate}
                  </span>
                  <div className="flex-1" />
                  {canEditNow && !isEditingNote && ci.id ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="min-h-8 text-xs text-muted-foreground sm:min-h-6"
                      onClick={() => startNoteEdit(ci)}
                    >
                      {t("edit")}
                    </Button>
                  ) : null}
                </div>
                {isEditingNote ? (
                  <div className="mt-2 space-y-2">
                    <Textarea
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      rows={3}
                      aria-label={t("goal.noteEditorAria")}
                    />
                    {noteConflict ? (
                      <div className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-foreground">
                        {t("goal.noteConflict")}
                        <Button
                          size="xs"
                          variant="secondary"
                          className="ml-2"
                          onClick={() => void reloadLatestNoteRevision(ci)}
                        >
                          {t("goal.noteConflictDismiss")}
                        </Button>
                      </div>
                    ) : null}
                    {noteError ? (
                      <p className="text-xs text-foreground" role="alert">
                        {noteError}
                      </p>
                    ) : null}
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={noteSave.isPending}
                        onClick={() => {
                          setEditingDate(null);
                          setNoteConflict(false);
                          setNoteError(null);
                        }}
                      >
                        {t("goal.noteCancel")}
                      </Button>
                      <Button
                        size="xs"
                        className="min-h-8 sm:min-h-6"
                        disabled={noteSave.isPending}
                        onClick={() => saveNoteEdit(ci)}
                      >
                        {noteSave.isPending
                          ? t("goal.noteSaving")
                          : t("goal.noteSave")}
                      </Button>
                    </div>
                  </div>
                ) : ci.note ? (
                  <SharedMarkdown
                    content={ci.note}
                    resourceType="goal"
                    token={token}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
