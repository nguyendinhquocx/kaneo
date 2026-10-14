import { Calendar, CalendarClock, CalendarX } from "lucide-react";
import { useRef } from "react";
import { dueDateStatusColors, getDueDateStatus } from "@/lib/due-date-status";
import { formatDateShort } from "@/lib/format";
import { getPriorityIcon } from "@/lib/priority";
import type { PublicProjectTask } from "@/types/public-project";
import { PublicTaskLabels } from "./public-task-labels";

type PublicTaskCardProps = {
  task: PublicProjectTask;
  projectSlug: string;
  onTaskClick: (task: PublicProjectTask) => void;
};

export function PublicTaskCard({
  task,
  projectSlug,
  onTaskClick,
}: PublicTaskCardProps) {
  const labels = task.labels || [];
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(
    null,
  );

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;

    const touch = e.changedTouches[0];
    const deltaX = Math.abs(touch.clientX - touchStartRef.current.x);
    const deltaY = Math.abs(touch.clientY - touchStartRef.current.y);
    const deltaTime = Date.now() - touchStartRef.current.time;

    if (deltaX > 10 || deltaY > 10 || deltaTime > 300) {
      e.preventDefault();
      touchStartRef.current = null;
      return;
    }

    touchStartRef.current = null;
    onTaskClick(task);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.detail === 0) return;
    onTaskClick(task);
  };

  return (
    <button
      type="button"
      className="group w-full text-left p-3 bg-card border border-border rounded-lg cursor-pointer transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:border-border/70 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onClick={handleClick}
      aria-label={`View details for task ${task.title}`}
    >
      <div className="text-[10px] font-mono text-muted-foreground mb-2">
        {projectSlug}-{task.number}
      </div>

      <div className="mb-3">
        <h3
          className="font-medium text-foreground text-sm leading-relaxed overflow-hidden break-words"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            wordBreak: "break-word",
            hyphens: "auto",
          }}
        >
          {task.title}
        </h3>
      </div>

      {labels.length > 0 && (
        <div className="mb-3">
          <PublicTaskLabels labels={labels} />
        </div>
      )}

      <div className="flex items-center gap-2">
        {task.priority && (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-border bg-sidebar text-[10px] font-medium text-muted-foreground">
            {getPriorityIcon(task.priority ?? "")}
          </span>
        )}

        {task.dueDate && (
          <div
            className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded ${dueDateStatusColors[getDueDateStatus(task.dueDate)]}`}
          >
            {getDueDateStatus(task.dueDate) === "overdue" && (
              <CalendarX className="w-3 h-3" />
            )}
            {getDueDateStatus(task.dueDate) === "due-soon" && (
              <CalendarClock className="w-3 h-3" />
            )}
            {(getDueDateStatus(task.dueDate) === "far-future" ||
              getDueDateStatus(task.dueDate) === "no-due-date") && (
              <Calendar className="w-3 h-3" />
            )}
            <span>{formatDateShort(task.dueDate)}</span>
          </div>
        )}
      </div>
    </button>
  );
}
