import { describe, expect, it } from "vitest";
import {
  formatWorkMarkerCount,
  normalizeWorkMarkerCounts,
  toggleWorkMarkerPreset,
  WORK_MARKER_GLYPHS,
  WORK_MARKER_KEYS,
} from "./work-markers";

describe("work marker count formatting", () => {
  it("renders counts 1–3 as repeated glyphs", () => {
    expect(formatWorkMarkerCount(1)).toEqual({
      repeat: 1,
      compactLabel: null,
    });
    expect(formatWorkMarkerCount(3)).toEqual({
      repeat: 3,
      compactLabel: null,
    });
  });

  it("compacts counts 4–99 to one glyph plus an ×N label", () => {
    expect(formatWorkMarkerCount(4)).toEqual({
      repeat: 1,
      compactLabel: "×4",
    });
    expect(formatWorkMarkerCount(99)).toEqual({
      repeat: 1,
      compactLabel: "×99",
    });
  });

  it("renders zero and invalid counts as nothing", () => {
    expect(formatWorkMarkerCount(0)).toEqual({ repeat: 0, compactLabel: null });
    expect(formatWorkMarkerCount(-2)).toEqual({ repeat: 0, compactLabel: null });
    expect(formatWorkMarkerCount(1.5)).toEqual({
      repeat: 0,
      compactLabel: null,
    });
  });

  it("keeps the four fixed markers in display order with distinct glyphs", () => {
    expect(WORK_MARKER_KEYS).toEqual([
      "redCross",
      "boxedRedCross",
      "redCircle",
      "greenCheck",
    ]);
    // ❌ and ❎ are different glyphs and must stay separate keys.
    expect(new Set(Object.values(WORK_MARKER_GLYPHS)).size).toBe(
      WORK_MARKER_KEYS.length,
    );
  });
});

describe("toggleWorkMarkerPreset", () => {
  it("writes exactly one triple and clears when that preset is clicked again", () => {
    const triple = toggleWorkMarkerPreset(null, "redCross");
    expect(triple).toEqual({
      redCross: 3,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    });
    expect(toggleWorkMarkerPreset(triple, "redCross")).toEqual({
      redCross: 0,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    });
  });

  it("normalizes a legacy count or multi-marker map when a preset is chosen", () => {
    expect(
      toggleWorkMarkerPreset(
        { redCross: 1, boxedRedCross: 0, redCircle: 3, greenCheck: 0 },
        "redCross",
      ),
    ).toEqual({
      redCross: 3,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    });
  });
});

describe("normalizeWorkMarkerCounts", () => {
  it("always returns all four keys clamped to 0–99", () => {
    expect(
      normalizeWorkMarkerCounts({
        redCross: 100,
        boxedRedCross: -3,
        redCircle: 7,
      }),
    ).toEqual({ redCross: 99, boxedRedCross: 0, redCircle: 7, greenCheck: 0 });
  });

  it("falls back to zero counts for malformed payloads", () => {
    expect(normalizeWorkMarkerCounts(null)).toEqual({
      redCross: 0,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    });
    expect(normalizeWorkMarkerCounts("nope")).toEqual({
      redCross: 0,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    });
    expect(normalizeWorkMarkerCounts({ redCross: "many" })).toEqual({
      redCross: 0,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    });
  });
});
