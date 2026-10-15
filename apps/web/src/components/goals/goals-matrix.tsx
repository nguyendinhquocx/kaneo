import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  NotebookPen,
  Plus,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import GoalDetailsSheet from "@/components/goals/goal-details-sheet";
import ShareDialog from "@/components/share/share-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type GoalType,
  useCreateGoal,
  useGetGoals,
  useSetGoalArchived,
  useToggleGoalCheckin,
} from "@/hooks/queries/goal/use-goals";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

// SPEC-2026-10-08-kaneo-workspace-collaboration T6: the matrix stays a
// table-like grid, not a Kanban. Only the 7-date region scrolls horizontally;
// the goal column and the total stay visible. Tick and note are separate
// affordances; archived goals leave the active list without losing history.

export function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getMonday(date: Date): Date {
  const result = new Date(date);
  const day = result.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  result.setDate(result.getDate() + diff);
  result.setHours(0, 0, 0, 0);
  return result;
}

type GoalsMatrixProps = {
  workspaceId: string;
};

export default function GoalsMatrix({ workspaceId }: GoalsMatrixProps) {
  const { t } = useTranslation("goals");
  const [weekOffset, setWeekOffset] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [newGoalName, setNewGoalName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [noteTarget, setNoteTarget] = useState<{
    goal: GoalType;
    dateKey: string;
  } | null>(null);
  const createGoal = useCreateGoal();
  const toggleCheckin = useToggleGoalCheckin();
  const setArchived = useSetGoalArchived();
  const { canWriteDocuments } = useWorkspacePermission();
  const canWrite = canWriteDocuments();

  const weekStart = useMemo(() => {
    const base = getMonday(new Date());
    base.setDate(base.getDate() + weekOffset * 7);
    return base;
  }, [weekOffset]);

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(weekStart);
      date.setDate(date.getDate() + i);
      return date;
    });
  }, [weekStart]);

  const from = formatDateKey(weekDays[0]);
  const to = formatDateKey(weekDays[6]);

  const {
    data: goals = [],
    isLoading,
    isError,
    refetch,
  } = useGetGoals({
    workspaceId,
    includeArchived: showArchived,
    from,
    to,
  });

  const handleCreate = async () => {
    const name = newGoalName.trim();
    if (!name) return;
    setIsCreating(true);
    try {
      await createGoal.mutateAsync({
        workspaceId,
        name,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
      setNewGoalName("");
    } catch {
      toast.error(t("errors.createFailed"));
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggle = (goal: GoalType, dateKey: string) => {
    if (!canWrite || goal.archivedAt) return;
    toggleCheckin.mutateAsync({ goalId: goal.id, date: dateKey }).catch(() => {
      toast.error(t("errors.toggleFailed"));
    });
  };

  const openNote = (goal: GoalType) => {
    const todayKey = formatDateKey(new Date());
    setNoteTarget({ goal, dateKey: todayKey });
  };

  const checkinFor = (goal: GoalType, dateKey: string) =>
    goal.checkins.find((ci) => ci.checkInDate === dateKey);

  const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
  });
  const rangeFormatter = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  });

  const createForm = (
    <div className="flex w-full max-w-64 items-center gap-1.5 sm:w-auto sm:max-w-none">
      <Input
        value={newGoalName}
        onChange={(event) => setNewGoalName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void handleCreate();
        }}
        placeholder={t("newGoalPlaceholder")}
        className="h-7 min-w-0 flex-1 text-xs sm:w-48 sm:flex-none"
        aria-label={t("newGoalPlaceholder")}
      />
      <Button
        size="xs"
        className="gap-1.5"
        disabled={!newGoalName.trim() || isCreating}
        onClick={() => void handleCreate()}
      >
        <Plus className="size-3.5" />
        {t("createGoal")}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-lg border border-border/80 bg-background p-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("previousWeek")}
            onClick={() => setWeekOffset((w) => w - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 text-xs"
            onClick={() => setWeekOffset(0)}
            disabled={weekOffset === 0}
          >
            {t("thisWeek")}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("nextWeek")}
            onClick={() => setWeekOffset((w) => w + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          {rangeFormatter.format(weekDays[0])} –{" "}
          {rangeFormatter.format(weekDays[6])}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          className="gap-1.5 text-xs"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? (
            <ArchiveRestore className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )}
          {showArchived ? t("showActive") : t("showArchived")}
        </Button>
        {canWrite && goals.length > 0 ? createForm : null}
      </div>

      {isError ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {t("errors.loadFailed")}
          </p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            {t("errors.retry")}
          </Button>
        </div>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => `sk-${i}`).map((key) => (
            <div key={key} className="h-10 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : goals.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          {showArchived ? (
            <p className="text-sm text-muted-foreground">
              {t("emptyArchived")}
            </p>
          ) : null}
          {canWrite && !showArchived ? createForm : null}
        </div>
      ) : (
        <div className="rounded-lg border border-border/80">
          <ScrollArea className="w-full">
            <Table aria-label={t("matrixAria")}>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 min-w-44 bg-card">
                    {t("goalColumn")}
                  </TableHead>
                  {weekDays.map((date) => {
                    const key = formatDateKey(date);
                    return (
                      <TableHead
                        key={key}
                        className="w-14 min-w-14 text-center"
                        scope="col"
                      >
                        <span className="block text-[10px] font-normal text-muted-foreground">
                          {weekdayFormatter.format(date)}
                        </span>
                        <span className="block text-xs font-medium">
                          {date.getDate()}
                        </span>
                      </TableHead>
                    );
                  })}
                  <TableHead className="w-16 min-w-16 text-center">
                    {t("totalColumn")}
                  </TableHead>
                  <TableHead className="w-12 min-w-12" aria-hidden />
                  <TableHead className="w-12 min-w-12" aria-hidden />
                  {canWrite ? (
                    <TableHead className="w-12 min-w-12" aria-hidden />
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {goals.map((goal) => {
                  // UAT: "Tổng" counts every week, not just the viewed one;
                  // the per-week target stays as a tooltip on the cell.
                  const total = goal.totalAllTime;
                  const target = goal.targetPerWeek;
                  return (
                    <TableRow
                      key={goal.id}
                      className={cn(goal.archivedAt && "opacity-70")}
                    >
                      <TableCell className="sticky left-0 z-10 bg-card">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {goal.name}
                          </span>
                          {goal.visibility === "private" ? (
                            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                              {t("privateBadge")}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      {weekDays.map((date) => {
                        const key = formatDateKey(date);
                        const checkin = checkinFor(goal, key);
                        return (
                          <TableCell key={key} className="text-center">
                            <Checkbox
                              checked={checkin?.completed === true}
                              disabled={!canWrite || goal.archivedAt !== null}
                              onCheckedChange={() => handleToggle(goal, key)}
                              aria-label={`${goal.name} — ${key}`}
                              className="relative size-4.5 after:absolute after:-inset-[13px] after:content-['']"
                            />
                          </TableCell>
                        );
                      })}
                      <TableCell
                        className="text-center text-sm font-medium tabular-nums"
                        title={
                          target ? t("weeklyTarget", { target }) : undefined
                        }
                      >
                        {total}
                      </TableCell>
                      <TableCell className="text-center">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("noteAria")}
                          className="size-8 text-muted-foreground"
                          onClick={() => openNote(goal)}
                        >
                          <NotebookPen className="size-3.5" />
                        </Button>
                      </TableCell>
                      <TableCell className="text-center">
                        <ShareDialog
                          resourceType="goal"
                          resourceId={goal.id}
                          canShare={canWrite}
                        />
                      </TableCell>
                      {canWrite ? (
                        <TableCell className="text-center">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={
                              goal.archivedAt ? t("unarchive") : t("archive")
                            }
                            disabled={setArchived.isPending}
                            onClick={() =>
                              setArchived.mutate({
                                goalId: goal.id,
                                archived: goal.archivedAt === null,
                              })
                            }
                          >
                            {goal.archivedAt ? (
                              <ArchiveRestore className="size-3.5 text-muted-foreground" />
                            ) : (
                              <Archive className="size-3.5 text-muted-foreground" />
                            )}
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </div>
      )}

      {noteTarget ? (
        <GoalDetailsSheet
          goal={noteTarget.goal}
          dateKey={noteTarget.dateKey}
          onClose={() => setNoteTarget(null)}
        />
      ) : null}
    </div>
  );
}
