import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";

const ASSET_PATH = /^\/(?:api\/)?asset\/([A-Za-z0-9_-]+)$/;

export function getPastedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  const add = (file: File | null | undefined) => {
    if (!file || file.size === 0) return;
    files.push(file);
  };

  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file?.type.startsWith("image/")) {
      const extension =
        file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      add(
        new File([file], file.name || `pasted-image.${extension}`, {
          type: file.type,
          lastModified: file.lastModified,
        }),
      );
    } else {
      add(file);
    }
  }
  // Some browsers expose the same clipboard payload through both `items`
  // and `files`; use the latter only as a fallback so duplicate metadata does
  // not collapse two intentionally selected identical files.
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) add(file);
  }
  return files;
}

export function sanitizePastedHtml(html: string, apiBaseUrl: string): string {
  if (!html || typeof DOMParser === "undefined") return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const apiBase = new URL(apiBaseUrl, window.location.href);

  for (const image of Array.from(parsed.body.querySelectorAll("img"))) {
    const src = image.getAttribute("src") ?? "";
    let assetId: string | null = null;
    try {
      const url = new URL(src, apiBase);
      const match = url.pathname.match(ASSET_PATH);
      if (url.origin === apiBase.origin && match) assetId = match[1];
    } catch {
      // Invalid or non-URL image sources are incidental paste content.
    }
    if (!assetId) {
      image.remove();
      continue;
    }
    const apiPrefix = `${apiBase.origin}${apiBase.pathname.replace(/\/+$/, "")}`;
    image.setAttribute("src", `${apiPrefix}/asset/${assetId}`);
    image.removeAttribute("srcset");
    image.removeAttribute("data-src");
  }

  return parsed.body.innerHTML;
}

export function createMappedSelection(
  editor: Editor,
  range?: { from: number; to: number },
) {
  let bookmark = range
    ? TextSelection.create(editor.state.doc, range.from, range.to).getBookmark()
    : editor.state.selection.getBookmark();
  const onTransaction = ({
    transaction,
  }: {
    transaction: { mapping: Mappable };
  }) => {
    bookmark = bookmark.map(transaction.mapping);
  };
  editor.on("transaction", onTransaction);

  return {
    selection() {
      return bookmark.resolve(editor.state.doc);
    },
    dispose() {
      editor.off("transaction", onTransaction);
    },
  };
}

export async function uploadFilesAtSelection<T>(input: {
  editor: Editor;
  files: File[];
  range?: { from: number; to: number };
  upload: (file: File) => Promise<T>;
  insert: (asset: T, range: { from: number; to: number }) => void;
  onError: (error: unknown) => void;
  mappedSelection?: ReturnType<typeof createMappedSelection>;
}) {
  let mappedSelection =
    input.mappedSelection ?? createMappedSelection(input.editor, input.range);
  try {
    for (const file of input.files) {
      try {
        const asset = await input.upload(file);
        const selection = mappedSelection.selection();
        mappedSelection.dispose();
        input.insert(asset, { from: selection.from, to: selection.to });
        mappedSelection = createMappedSelection(input.editor);
      } catch (error) {
        input.onError(error);
      }
    }
  } finally {
    mappedSelection.dispose();
  }
}
