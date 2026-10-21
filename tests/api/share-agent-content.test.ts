import { describe, expect, it } from "vitest";
import { rewriteContentAssetRefs } from "../../apps/api/src/share/agent-content";

describe("rewriteContentAssetRefs", () => {
  it("rewrites private asset refs to absolute share-scoped URLs", () => {
    const result = rewriteContentAssetRefs(
      "![shot](/api/asset/abc123) and [file](/asset/xY_-9)",
      "https://kaneo.quoc.app",
      "task_description",
      "tok.en_1",
    );
    expect(result).toBe(
      "![shot](https://kaneo.quoc.app/api/share/task_description/tok.en_1/asset/abc123) and [file](https://kaneo.quoc.app/api/share/task_description/tok.en_1/asset/xY_-9)",
    );
  });

  it("is idempotent for already share-scoped refs", () => {
    const once = rewriteContentAssetRefs(
      "![shot](/api/asset/abc123)",
      "https://kaneo.quoc.app",
      "task_description",
      "tok",
    );
    const twice = rewriteContentAssetRefs(
      once,
      "https://kaneo.quoc.app",
      "task_description",
      "tok",
    );
    expect(twice).toBe(once);
  });

  it("leaves unrelated paths alone", () => {
    const result = rewriteContentAssetRefs(
      "See https://example.com/asset/zzz and /uploads/asset/keep",
      "https://kaneo.quoc.app",
      "activity_comment",
      "tok",
    );
    // Absolute foreign URLs and non-API paths are not capability-wrapped;
    // only relative /asset/ and /api/asset/ refs belong to this capability.
    expect(result).toContain("https://example.com/asset/zzz");
    expect(result).toContain("/uploads/asset/keep");
  });
});
