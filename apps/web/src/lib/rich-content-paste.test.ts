import { describe, expect, it } from "vitest";
import { getPastedFiles, sanitizePastedHtml } from "./rich-content-paste";

describe("rich content paste helpers", () => {
  it("collects multiple clipboard files once and gives unnamed images a filename", () => {
    const image = new File(["image"], "", {
      type: "image/png",
      lastModified: 100,
    });
    const document = new File(["pdf"], "report.pdf", {
      type: "application/pdf",
      lastModified: 200,
    });
    const data = {
      items: [
        { kind: "file", getAsFile: () => image },
        { kind: "file", getAsFile: () => document },
      ],
      files: [image, document],
    } as unknown as DataTransfer;

    const files = getPastedFiles(data);

    expect(files).toHaveLength(2);
    expect(files.map((file) => file.name)).toEqual([
      "pasted-image.png",
      "report.pdf",
    ]);
  });

  it("keeps text and links, rewrites owned images, and removes remote page images", () => {
    const html =
      '<p>Keep <a href="https://docs.example">this link</a> <img src="https://news.example/logo.png" alt="logo"></p>' +
      '<p><img src="https://kaneo.example/api/asset/file-1" srcset="https://cdn.example/file-1 2x"></p>';

    const sanitized = sanitizePastedHtml(html, "https://kaneo.example/api");
    const parsed = new DOMParser().parseFromString(sanitized, "text/html");

    expect(parsed.body.textContent).toContain("Keep this link");
    expect(parsed.body.querySelector("a")?.getAttribute("href")).toBe(
      "https://docs.example",
    );
    expect(parsed.body.querySelectorAll("img")).toHaveLength(1);
    expect(parsed.body.querySelector("img")?.getAttribute("src")).toBe(
      "https://kaneo.example/api/asset/file-1",
    );
    expect(parsed.body.querySelector("img")?.hasAttribute("srcset")).toBe(
      false,
    );
  });
});
