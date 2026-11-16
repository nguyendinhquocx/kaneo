import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMarkerCounts } from "@/types/task";

const { put } = vi.hoisted(() => ({ put: vi.fn() }));

vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      "work-markers": {
        ":id": { $put: put },
      },
    },
  },
}));

import updateWorkMarkers from "./update-work-markers";

const counts: TaskMarkerCounts = {
  redCross: 0,
  boxedRedCross: 0,
  redCircle: 0,
  greenCheck: 3,
};

describe("updateWorkMarkers error messages", () => {
  beforeEach(() => put.mockReset());

  it("shows the server conflict message instead of the raw JSON envelope", async () => {
    put.mockResolvedValue({
      ok: false,
      text: async () =>
        JSON.stringify({
          message: "Card content changed; reload and retry the update",
          currentContentRevision: 8,
        }),
    });

    await expect(updateWorkMarkers("task-1", counts, 7)).rejects.toThrow(
      "Card content changed; reload and retry the update",
    );
  });

  it("returns the marker map when the server accepts the write", async () => {
    put.mockResolvedValue({
      ok: true,
      json: async () => ({ workMarkerCounts: counts, contentRevision: 9 }),
    });

    await expect(updateWorkMarkers("task-1", counts, 8)).resolves.toEqual(
      counts,
    );
    expect(put).toHaveBeenCalledWith({
      param: { id: "task-1" },
      json: { workMarkerCounts: counts, expectedContentRevision: 8 },
    });
  });
});
