// SPEC-kaneo-wavefix-v0-2 (T0): centralized run transition table tests.
// Pure functions only — DB-backed enforcement lives in the integration suite.
import { describe, expect, it } from "vitest";
import {
  assertRunTransition,
  isRunTransitionAllowed,
  RUN_TRANSITIONS,
} from "../../../apps/api/src/execution/transitions";
import {
  FULLY_TERMINAL_RUN_STATES,
  TASK_RUN_STATES,
  WORKER_REPORTABLE_STATES,
} from "../../../apps/api/src/execution/validation";

describe("RUN_TRANSITIONS coverage", () => {
  it("covers every canonical run state", () => {
    for (const state of TASK_RUN_STATES) {
      expect(Array.isArray(RUN_TRANSITIONS[state])).toBe(true);
    }
  });

  it("keeps fully terminal states with no outgoing transitions", () => {
    // NOTE: FULLY_TERMINAL_RUN_STATES also lists blocked_* because a blocked
    // run cannot be re-dispatched, but its LIFECYCLE still allows a fenced
    // resume into active work (T5). Lifecycle-terminal states here are the
    // ones history never leaves: finalized, rejected, failed, cancelled,
    // superseded.
    for (const terminal of ["finalized", "rejected", "failed", "cancelled", "superseded"] as const) {
      expect(RUN_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it("never allows finalized/rejected/failed to be rewritten by a report", () => {
    for (const terminal of ["finalized", "rejected", "failed"] as const) {
      for (const next of TASK_RUN_STATES) {
        expect(isRunTransitionAllowed(terminal, next)).toBe(false);
      }
    }
  });

  it("lets active workflow states reach worker-reportable outcomes", () => {
    for (const active of ["in_progress", "checkpointed"] as const) {
      expect(isRunTransitionAllowed(active, "in_review")).toBe(true);
      for (const blocked of ["blocked_quota", "blocked_input", "blocked_clarification", "blocked_branch_drift"] as const) {
        expect(isRunTransitionAllowed(active, blocked)).toBe(true);
      }
      expect(isRunTransitionAllowed(active, "failed")).toBe(true);
      expect(isRunTransitionAllowed(active, "orphaned")).toBe(true);
    }
  });

  it("lets blocked states recover into active work or be reclaimed", () => {
    for (const blocked of ["blocked_quota", "blocked_input", "blocked_clarification", "blocked_branch_drift"] as const) {
      expect(isRunTransitionAllowed(blocked, "in_progress")).toBe(true);
      expect(isRunTransitionAllowed(blocked, "orphaned")).toBe(true);
      // Only the review gate may finalize.
      expect(isRunTransitionAllowed(blocked, "finalized")).toBe(false);
    }
  });

  it("lets in_review reach only the parent-owned outcomes", () => {
    expect(isRunTransitionAllowed("in_review", "finalized")).toBe(true);
    expect(isRunTransitionAllowed("in_review", "rejected")).toBe(true);
    expect(isRunTransitionAllowed("in_review", "in_progress")).toBe(false);
    expect(isRunTransitionAllowed("in_review", "checkpointed")).toBe(false);
  });

  it("lets orphaned runs be adopted back into active work (fenced)", () => {
    expect(isRunTransitionAllowed("orphaned", "in_progress")).toBe(true);
    expect(isRunTransitionAllowed("orphaned", "checkpointed")).toBe(true);
    expect(isRunTransitionAllowed("orphaned", "finalized")).toBe(false);
  });

  it("allows idempotent self-reports only for active workflow states", () => {
    expect(isRunTransitionAllowed("in_progress", "in_progress")).toBe(true);
    expect(isRunTransitionAllowed("checkpointed", "checkpointed")).toBe(true);
    expect(isRunTransitionAllowed("in_review", "in_review")).toBe(false);
    expect(isRunTransitionAllowed("finalized", "finalized")).toBe(false);
  });

  it("rejects spawn lifecycle shortcuts", () => {
    expect(isRunTransitionAllowed("created", "finalized")).toBe(false);
    expect(isRunTransitionAllowed("created", "in_review")).toBe(false);
    expect(isRunTransitionAllowed("leased", "in_review")).toBe(false);
    expect(isRunTransitionAllowed("leased", "in_progress")).toBe(true);
  });

  it("never lets a worker report move a run into parent-only states", () => {
    // `in_review` is itself worker-reportable, but the in_review -> finalized
    // transition belongs to the parent review gate, so it is excluded here.
    const nonGateReportable = WORKER_REPORTABLE_STATES.filter(
      (state) => state !== "in_review",
    );
    for (const reportable of nonGateReportable) {
      expect(isRunTransitionAllowed(reportable, "finalized")).toBe(false);
      expect(isRunTransitionAllowed(reportable, "rejected")).toBe(false);
    }
  });
});

describe("assertRunTransition", () => {
  it("returns silently for allowed transitions", () => {
    expect(() => assertRunTransition("in_progress", "in_review")).not.toThrow();
    expect(() => assertRunTransition("orphaned", "in_progress")).not.toThrow();
  });

  it("throws a descriptive error for rejected transitions", () => {
    expect(() => assertRunTransition("finalized", "in_progress")).toThrowError(
      /run_transition_rejected: finalized -> in_progress/,
    );
    expect(() => assertRunTransition("in_review", "in_progress")).toThrowError(
      /run_transition_rejected/,
    );
  });
});
