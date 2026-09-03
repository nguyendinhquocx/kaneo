// SPEC-kaneo-native-telegram-control-v0-1 (T1): canonical state machine and
// validation contract unit tests. Pure functions only — the DB-backed
// behavior lives in the integration suite (requires PostgreSQL).
import { describe, expect, it } from "vitest";
import {
  CONTROL_REQUEST_ACTIONS,
  FULLY_TERMINAL_RUN_STATES,
  LEGACY_TASK_RUN_STATES,
  mapLegacyRunState,
  NOTIFICATION_DELIVERY_STATES,
  NOTIFICATION_EVENT_KINDS,
  TASK_EXECUTION_STATES,
  TASK_RUN_STATES,
  validateControlAction,
  validateExecutionState,
  validateFailureKind,
  validateNotificationKind,
  validateRevision,
  validateRunState,
  validateWorkerReportState,
  WORKER_REPORTABLE_STATES,
  WORKER_TERMINAL_RUN_STATES,
} from "../../../apps/api/src/execution/validation";

describe("canonical run state vocabulary", () => {
  it("exposes the canonical states from the spec", () => {
    expect(TASK_RUN_STATES).toEqual([
      "created",
      "leased",
      "in_progress",
      "checkpointed",
      "in_review",
      "finalized",
      "rejected",
      "blocked_quota",
      "blocked_input",
      "blocked_clarification",
      "blocked_branch_drift",
      "orphaned",
      "failed",
      "cancelled",
      "superseded",
    ]);
  });

  it("classifies in_review as worker-terminal only", () => {
    expect(WORKER_TERMINAL_RUN_STATES).toEqual(["in_review"]);
    expect(FULLY_TERMINAL_RUN_STATES).not.toContain("in_review");
    expect(FULLY_TERMINAL_RUN_STATES).toContain("finalized");
    expect(FULLY_TERMINAL_RUN_STATES).toContain("rejected");
    expect(FULLY_TERMINAL_RUN_STATES).toContain("orphaned");
  });

  it("rejects legacy state names on new writes", () => {
    for (const legacy of LEGACY_TASK_RUN_STATES) {
      expect(() => validateRunState(legacy)).toThrow();
    }
  });

  it("maps legacy states for reads/migration with manual follow-up", () => {
    expect(mapLegacyRunState("running")).toEqual({
      state: "in_progress",
      manualFollowUpRequired: false,
    });
    expect(mapLegacyRunState("stale")).toEqual({
      state: "orphaned",
      manualFollowUpRequired: false,
    });
    expect(mapLegacyRunState("blocked")).toEqual({
      state: "failed",
      manualFollowUpRequired: true,
    });
    expect(mapLegacyRunState("done")).toEqual({
      state: "in_review",
      manualFollowUpRequired: true,
    });
    expect(mapLegacyRunState("finalized")).toEqual({
      state: "finalized",
      manualFollowUpRequired: false,
    });
    expect(mapLegacyRunState("nonsense")).toBeNull();
  });

  it("restricts worker reports to canonical reportable states", () => {
    expect(WORKER_REPORTABLE_STATES).not.toContain("checkpointed");
    expect(WORKER_REPORTABLE_STATES).not.toContain("blocked");
    expect(validateWorkerReportState("blocked_quota")).toBe("blocked_quota");
    expect(validateWorkerReportState("failed")).toBe("failed");
    expect(() => validateWorkerReportState("blocked")).toThrow(/generic/i);
    expect(() => validateWorkerReportState("finalized")).toThrow();
  });
});

describe("revision and enum validators", () => {
  it("validates monotonic revision inputs", () => {
    expect(validateRevision(1)).toBe(1);
    expect(validateRevision(undefined)).toBeUndefined();
    expect(() => validateRevision(0)).toThrow();
    expect(() => validateRevision(1.5)).toThrow();
    expect(() => validateRevision(-2)).toThrow();
    expect(() => validateRevision("3")).toThrow();
  });

  it("validates the telegram control actions", () => {
    expect(CONTROL_REQUEST_ACTIONS).toEqual([
      "read_status",
      "notification_ack",
      "create_dispatch_request",
      "answer_clarification",
      "continue_quota",
      // SPEC-kaneo-wavefix-v0-2 (T10): plain replies/comments steer the
      // live worker; scope/contract overrides are rejected at creation.
      "steer_message",
    ]);
    expect(validateControlAction("continue_quota")).toBe("continue_quota");
    expect(validateControlAction("steer_message")).toBe("steer_message");
    expect(() => validateControlAction("merge")).toThrow();
  });

  it("validates notification kinds and delivery states vocabulary", () => {
    expect(validateNotificationKind("checkpoint")).toBe("checkpoint");
    expect(validateNotificationKind("started")).toBe("started");
    expect(() => validateNotificationKind("heartbeat")).toThrow();
    expect(NOTIFICATION_DELIVERY_STATES).toContain("send_unknown");
    expect(NOTIFICATION_DELIVERY_STATES).toContain("dead_letter");
    expect(NOTIFICATION_EVENT_KINDS).toContain("needs_input");
  });

  it("validates execution state and failure kinds", () => {
    expect(validateExecutionState("ready")).toBe("ready");
    expect(TASK_EXECUTION_STATES).toContain("blocked");
    expect(() => validateExecutionState("to-do")).toThrow();
    expect(validateFailureKind("provider_quota")).toBe("provider_quota");
    expect(validateFailureKind(undefined)).toBeUndefined();
    expect(() => validateFailureKind("quota")).toThrow();
  });
});
