const ASSET_PATH = /^\/(?:api\/)?asset\/([A-Za-z0-9_-]+)$/;

export function rewriteShareAssetUrl(
  value: string,
  apiBaseUrl: string,
  resourceType: string,
  token: string,
): string {
  try {
    const apiBase = new URL(apiBaseUrl);
    const url = new URL(value, apiBase);
    const match = url.pathname.match(ASSET_PATH);
    if (url.origin !== apiBase.origin || !match) return value;
    const apiPrefix = `${apiBase.origin}${apiBase.pathname.replace(/\/+$/, "")}`;
    return `${apiPrefix}/share/${encodeURIComponent(resourceType)}/${encodeURIComponent(token)}/asset/${encodeURIComponent(match[1])}`;
  } catch {
    return value;
  }
}

export function rewriteShareAssetUrls(
  content: string,
  apiBaseUrl: string,
  resourceType: string,
  token: string,
): string {
  return content.replace(
    /https?:\/\/[^\s"'<>)]*|\/(?:api\/)?asset\/[A-Za-z0-9_-]+/g,
    (url) => rewriteShareAssetUrl(url, apiBaseUrl, resourceType, token),
  );
}

export function restoreShareAssetUrls(
  content: string,
  apiBaseUrl: string,
  resourceType: string,
  token: string,
): string {
  const apiBase = new URL(apiBaseUrl);
  const apiPrefix = `${apiBase.origin}${apiBase.pathname.replace(/\/+$/, "")}`;
  const tokenPrefix = `${apiPrefix}/share/${encodeURIComponent(resourceType)}/${encodeURIComponent(token)}/asset/`;
  return content.split(tokenPrefix).join(`${apiPrefix}/asset/`);
}
