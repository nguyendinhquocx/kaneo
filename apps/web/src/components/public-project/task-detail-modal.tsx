import { Calendar, CalendarClock, CalendarX } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { dueDateStatusColors, getDueDateStatus } from "@/lib/due-date-status";
import { formatDateMedium, formatDateShort } from "@/lib/format";
import { getPriorityIcon } from "@/lib/priority";
import type { PublicProjectTask } from "@/types/public-project";
import { MarkdownRenderer } from "./markdown-renderer";
import { PublicTaskLabels } from "./public-task-labels";

type PublicTaskDetailModalProps = {
  task: PublicProjectTask | null;
  projectSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PublicTaskDetailModal({
  task,
  projectSlug,
  open,
  onOpenChange,
}: PublicTaskDetailModalProps) {
  const { t } = useTranslation();

  if (!task) return null;

  const labels = task.labels || [];

  const statusLabel = task.status ? t(`tasks:status.${task.status}`) : "";
  const priorityLabel =
    task.priority != null && task.priority !== ""
      ? t(`tasks:priority.${task.priority}`)
      : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-2xl max-h-[85vh] p-0">
        <div className="bg-background border border-border rounded-xl flex flex-col max-h-[85vh] shadow-lg">
          <div className="flex min-w-0 items-center justify-between border-border/70 border-b px-4 py-3 pe-14 shrink-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
                {projectSlug.toUpperCase()}-{task.number}
              </span>
              {statusLabel ? (
                <span className="max-w-[35%] shrink-0 truncate rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {statusLabel}
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
            <div className="space-y-3">
              <DialogTitle className="pr-8 text-2xl leading-tight text-foreground">
                {task.title}
              </DialogTitle>

              <div className="flex flex-wrap gap-2">
                {task.priority && priorityLabel && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-muted text-muted-foreground rounded-md">
                    {getPriorityIcon(task.priority)}
                    <span>{priorityLabel}</span>
                  </div>
                )}

                {task.dueDate && (
                  <div
                    className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md ${dueDateStatusColors[getDueDateStatus(task.dueDate)]}`}
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
                    <span>
                      {t("publicProject:taskDetail.dueWithDate", {
                        date: formatDateShort(task.dueDate),
                      })}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {task.description ? (
              <div className="pt-1">
                <MarkdownRenderer content={task.description} />
              </div>
            ) : (
              <p className="pt-1 text-sm text-muted-foreground">
                {t("publicProject:taskDetail.noDescription")}
              </p>
            )}

            {labels.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t("publicProject:taskDetail.labels")}
                </h3>
                <PublicTaskLabels labels={labels} />
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-2 border-t border-border/50">
              <div>
                <div className="text-xs text-muted-foreground mb-1">
                  {t("publicProject:taskDetail.created")}
                </div>
                <div className="text-sm text-foreground">
                  {formatDateMedium(task.createdAt)}
                </div>
              </div>
              {task.dueDate && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {t("publicProject:taskDetail.dueDateLabel")}
                  </div>
                  <div className="text-sm text-foreground">
                    {formatDateMedium(task.dueDate)}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
