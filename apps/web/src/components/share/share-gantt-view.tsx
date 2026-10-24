import { addDays, eachDayOfInterval, endOfWeek, format, parseISO, startOfWeek, subDays } from "date-fns";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GanttTaskBar } from "@/components/gantt/gantt-task-bar";
import type { ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";

// Guest Gantt reuses the owner's draggable/resizable GanttTaskBar. It only
// includes project tasks with valid dates, exactly as the authenticated view.

function parseTaskDate(value: string | null) {
  if (!value) return null;
  const parsed = parseISO(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type ScheduledTask = Task & { scheduleStart: Date; scheduleEnd: Date };

export default function ShareGanttView({
  project,
  onOpenTask,
}: {
  project: ProjectWithTasks;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const dayWidthRem = 2.75;

  const scheduledTasks = useMemo(() => {
    const tasks = [
      ...project.columns.flatMap((column) => column.tasks),
      ...project.plannedTasks,
    ];
    return tasks
      .map((task): ScheduledTask | null => {
        const first = parseTaskDate(task.startDate) ?? parseTaskDate(task.dueDate);
        const second = parseTaskDate(task.dueDate) ?? parseTaskDate(task.startDate);
        if (!first || !second) return null;
        return {
          ...task,
          scheduleStart: first <= second ? first : second,
          scheduleEnd: second >= first ? second : first,
        };
      })
      .filter((task): task is ScheduledTask => task !== null)
      .sort((left, right) => left.scheduleStart.getTime() - right.scheduleStart.getTime());
  }, [project]);

  const timeline = useMemo(() => {
    if (scheduledTasks.length === 0) return null;
    const earliest = scheduledTasks[0]!.scheduleStart;
    const latest = scheduledTasks.reduce(
      (current, task) => (task.scheduleEnd > current ? task.scheduleEnd : current),
      scheduledTasks[0]!.scheduleEnd,
    );
    const rangeStart = subDays(startOfWeek(earliest), 7);
    const rangeEnd = addDays(endOfWeek(latest), 14);
    const days = eachDayOfInterval({ start: rangeStart, end: rangeEnd });
    return {
      days,
      rangeStart,
      gridTemplateColumns: `repeat(${days.length}, minmax(${dayWidthRem}rem, ${dayWidthRem}rem))`,
      widthRem: days.length * dayWidthRem,
    };
  }, [scheduledTasks]);

  if (!timeline || scheduledTasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {t("tasks:gantt.noScheduledTasks")}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto rounded-md border border-border/70 bg-background">
      <div className="min-w-max">
        <div className="sticky top-0 z-10 grid border-b border-border/70 bg-background" style={{ gridTemplateColumns: `14rem ${timeline.gridTemplateColumns}` }}>
          <div className="sticky left-0 z-20 border-r border-border/70 bg-background px-3 py-2 text-xs font-medium text-muted-foreground">
            {t("tasks:gantt.task")}
          </div>
          <div className="grid" style={{ gridTemplateColumns: timeline.gridTemplateColumns }}>
            {timeline.days.map((day) => (
              <div key={day.toISOString()} className="border-r border-border/50 px-1 py-2 text-center text-[10px] text-muted-foreground">
                {format(day, "MMM d")}
              </div>
            ))}
          </div>
        </div>
        {scheduledTasks.map((task) => (
          <div key={task.id} className="grid border-b border-border/40" style={{ gridTemplateColumns: `14rem ${timeline.gridTemplateColumns}` }}>
            <button type="button" className="sticky left-0 z-[2] flex min-w-0 items-center gap-2 border-r border-border/70 bg-background px-3 py-2 text-left hover:bg-muted/50" onClick={() => onOpenTask(task.id)}>
              <span className="shrink-0 text-[10px] text-muted-foreground">{project.slug}-{task.number}</span>
              <span className="truncate text-xs font-medium">{task.title}</span>
            </button>
            <div className="relative min-h-11 select-none" style={{ minWidth: `${timeline.widthRem}rem` }}>
              <div className="absolute inset-y-0 z-0 grid" style={{ gridTemplateColumns: timeline.gridTemplateColumns }}>
                {timeline.days.map((day) => (
                  <div key={day.toISOString()} className="h-full border-r border-border/50" />
                ))}
              </div>
              <GanttTaskBar
                task={task}
                timeline={timeline}
                pixelsPerDay={44}
                onOpenTask={() => onOpenTask(task.id)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
