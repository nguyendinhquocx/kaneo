import { useTranslation } from "react-i18next";
import {
  formatWorkMarkerCount,
  WORK_MARKER_GLYPHS,
  WORK_MARKER_KEYS,
} from "@/lib/work-markers";
import { cn } from "@/lib/cn";
import type { TaskMarkerCounts } from "@/types/task";

// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: renders the marker
// cluster next to task titles. Glyphs are presentational; the accessible
// name carries the marker name and count and never implies a status.
export function WorkMarkerCountList({
  counts,
  className,
}: {
  counts: TaskMarkerCounts;
  className?: string;
}) {
  const { t } = useTranslation();

  const entries = WORK_MARKER_KEYS.map((key) => ({
    key,
    count: counts[key] ?? 0,
  })).filter((entry) => entry.count > 0);

  if (entries.length === 0) {
    return null;
  }

  const accessibleName = entries
    .map((entry) =>
      t("tasks:workMarkers.countAria", {
        name: t(`tasks:workMarkers.${entry.key}`),
        count: entry.count,
      }),
    )
    .join(", ");

  return (
    <span
      role="img"
      aria-label={accessibleName}
      className={cn(
        "inline max-w-full min-w-0 shrink items-center gap-0.5 overflow-hidden whitespace-nowrap align-middle text-xs leading-none",
        className,
      )}
    >
      {entries.map((entry) => {
        const formatted = formatWorkMarkerCount(entry.count);
        return (
          <span
            key={entry.key}
            className="inline-flex items-center gap-0.5"
            aria-hidden="true"
          >
            {Array.from({ length: formatted.repeat }, (_, index) => (
              <span key={index}>{WORK_MARKER_GLYPHS[entry.key]}</span>
            ))}
            {formatted.compactLabel && (
              <span className="text-[10px] font-medium text-muted-foreground">
                {formatted.compactLabel}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

export default WorkMarkerCountList;
