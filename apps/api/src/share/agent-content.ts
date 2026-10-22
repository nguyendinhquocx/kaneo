// Agent-facing share content: agents fetch capability links over plain HTTP
// and cannot run the web reader's client-side asset rewriting, so raw
// responses carry absolute share-scoped asset URLs instead of the private
// /api/asset/:id references stored in the database.

// Matches only capability-owned refs: a path that STARTS with /asset/ or
// /api/asset/ (the stored relative form), not segments inside foreign URLs
// such as https://example.com/asset/x or /uploads/asset/y.
const ASSET_REF = /(?<![A-Za-z0-9_-])\/(?:api\/)?asset\/([A-Za-z0-9_-]+)/g;

// Absolute URL spans are inspected before the relative-refs regex so the
// same-origin stored absolute form (e.g. https://<origin>/api/asset/<id>,
// produced by some editors) is also capability-wrapped. Only an exact
// same-origin match with a full asset path is rewritten; every other
// absolute URL is kept verbatim.
const ABSOLUTE_URL = /https?:\/\/[^\s"'`<>()[\]{}\\]+/g;
const ABSOLUTE_ASSET_PATH = /^\/(?:api\/)?asset\/([A-Za-z0-9_-]+)$/;

export function rewriteContentAssetRefs(
  content: string,
  origin: string,
  resourceType: string,
  token: string,
): string {
  const safeOrigin = origin.replace(/\/+$/, "");
  const compareOrigin = safeOrigin.toLowerCase();
  const canonical = (assetId: string): string =>
    `${safeOrigin}/api/share/${encodeURIComponent(resourceType)}/${encodeURIComponent(token)}/asset/${encodeURIComponent(assetId)}`;
  const rewriteLocalRefs = (segment: string): string =>
    segment.replace(ASSET_REF, (_match, assetId: string) =>
      canonical(assetId ?? ""),
    );

  let out = "";
  let cursor = 0;
  for (const match of content.matchAll(ABSOLUTE_URL)) {
    const start = match.index ?? 0;
    if (start > cursor) out += rewriteLocalRefs(content.slice(cursor, start));
    const raw = match[0];
    out += rewriteAbsoluteUrl(raw);
    cursor = start + raw.length;
  }
  out += rewriteLocalRefs(content.slice(cursor));
  return out;

  function rewriteAbsoluteUrl(raw: string): string {
    try {
      const url = new URL(raw);
      if (url.origin.toLowerCase() !== compareOrigin) return raw;
      const match = url.pathname.match(ABSOLUTE_ASSET_PATH);
      const assetId = match?.[1];
      return assetId ? canonical(assetId) : raw;
    } catch {
      return raw;
    }
  }
}
