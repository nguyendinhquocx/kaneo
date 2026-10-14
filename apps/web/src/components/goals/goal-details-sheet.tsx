import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CalendarDays, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import CommentEditor from "@/components/activity/comment-editor";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  type GoalCheckinType,
  type GoalType,
  useToggleGoalCheckin,
  useUpdateGoalCheckinNote,
} from "@/hooks/queries/goal/use-goals";
import { toast } from "@/lib/toast";

// SPEC-2026-10-08-kaneo-workspace-collaboration T6: a distinct details sheet
// for the Markdown check-in note. Toggling completion happens in the grid;
// notes save with revision CAS and surface conflicts explicitly.

type GoalDetailsSheetProps = {
  goal: GoalType;
  dateKey: string;
  checkin?: GoalCheckinType;
  onClose: () => void;
};

export default function GoalDetailsSheet({
  goal,
  dateKey,
  checkin,
  onClose,
}: GoalDetailsSheetProps) {
  const { t } = useTranslation("goals");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const updateNote = useUpdateGoalCheckinNote();
  const toggleCheckin = useToggleGoalCheckin();
  const [note, setNote] = useState(checkin?.note ?? "");
  const [revision, setRevision] = useState(checkin?.noteRevision ?? 1);
  const [conflict, setConflict] = useState(false);
  const [loadedKey, setLoadedKey] = useState(
    `${goal.id}:${checkin?.id ?? dateKey}`,
  );

  useEffect(() => {
    const key = `${goal.id}:${checkin?.id ?? dateKey}`;
    if (key !== loadedKey) {
      setLoadedKey(key);
      setNote(checkin?.note ?? "");
      setRevision(checkin?.noteRevision ?? 1);
      setConflict(false);
    }
  }, [goal.id, checkin, dateKey, loadedKey]);

  const handleSave = async () => {
    if (!checkin) {
      toast.error(t("sheet.noRow"));
      return;
    }
    try {
      const result = await updateNote.mutateAsync({
        checkinId: checkin.id,
        note,
        noteRevision: revision,
      });
      if ("conflict" in result) {
        setConflict(true);
        return;
      }
      setRevision(result.noteRevision);
      setConflict(false);
      toast.success(t("sheet.saved"));
    } catch {
      toast.error(t("errors.saveFailed"));
    }
  };

  // P2-8 fix: a day without a check-in row can still get a note — create the
  // row first (spec allows rows with completed=false), then edit its note.
  const handleEnsureRow = async () => {
    try {
      await toggleCheckin.mutateAsync({ goalId: goal.id, date: dateKey });
      await queryClient.invalidateQueries({ queryKey: ["goals"] });
      onClose();
    } catch {
      toast.error(t("errors.toggleFailed"));
    }
  };

  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

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
            {dateFormatter.format(new Date(`${dateKey}T00:00:00`))}
            {checkin?.completed ? (
              <span className="ml-1 rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success-foreground">
                {t("sheet.completed")}
              </span>
            ) : checkin ? (
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
              className="flex w-full items-center gap-2 rounded-lg border border-border/80 px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent"
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

          {conflict ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground">
              {t("sheet.conflict")}
              <div className="mt-2 flex gap-2">
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={async () => {
                    // P2-5 fix: the local checkin prop is stale after a
                    // conflict — refetch the matrix and reopen from fresh data.
                    await queryClient.invalidateQueries({
                      queryKey: ["goals"],
                    });
                    onClose();
                  }}
                >
                  {t("sheet.reloadNote")}
                </Button>
              </div>
            </div>
          ) : null}

          {checkin ? (
            <>
              <CommentEditor
                value={note}
                onChange={(next) => {
                  setNote(next);
                  setConflict(false);
                }}
                placeholder={t("sheet.notePlaceholder")}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={updateNote.isPending || conflict}
                  onClick={() => void handleSave()}
                >
                  {updateNote.isPending ? t("sheet.saving") : t("sheet.save")}
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
                  disabled={toggleCheckin.isPending}
                  onClick={() => void handleEnsureRow()}
                >
                  {t("sheet.startEntry")}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
