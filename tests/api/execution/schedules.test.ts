import { describe, expect, it } from "vitest";
import {
  assertScheduleShape,
  isScheduleDue,
  occurrenceKey,
  SCHEDULE_FALLBACK_MODES,
  SCHEDULE_MAX_RUNTIME_BOUNDS,
  SCHEDULE_OCCURRENCE_STATES,
  validateSchedulePolicy,
} from "../../../apps/api/src/execution/validation";

describe("execution schedule occurrence fencing (T6)", () => {
  it("derives a canonical occurrence key from scheduleId + scheduledFor", () => {
    const when = new Date("2026-08-25T02:00:00.000Z");
    expect(occurrenceKey("sched-1", when)).toBe(
      "sched-1:2026-08-25T02:00:00.000Z",
    );
    // Same instant via a different Date object must produce the same key:
    // this is what makes dispatcher retries exactly-once.
    expect(occurrenceKey("sched-1", new Date(when.getTime()))).toBe(
      occurrenceKey("sched-1", when),
    );
    expect(occurrenceKey("sched-2", when)).not.toBe(
      occurrenceKey("sched-1", when),
    );
  });

  it("rejects cron schedules fail-closed in v1", () => {
    const notBefore = new Date("2026-08-25T02:00:00.000Z");
    expect(() =>
      assertScheduleShape({ notBefore, cronExpr: "0 2 * * *" }),
    ).toThrow(/cron schedules are not supported/);
    expect(() => assertScheduleShape({ notBefore })).not.toThrow();
    expect(() =>
      assertScheduleShape({ notBefore: new Date("invalid") }),
    ).toThrow(/notBefore must be a valid date/);
  });

  it("validates schedule policy bounds and fallback rules", () => {
    const base = {
      host: "prodesk-home",
      maxRuntimeSeconds: 3600,
      fallbackMode: "manual",
      fallbackModels: [],
      concurrencyKey: "prodesk-home",
    };
    expect(validateSchedulePolicy(base)).toEqual(base);

    expect(() =>
      validateSchedulePolicy({ ...base, maxRuntimeSeconds: 10 }),
    ).toThrow(/maxRuntimeSeconds/);
    expect(() =>
      validateSchedulePolicy({
        ...base,
        maxRuntimeSeconds: SCHEDULE_MAX_RUNTIME_BOUNDS.max + 1,
      }),
    ).toThrow(/maxRuntimeSeconds/);
    expect(() =>
      validateSchedulePolicy({ ...base, host: "bad host!" }),
    ).toThrow(/invalid host binding/);
    expect(() =>
      validateSchedulePolicy({ ...base, fallbackMode: "auto" }),
    ).toThrow(/fallbackMode/);
    // preapproved without a fallback list is meaningless — reject.
    expect(() =>
      validateSchedulePolicy({ ...base, fallbackMode: "preapproved" }),
    ).toThrow(/preapproved fallbackMode requires/);
    expect(
      validateSchedulePolicy({
        ...base,
        fallbackMode: "preapproved",
        fallbackModels: ["openai-codex/gpt-5.6-luna"],
      }).fallbackMode,
    ).toBe("preapproved");
    // Defaults: host/concurrencyKey fall back to safe values.
    expect(validateSchedulePolicy({ maxRuntimeSeconds: 3600 }).host).toBe(
      "prodesk-home",
    );
  });

  it("computes due-ness from enabled, host filter, and notBefore", () => {
    const now = new Date("2026-08-25T02:00:00.000Z");
    const schedule = {
      enabled: true,
      notBefore: new Date("2026-08-25T01:00:00.000Z"),
      host: "prodesk-home",
    };
    expect(isScheduleDue(schedule, now)).toBe(true);
    expect(isScheduleDue(schedule, now, "prodesk-home")).toBe(true);
    expect(isScheduleDue(schedule, now, "other-host")).toBe(false);
    expect(
      isScheduleDue(
        { ...schedule, notBefore: new Date("2026-08-25T03:00:00.000Z") },
        now,
      ),
    ).toBe(false);
    expect(isScheduleDue({ ...schedule, enabled: false }, now)).toBe(false);
  });

  it("keeps contract state enumerations stable", () => {
    expect([...SCHEDULE_OCCURRENCE_STATES]).toEqual([
      "planned",
      "claimed",
      "dispatched",
      "superseded",
      "failed",
    ]);
    expect([...SCHEDULE_FALLBACK_MODES]).toEqual(["manual", "preapproved"]);
  });
});
