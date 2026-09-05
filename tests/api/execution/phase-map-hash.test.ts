import { describe, expect, it } from "vitest";
import {
  PHASE_COUNT_LIMIT,
  canonicalJsonString,
  canonicalSha256,
  computeGraphId,
  computeGraphMapHash,
  computeSourcePhaseMapHash,
  normalizeRelativePath,
  parseFullRunWorkerContract,
  validatePhaseMapInput,
} from "../../../apps/api/src/execution/validation";

const VECTOR_PHASES = [
  {
    phaseId: "P1",
    parserTaskId: "T1",
    ordinal: 1,
    required: true,
    title: "One",
    files: ["src/one.mjs"],
    verify: ["node --check src/one.mjs"],
  },
  {
    phaseId: "P2",
    parserTaskId: "T2",
    ordinal: 2,
    required: true,
    title: "Two",
    files: ["src/two.mjs"],
    verify: ["node --check src/two.mjs"],
  },
  {
    phaseId: "P3",
    parserTaskId: "T3",
    ordinal: 3,
    required: true,
    title: "Three",
    files: ["src/three.mjs"],
    verify: ["node --check src/three.mjs"],
  },
] as const;

const SOURCE_VECTOR =
  "571b8fc41098e9bd924e17e708ff0adc2b6148b8acad4ebf055201381de3b3ff";
const GRAPH_VECTOR =
  "717d7cda68bae645ec0a92959fce00874253feffa9398fb332e1a8b3e51c46cf";

describe("SPEC-kaneo-phase-cards-full-run-server-v0-1: canonical phase map", () => {
  it("reproduces the master spec source phase map vector", () => {
    const phases = validatePhaseMapInput(
      VECTOR_PHASES.map((phase) => ({ ...phase })),
    );
    expect(computeSourcePhaseMapHash(phases)).toBe(SOURCE_VECTOR);
  });

  it("reproduces the master spec graph map vector", () => {
    const phases = validatePhaseMapInput(
      VECTOR_PHASES.map((phase) => ({ ...phase })),
    );
    const withChildren = phases.map((phase, index) => ({
      ...phase,
      childTaskId: `c${index + 1}`,
    }));
    expect(computeGraphMapHash("full", withChildren)).toBe(GRAPH_VECTOR);
  });

  it("source hash is independent of declaration order and path separators", () => {
    const shuffled = validatePhaseMapInput([
      { ...VECTOR_PHASES[2], files: ["src\\three.mjs"] },
      { ...VECTOR_PHASES[0] },
      { ...VECTOR_PHASES[1] },
    ]);
    expect(computeSourcePhaseMapHash(shuffled)).toBe(SOURCE_VECTOR);
  });

  it("rejects the 31st phase with phase_count_exceeds_limit", () => {
    const tooMany = Array.from({ length: PHASE_COUNT_LIMIT + 1 }, (_, i) => ({
      phaseId: `P${i + 1}`,
      parserTaskId: `T${i + 1}`,
      ordinal: i + 1,
      required: true,
      title: `Phase ${i + 1}`,
      files: [`src/p${i + 1}.mjs`],
      verify: [`node --check src/p${i + 1}.mjs`],
    }));
    expect(() => validatePhaseMapInput(tooMany)).toThrowError(
      /phase_count_exceeds_limit/,
    );
  });

  it("rejects duplicate phase ids, ordinals, parser ids and bad paths", () => {
    const base = { ...VECTOR_PHASES[0] };
    expect(() =>
      validatePhaseMapInput([base, { ...base, ordinal: 2 }]),
    ).toThrowError(/duplicate phaseId/);
    expect(() =>
      validatePhaseMapInput([base, { ...base, phaseId: "P2" }]),
    ).toThrowError(/duplicate parserTaskId/);
    expect(() =>
      validatePhaseMapInput([base, { ...base, phaseId: "P2", parserTaskId: "T2" }]),
    ).toThrowError(/duplicate ordinal/);
    expect(() =>
      validatePhaseMapInput([{ ...base, files: ["/abs/path.mjs"] }]),
    ).toThrowError();
    expect(() =>
      validatePhaseMapInput([{ ...base, files: ["src/../secrets"] }]),
    ).toThrowError();
  });

  it("normalizes backslash paths and trims", () => {
    expect(normalizeRelativePath("  src\\lib\\util.ts ")).toBe(
      "src/lib/util.ts",
    );
    expect(() => normalizeRelativePath("src/a/../b.ts")).toThrowError();
    expect(() => normalizeRelativePath("")).toThrowError();
  });

  it("canonical JSON sorts keys by code point and compacts output", () => {
    expect(canonicalJsonString({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalSha256({ a: 1, b: 2 })).toBe(
      canonicalSha256({ b: 2, a: 1 }),
    );
  });

  it("builds a deterministic graphId from projectId + changeSet + planHash", () => {
    const base = { projectId: "p1", changeSetId: "cs-1", planHash: "hash-1" };
    expect(computeGraphId(base)).toBe(computeGraphId({ ...base }));
    expect(computeGraphId(base)).not.toBe(
      computeGraphId({ ...base, changeSetId: "cs-2" }),
    );
  });

  it("validates the legacy worker contract block", () => {
    const union = ["src/one.mjs", "src/three.mjs", "src/two.mjs"];
    const good = JSON.stringify({
      schema: 1,
      agent: "pi-prodesk",
      repo: "owner/repo",
      path: ".",
      state: "ready",
      spec_id: "SPEC-X",
      task_id: "FULL",
      files: union,
      scope: union,
      writes: union,
    });
    expect(
      parseFullRunWorkerContract(`${good}\n{}...`, {
        specId: "SPEC-X",
        sortedUnionFiles: union,
      }),
    ).toMatchObject({ task_id: "FULL" });
    expect(() =>
      parseFullRunWorkerContract(
        JSON.stringify({ ...JSON.parse(good), schema: 2 }),
        { specId: "SPEC-X", sortedUnionFiles: union },
      ),
    ).toThrowError(/schema must be 1/);
    expect(() =>
      parseFullRunWorkerContract(good, {
        specId: "SPEC-X",
        sortedUnionFiles: ["other.ts"],
      }),
    ).toThrowError(/sorted union/);
  });
});
