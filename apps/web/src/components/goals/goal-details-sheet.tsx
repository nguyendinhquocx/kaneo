import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileText,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CommentEditor from "@/components/activity/comment-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  type GoalType,
  useGetGoalCheckins,
  useToggleGoalCheckin,
  useUpdateGoalCheckinNote,
} from "@/hooks/queries/goal/use-goals";
import { toast } from "@/lib/toast";

// SPEC-2026-10-08-kaneo-workspace-collaboration T6 + UAT repair: the sheet
// covers ANY day (prev/next navigation), reads the full check-in history from
// the server, and lists past notes so they are reviewable after the week
// passes. Toggling completion stays in the grid; notes save with revision CAS.

type GoalDetailsSheetProps = {
  goal: GoalType;
  dateKey: string;
  onClose: () => void;
};

function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function GoalDetailsSheet({
  goal,
  dateKey: initialDateKey,
  onClose,
}: GoalDetailsSheetProps) {
  const { t } = useTranslation("goals");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const updateNote = useUpdateGoalCheckinNote();
  const toggleCheckin = useToggleGoalCheckin();
  const [selectedDate, setSelectedDate] = useState(initialDateKey);
  const [note, setNote] = useState("");
  const [revision, setRevision] = useState(1);
  const [conflict, setConflict] = useState(false);
  const [loadedKey, setLoadedKey] = useState(`${goal.id}:${initialDateKey}`);
  // Reviewer P2: switching days must not silently discard an unsaved draft.
  const syncedNoteRef = useRef("");
  const { data: checkins = [], refetch: refetchCheckins } = useGetGoalCheckins(
    goal.id,
  );

  const checkinForDate = useMemo(
    () => checkins.find((ci) => ci.checkInDate === selectedDate),
    [checkins, selectedDate],
  );
  const noteIsDirty = note !== syncedNoteRef.current;

  // Notes worth reviewing, newest first.
  const notedCheckins = useMemo(
    () =>
      checkins
        .filter((ci) => ci.note.trim().length > 0)
        .sort((a, b) => (a.checkInDate < b.checkInDate ? 1 : -1)),
    [checkins],
  );

  // Sync the editor whenever the viewed row changes (date switch or fresh
  // server data after creating a row / saving elsewhere).
  useEffect(() => {
    const key = `${goal.id}:${selectedDate}:${checkinForDate?.id ?? "none"}:${
      checkinForDate?.noteRevision ?? 0
    }`;
    if (key !== loadedKey) {
      const latestNote = checkinForDate?.note ?? "";
      setLoadedKey(key);
      if (note !== syncedNoteRef.current) {
        // A background refresh from another writer must not erase the local
        // draft; keep it and require an explicit reload or CAS resolution.
        setConflict(true);
        return;
      }
      setNote(latestNote);
      syncedNoteRef.current = latestNote;
      setRevision(checkinForDate?.noteRevision ?? 1);
      setConflict(false);
    }
  }, [goal.id, selectedDate, checkinForDate, loadedKey, note]);

  // Block day navigation while a draft differs from the synced server value —
  // the sheet has no autosave, so switching would lose the text.
  const goToDay = (nextDateKey: string) => {
    if (nextDateKey === selectedDate) return;
    if (note !== syncedNoteRef.current) {
      toast.warning(t("sheet.unsavedNote"));
      return;
    }
    setSelectedDate(nextDateKey);
  };

  const shiftDate = (days: number) => {
    const date = new Date(`${selectedDate}T00:00:00`);
    date.setDate(date.getDate() + days);
    goToDay(formatDateKey(date));
  };

  const handleSave = async () => {
    if (!checkinForDate || !noteIsDirty) {
      toast.error(t("sheet.noRow"));
      return;
    }
    try {
      const result = await updateNote.mutateAsync({
        checkinId: checkinForDate.id,
        note,
        noteRevision: revision,
      });
      if ("conflict" in result) {
        setConflict(true);
        return;
      }
      setRevision(result.noteRevision);
      syncedNoteRef.current = note;
      setConflict(false);
      toast.success(t("sheet.saved"));
    } catch {
      toast.error(t("errors.saveFailed"));
    }
  };

  // R3-T5: deleting a note saves an empty note — the check-in row (and its
  // completion state) survives, only the text goes away.
  const handleDeleteNote = async () => {
    if (!checkinForDate?.note) return;
    try {
      const result = await updateNote.mutateAsync({
        checkinId: checkinForDate.id,
        note: "",
        noteRevision: revision,
      });
      if ("conflict" in result) {
        setConflict(true);
        return;
      }
      setRevision(result.noteRevision);
      syncedNoteRef.current = "";
      setNote("");
      setConflict(false);
      toast.success(t("sheet.noteDeleted"));
    } catch {
      toast.error(t("errors.saveFailed"));
    }
  };

  // A day without a check-in row can still get a note — create the row first
  // (spec allows rows with completed=false), then edit its note.
  const handleEnsureRow = async () => {
    try {
      // Reviewer P3: taking a note must not silently tick the day as done.
      await toggleCheckin.mutateAsync({
        goalId: goal.id,
        date: selectedDate,
        ensureOnly: true,
      });
      await queryClient.invalidateQueries({ queryKey: ["goals"] });
      await queryClient.invalidateQueries({ queryKey: ["goal-checkins"] });
    } catch {
      toast.error(t("errors.toggleFailed"));
    }
  };

  const handleReloadNote = async () => {
    try {
      const result = await refetchCheckins();
      if (!result.isSuccess || !result.data) {
        toast.error(t("errors.loadFailed"));
        return;
      }
      const fresh = result.data.find(
        (item) => item.checkInDate === selectedDate,
      );
      if (!fresh) {
        toast.error(t("sheet.noRow"));
        return;
      }
      setLoadedKey(
        `${goal.id}:${selectedDate}:${fresh.id}:${fresh.noteRevision}`,
      );
      setNote(fresh.note);
      syncedNoteRef.current = fresh.note;
      setRevision(fresh.noteRevision);
      setConflict(false);
    } catch {
      toast.error(t("errors.loadFailed"));
    }
  };

  const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  });
  const todayKey = formatDateKey(new Date());

  const notePreview = (value: string) => {
    const line = value.replace(/[#>*`\-\n]+/g, " ").trim();
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-border/80">
          <SheetTitle className="text-base">{goal.name}</SheetTitle>
          <SheetDescription className="flex items-center gap-1.5 text-xs">
            <CalendarDays className="size-3.5" />
            {checkinForDate?.completed ? (
              <span className="ml-1 rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success-foreground">
                {t("sheet.completed")}
              </span>
            ) : checkinForDate ? (
              <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t("sheet.notCompleted")}
              </span>
            ) : null}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {goal.projectId ? (
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border/80 px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent sm:min-h-0"
              onClick={() =>
                navigate({
                  to: "/dashboard/workspace/$workspaceId/project/$projectId/docs",
                  params: {
                    workspaceId: goal.workspaceId,
                    projectId: goal.projectId as string,
                  },
                })
              }
            >
              <FileText className="size-3.5 text-muted-foreground" />
              {t("sheet.relatedDocs")}
            </button>
          ) : null}

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-11 p-0 sm:size-8"
              aria-label={t("sheet.previousDay")}
              onClick={() => shiftDate(-1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Input
              type="date"
              value={selectedDate}
              aria-label={t("sheet.chooseDate")}
              className="h-11 min-w-0 flex-1 px-2 text-xs sm:h-8"
              onChange={(event) => {
                if (event.target.value) goToDay(event.target.value);
              }}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-11 p-0 sm:size-8"
              aria-label={t("sheet.nextDay")}
              onClick={() => shiftDate(1)}
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="h-11 px-3 text-xs sm:h-8"
              onClick={() => goToDay(todayKey)}
              disabled={selectedDate === todayKey}
            >
              {t("sheet.today")}
            </Button>
          </div>

          {conflict ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground">
              {t("sheet.conflict")}
              <div className="mt-2 flex gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => void handleReloadNote()}
                >
                  {t("sheet.reloadNote")}
                </Button>
              </div>
            </div>
          ) : null}

          {checkinForDate ? (
            <>
              <CommentEditor
                value={note}
                onChange={(next) => {
                  setNote(next);
                  setConflict(false);
                }}
                placeholder={t("sheet.notePlaceholder")}
                uploadOwner={{
                  ownerType: "goal_checkin",
                  ownerId: checkinForDate.id,
                }}
              />
              <div className="flex items-center justify-end gap-1.5">
                {checkinForDate.note ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-11 gap-1.5 text-muted-foreground hover:text-destructive sm:min-h-8"
                    disabled={updateNote.isPending || conflict}
                    onClick={() => void handleDeleteNote()}
                  >
                    <Trash2 className="size-3.5" />
                    {t("sheet.deleteNote")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  disabled={updateNote.isPending || conflict || !noteIsDirty}
                  onClick={() => void handleSave()}
                >
                  {updateNote.isPending
                    ? t("sheet.saving")
                    : noteIsDirty
                      ? t("sheet.save")
                      : t("sheet.saved")}
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t("sheet.noRow")}
              </p>
              {!goal.archivedAt ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="min-h-11 sm:min-h-8"
                  disabled={toggleCheckin.isPending}
                  onClick={() => void handleEnsureRow()}
                >
                  {t("sheet.startEntry")}
                </Button>
              ) : null}
            </div>
          )}

          {notedCheckins.length > 0 ? (
            <div className="mt-2 space-y-1.5">
              <h3 className="text-xs font-semibold text-foreground">
                {t("sheet.history")} ({notedCheckins.length})
              </h3>
              <ul className="space-y-1">
                {notedCheckins.map((ci) => (
                  <li key={ci.id}>
                    <button
                      type="button"
                      onClick={() => goToDay(ci.checkInDate)}
                      className={
                        "flex w-full flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors hover:bg-accent " +
                        (ci.checkInDate === selectedDate
                          ? "border-border bg-accent"
                          : "border-border/80")
                      }
                    >
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {shortDateFormatter.format(
                          new Date(`${ci.checkInDate}T00:00:00`),
                        )}
                        {ci.checkInDate === todayKey
                          ? ` · ${t("sheet.today")}`
                          : ""}
                      </span>
                      <span className="line-clamp-2 text-xs text-foreground">
                        {notePreview(ci.note)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
