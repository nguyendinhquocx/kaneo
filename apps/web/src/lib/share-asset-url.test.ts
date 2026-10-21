import { describe, expect, it } from "vitest";
import {
  restoreShareAssetUrls,
  rewriteShareAssetUrl,
  rewriteShareAssetUrls,
} from "./share-asset-url";

describe("share asset URLs", () => {
  const apiBase = "https://kaneo.example/api";

  it("rewrites same-origin private asset URLs through the share capability", () => {
    expect(
      rewriteShareAssetUrl(
        "https://kaneo.example/api/asset/file_123-abc",
        apiBase,
        "task_description",
        "share-token",
      ),
    ).toBe(
      "https://kaneo.example/api/share/task_description/share-token/asset/file_123-abc",
    );
  });

  it("leaves external and unrelated URLs unchanged", () => {
    expect(
      rewriteShareAssetUrl(
        "https://cdn.example/image.png",
        apiBase,
        "document",
        "share-token",
      ),
    ).toBe("https://cdn.example/image.png");
    expect(
      rewriteShareAssetUrl(
        "https://kaneo.example/api/share/document/share-token",
        apiBase,
        "document",
        "share-token",
      ),
    ).toBe("https://kaneo.example/api/share/document/share-token");
  });

  it("rewrites copied task-description images in activity-comment shares", () => {
    const comment = "![copied image](/api/asset/task-image-1)";
    expect(
      rewriteShareAssetUrls(
        comment,
        apiBase,
        "activity_comment",
        "comment-token",
      ),
    ).toBe(
      "![copied image](https://kaneo.example/api/share/activity_comment/comment-token/asset/task-image-1)",
    );
  });

  it("rewrites Markdown references and restores them for document editing", () => {
    const source = "![image](/api/asset/file-1)";
    const shared = rewriteShareAssetUrls(
      source,
      apiBase,
      "document",
      "share-token",
    );

    expect(shared).toBe(
      "![image](https://kaneo.example/api/share/document/share-token/asset/file-1)",
    );
    expect(
      restoreShareAssetUrls(shared, apiBase, "document", "share-token"),
    ).toBe("![image](https://kaneo.example/api/asset/file-1)");
  });
});
