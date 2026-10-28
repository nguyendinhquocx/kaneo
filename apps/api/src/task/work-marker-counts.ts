// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: shared normalization for
// the four fixed work marker counters. API responses always expose a complete
// map so clients never need to handle partial/legacy payloads.
import {
  type TaskMarkerCounts,
  ZERO_TASK_MARKER_COUNTS,
} from "../database/schema";

const MARKER_KEYS = [
  "redCross",
  "boxedRedCross",
  "redCircle",
  "greenCheck",
] as const satisfies readonly (keyof TaskMarkerCounts)[];

function normalizeMarkerCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 99)
    : 0;
}

export function normalizeWorkMarkerCounts(value: unknown): TaskMarkerCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...ZERO_TASK_MARKER_COUNTS };
  }

  const raw = value as Record<string, unknown>;
  const normalized = { ...ZERO_TASK_MARKER_COUNTS };
  for (const key of MARKER_KEYS) {
    normalized[key] = normalizeMarkerCount(raw[key]);
  }
  return normalized;
}

export function isTaskMarkerCountsShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  return MARKER_KEYS.every(
    (key) =>
      typeof raw[key] === "number" &&
      Number.isInteger(raw[key]) &&
      raw[key] >= 0 &&
      raw[key] <= 99,
  );
}
