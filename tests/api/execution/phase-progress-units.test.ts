import { describe, expect, it } from "vitest";
import {
  mapFailureKindToRunState,
  phaseIdempotencyKey,
  renderPhaseMarker,
} from "../../../apps/api/src/execution/phase-progress";
import {
  validateFailureKind,
  WORKER_FAILURE_KINDS,
} from "../../../apps/api/src/execution/validation";

describe("SPEC-kaneo-phase-cards-full-run-server-v0-1: phase-progress units", () => {
  it("maps block failureKinds to canonical run states", () => {
    expect(mapFailureKindToRunState("provider_quota")).toBe("blocked_quota");
    expect(mapFailureKindToRunState("malformed_phase_map")).toBe(
      "blocked_input",
    );
    expect(mapFailureKindToRunState("worker_crash")).toBe("failed");
    expect(mapFailureKindToRunState("test_failure")).toBe("failed");
  });

  it("accepts malformed_phase_map as a canonical failureKind", () => {
    expect(validateFailureKind("malformed_phase_map")).toBe(
      "malformed_phase_map",
    );
    expect(
      (WORKER_FAILURE_KINDS as readonly string[]).includes(
        "malformed_phase_map",
      ),
    ).toBe(true);
    expect(() => validateFailureKind("totally_bogus")).toThrowError(
      /Invalid failureKind/,
    );
  });

  it("builds deterministic idempotency keys per wire contract", () => {
    expect(phaseIdempotencyKey("begin", "run-1", "P1")).toBe(
      "phase-begin:run-1:P1",
    );
    expect(phaseIdempotencyKey("complete", "run-1", "P1", "ck-9")).toBe(
      "phase-complete:run-1:P1:ck-9",
    );
    expect(phaseIdempotencyKey("block", "run-1", "P2", "provider_quota")).toBe(
      "phase-block:run-1:P2:provider_quota",
    );
    expect(phaseIdempotencyKey("begin", "run-1", "P1")).toBe(
      phaseIdempotencyKey("begin", "run-1", "P1"),
    );
  });

  it("renders 6b markers server-side from structured receipts", () => {
    expect(
      renderPhaseMarker({
        marker: "✅ DONE",
        phaseId: "P1",
        title: "Server authority",
        commitSha: "abcdef1234567890",
        checkpointId: "ck-1",
      }),
    ).toBe("[✅ DONE] P1 Server authority (abcdef123456)");
    expect(
      renderPhaseMarker({ marker: "⭕ DOING", phaseId: "P2", title: "Two" }),
    ).toBe("[⭕ DOING] P2 Two");
  });
});
