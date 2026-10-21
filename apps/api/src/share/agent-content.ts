// Agent-facing share content: agents fetch capability links over plain HTTP
// and cannot run the web reader's client-side asset rewriting, so raw
// responses carry absolute share-scoped asset URLs instead of the private
// /api/asset/:id references stored in the database.

// Matches only capability-owned refs: a path that STARTS with /asset/ or
// /api/asset/ (the stored form), not segments inside foreign URLs such as
// https://example.com/asset/x or /uploads/asset/y.
const ASSET_REF = /(?<![A-Za-z0-9_-])\/(?:api\/)?asset\/([A-Za-z0-9_-]+)/g;

export function rewriteContentAssetRefs(
  content: string,
  origin: string,
  resourceType: string,
  token: string,
): string {
  const safeOrigin = origin.replace(/\/+$/, "");
  return content.replace(
    ASSET_REF,
    (_match, assetId: string) =>
      `${safeOrigin}/api/share/${encodeURIComponent(resourceType)}/${encodeURIComponent(token)}/asset/${encodeURIComponent(assetId)}`,
  );
}
