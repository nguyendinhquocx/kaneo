import { Minus, Plus } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useUpdateWorkMarkers } from "@/hooks/mutations/task/use-update-work-markers";
import { normalizeWorkMarkerCounts, WORK_MARKER_GLYPHS, WORK_MARKER_KEYS } from "@/lib/work-markers";
import { toast } from "@/lib/toast";
import Task, { type TaskMarkerCounts } from "@/types/task";

// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: authenticated marker
// editor inside task properties. Each marker keeps its own 0–99 counter;
// saving sends the complete map. Failures keep the previous values.
export function WorkMarkerEditor({
  task,
  projectId,
  workspaceId,
}: {
  task: Task;
  projectId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const {
    mutateAsync: saveMarkers,
    isPending: isSavingMarkers,
  } = useUpdateWorkMarkers(task.id, projectId);
  const saveLock = useRef(false);

  const changeCount = async (key: keyof TaskMarkerCounts, delta: -1 | 1) => {
    // The endpoint replaces all four counts. Lock synchronously, then disable
    // the controls while pending, so rapid clicks cannot submit the same
    // stale map twice and silently lose one increment.
    if (isSavingMarkers || saveLock.current) {
      return;
    }
    const current = normalizeWorkMarkerCounts(task.workMarkerCounts);
    const nextValue = Math.min(99, Math.max(0, current[key] + delta));
    if (nextValue === current[key]) {
      return;
    }
    const next: TaskMarkerCounts = { ...current, [key]: nextValue };
    saveLock.current = true;
    try {
      await saveMarkers(next);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("tasks:workMarkers.saveError"),
      );
    } finally {
      saveLock.current = false;
    }
  };

  return (
    <div
      className="flex flex-col gap-1"
      aria-label={t("tasks:workMarkers.title")}
    >
      <span className="text-xs font-medium text-foreground/70 px-2">
        {t("tasks:workMarkers.title")}
      </span>
      <div className="flex flex-col gap-0.5">
        {WORK_MARKER_KEYS.map((key) => {
          const count = normalizeWorkMarkerCounts(task.workMarkerCounts)[key];
          const markerName = t(`tasks:workMarkers.${key}`);
          return (
            <div
              key={key}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-0.5"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground/90">
                <span aria-hidden="true">{WORK_MARKER_GLYPHS[key]}</span>
                <span className="truncate">{markerName}</span>
                <span className="min-w-4 text-right font-mono text-[10px] text-muted-foreground">
                  {count}
                </span>
              </span>
              <span className="flex shrink-0 items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-11 p-0 sm:size-8"
                  aria-label={t("tasks:workMarkers.decrease", {
                    name: markerName,
                    title: task.title,
                  })}
                  disabled={count === 0 || !workspaceId || isSavingMarkers}
                  onClick={() => void changeCount(key, -1)}
                >
                  <Minus className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-11 p-0 sm:size-8"
                  aria-label={t("tasks:workMarkers.increase", {
                    name: markerName,
                    title: task.title,
                  })}
                  disabled={count >= 99 || !workspaceId || isSavingMarkers}
                  onClick={() => void changeCount(key, 1)}
                >
                  <Plus className="size-3.5" />
                </Button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default WorkMarkerEditor;
