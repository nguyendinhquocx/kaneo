import type { AssetObject } from "./s3";

export const SAFE_INLINE_ASSET_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export function buildContentDisposition(filename: string, inline: boolean) {
  const normalized = filename
    .normalize("NFC")
    .replace(/[\r\n"]/g, "")
    .trim();
  const safeFilename = normalized || "file";
  const asciiFallback =
    safeFilename
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\\/]/g, "-")
      .replace(/[^\x20-\x7E]+/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "file";
  const encodedFilename = encodeURIComponent(safeFilename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;
}

export function buildAssetResponse(
  asset: { filename: string; mimeType: string },
  object: AssetObject,
  cacheControl = "private, no-store",
) {
  const contentType =
    (object.contentType || asset.mimeType)
      .toLowerCase()
      .split(";")[0]
      ?.trim() ?? "";
  const inline = SAFE_INLINE_ASSET_TYPES.has(contentType);

  return new Response(object.body as BodyInit, {
    headers: {
      "Cache-Control": cacheControl,
      "Content-Disposition": buildContentDisposition(asset.filename, inline),
      "Content-Length": object.contentLength?.toString() || "",
      "Content-Type": inline ? contentType : "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      ETag: object.etag || "",
      "Last-Modified": object.lastModified?.toUTCString() || "",
    },
  });
}
