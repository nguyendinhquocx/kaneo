import type { TaskMarkerCounts } from "@/types/task";

// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: the four fixed work
// marker cues. Order is part of the display contract — never sort or
// re-derive it from data.
export const WORK_MARKER_KEYS = [
  "redCross",
  "boxedRedCross",
  "redCircle",
  "greenCheck",
] as const satisfies readonly (keyof TaskMarkerCounts)[];

export type WorkMarkerKey = (typeof WORK_MARKER_KEYS)[number];

export const WORK_MARKER_GLYPHS: Record<WorkMarkerKey, string> = {
  redCross: "❌",
  boxedRedCross: "❎",
  redCircle: "⭕",
  greenCheck: "✅",
};

export const WORK_MARKER_MAX_COUNT = 99;

export const ZERO_WORK_MARKER_COUNTS: TaskMarkerCounts = {
  redCross: 0,
  boxedRedCross: 0,
  redCircle: 0,
  greenCheck: 0,
};

export function normalizeWorkMarkerCounts(value: unknown): TaskMarkerCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...ZERO_WORK_MARKER_COUNTS };
  }
  const raw = value as Record<string, unknown>;
  const normalized = { ...ZERO_WORK_MARKER_COUNTS };
  for (const key of WORK_MARKER_KEYS) {
    const count = raw[key];
    normalized[key] =
      typeof count === "number" && Number.isInteger(count) && count > 0
        ? Math.min(count, WORK_MARKER_MAX_COUNT)
        : 0;
  }
  return normalized;
}

export type FormattedWorkMarkerCount = {
  /** How many glyphs to render side by side. */
  repeat: number;
  /** Non-null when count >= 4 renders as `glyph×N` instead of repeats. */
  compactLabel: string | null;
};

// Counts 1–3 render as repeated glyphs; 4–99 collapse to one glyph + ×N so
// long marker clusters never push cards sideways.
export function formatWorkMarkerCount(
  count: number,
): FormattedWorkMarkerCount {
  const safeCount =
    Number.isInteger(count) && count > 0
      ? Math.min(count, WORK_MARKER_MAX_COUNT)
      : 0;
  if (safeCount === 0) {
    return { repeat: 0, compactLabel: null };
  }
  if (safeCount <= 3) {
    return { repeat: safeCount, compactLabel: null };
  }
  return { repeat: 1, compactLabel: `×${safeCount}` };
}
