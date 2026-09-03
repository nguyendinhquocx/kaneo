// SPEC-kaneo-wavefix-v0-2 (T0): central run state transition table.
//
// Single source of truth for which run state may follow which. Enforcement
// is fail-closed: an unlisted transition throws before any DB write. The
// map documents the lifecycle that dispatch, worker reports, supervision,
// resume/adopt and parent review already imply piecemeal across the code
// base — new code must consult this table instead of inventing ad-hoc
// state checks.
//
// Rules baked into the map:
//  - `finalized`, `rejected`, `failed`, `cancelled`, `superseded` are
//    terminal. A follow-up execution creates a NEW run attempt linked by
//    `parentRunId`; history is never rewritten.
//  - `orphaned` may return to `in_progress` only through the bounded
//    adopt/resume path that issues a NEW lease epoch (fencing the old one).
//  - `in_review` is worker-terminal but parent-owned: only the review gate
//    may move it to `finalized`/`rejected`.
//  - Self-transitions (same state) are allowed so idempotent re-reports of
//    the current state do not fail; they still require a valid lease.

import type { TaskRunState } from "./validation";

const BLOCKED_STATES = [
  "blocked_quota",
  "blocked_input",
  "blocked_clarification",
  "blocked_branch_drift",
] as const satisfies TaskRunState[];

const ACTIVE_WORKFLOW_STATES = ["in_progress", "checkpointed"] as const satisfies TaskRunState[];

function buildRunTransitions(): Record<TaskRunState, TaskRunState[]> {
  const map = {} as Record<TaskRunState, TaskRunState[]>;
  for (const state of [
    "created",
    "leased",
    ...ACTIVE_WORKFLOW_STATES,
    "in_review",
    "finalized",
    "rejected",
    ...BLOCKED_STATES,
    "orphaned",
    "failed",
    "cancelled",
    "superseded",
  ] as TaskRunState[]) {
    map[state] = [];
  }

  const allow = (from: TaskRunState, ...to: TaskRunState[]) => {
    map[from] = [...new Set([...map[from], ...to])];
  };

  // Spawn lifecycle: a fresh run is created, leased, then goes live.
  allow("created", "leased", "in_progress", "orphaned", "failed", "cancelled", "superseded");
  allow("leased", "in_progress", "orphaned", "failed", "cancelled", "superseded");

  // Active work: progress states may report completion, block, fail, or be
  // reclaimed. Self-transitions handled below.
  for (const active of ACTIVE_WORKFLOW_STATES) {
    allow(
      active,
      ...ACTIVE_WORKFLOW_STATES,
      "in_review",
      ...BLOCKED_STATES,
      "failed",
      "orphaned",
      "cancelled",
      "superseded",
    );
  }

  // Blocked states are recoverable: resume/adopt re-enters active work.
  for (const blocked of BLOCKED_STATES) {
    allow(blocked, ...ACTIVE_WORKFLOW_STATES, "orphaned", "failed", "cancelled", "superseded");
  }

  // Worker-terminal: only the parent review gate may finish the run.
  allow("in_review", "finalized", "rejected", "cancelled", "superseded");

  // Orphaned runs are recoverable through a bounded, fenced adopt/resume.
  allow("orphaned", ...ACTIVE_WORKFLOW_STATES, "cancelled", "superseded");

  // Terminal states have no outgoing transitions. Attempts create new runs.
  for (const terminal of ["finalized", "rejected", "failed", "cancelled", "superseded"] as TaskRunState[]) {
    map[terminal] = [];
  }

  return map;
}

export const RUN_TRANSITIONS: Readonly<Record<TaskRunState, readonly TaskRunState[]>> =
  buildRunTransitions();

/** Idempotent self-reports are allowed for active workflow states. */
export function isRunTransitionAllowed(
  current: TaskRunState,
  next: TaskRunState,
): boolean {
  if (current === next && ACTIVE_WORKFLOW_STATES.includes(next as (typeof ACTIVE_WORKFLOW_STATES)[number])) {
    return true;
  }
  return RUN_TRANSITIONS[current]?.includes(next) ?? false;
}

export function assertRunTransition(current: TaskRunState, next: TaskRunState): void {
  if (isRunTransitionAllowed(current, next)) return;
  throw transitionsRejectedError(current, next);
}

function transitionsRejectedError(current: TaskRunState, next: TaskRunState): Error {
  const error = new Error(
    `run_transition_rejected: ${current} -> ${next} is not an allowed transition`,
  );
  (error as Error & { status?: number }).status = 409;
  return error;
}
