import { Check, CircleDot } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useUpdateWorkMarkers } from "@/hooks/mutations/task/use-update-work-markers";
import {
  normalizeWorkMarkerCounts,
  toggleWorkMarkerPreset,
  WORK_MARKER_GLYPHS,
  WORK_MARKER_KEYS,
  type WorkMarkerKey,
} from "@/lib/work-markers";
import { toast } from "@/lib/toast";
import type Task from "@/types/task";
import WorkMarkerCountList from "./work-marker-counts";

type WorkMarkerPickerProps = {
  task: Task;
  projectId: string;
  workspaceId: string;
  trigger?: "label" | "icon";
};

/** One quick picker serves the task header and each editable subtask row. */
export default function WorkMarkerPicker({
  task,
  projectId,
  workspaceId,
  trigger = "label",
}: WorkMarkerPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const saveLock = useRef(false);
  const { mutateAsync: saveMarkers, isPending } = useUpdateWorkMarkers(
    task.id,
    projectId,
  );
  const counts = normalizeWorkMarkerCounts(task.workMarkerCounts);
  const hasMarkers = WORK_MARKER_KEYS.some((key) => counts[key] > 0);

  const selectPreset = async (key: WorkMarkerKey) => {
    if (!workspaceId || isPending || saveLock.current) return;

    const nextCounts = toggleWorkMarkerPreset(counts, key);
    saveLock.current = true;
    try {
      await saveMarkers(nextCounts);
      setOpen(false);
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger === "icon" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-11 shrink-0 p-0 text-muted-foreground hover:text-foreground sm:size-7"
            aria-label={t("tasks:workMarkers.openForTask", {
              title: task.title,
            })}
            aria-haspopup="dialog"
          >
            <CircleDot className="size-3.5" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 shrink-0 gap-1.5 px-2 text-xs font-medium sm:min-h-7"
            aria-label={t("tasks:workMarkers.title")}
            aria-haspopup="dialog"
          >
            <span>{t("tasks:workMarkers.title")}</span>
            {hasMarkers && <WorkMarkerCountList counts={counts} />}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-1"
        aria-label={t("tasks:workMarkers.title")}
      >
        <div
          role="group"
          aria-label={t("tasks:workMarkers.title")}
          className="flex flex-col gap-0.5"
        >
          {WORK_MARKER_KEYS.map((key) => {
            const markerName = t(`tasks:workMarkers.${key}`);
            const isActive = counts[key] > 0;
            return (
              <Button
                key={key}
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 w-full justify-start gap-2 px-2 text-left sm:min-h-9"
                aria-pressed={isActive}
                aria-label={t("tasks:workMarkers.countAria", {
                  name: markerName,
                  count: 3,
                })}
                aria-disabled={!workspaceId || isPending}
                onClick={() => void selectPreset(key)}
              >
                <span className="inline-flex shrink-0 items-center gap-0.5 text-base" aria-hidden="true">
                  {WORK_MARKER_GLYPHS[key].repeat(3)}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {markerName}
                </span>
                {isActive && <Check className="size-4 shrink-0" aria-hidden="true" />}
              </Button>
            );
          })}
        </div>
        {isPending && (
          <span role="status" aria-live="polite" className="sr-only">
            {t("tasks:workMarkers.saving")}
          </span>
        )}
      </PopoverContent>
    </Popover>
  );
}
