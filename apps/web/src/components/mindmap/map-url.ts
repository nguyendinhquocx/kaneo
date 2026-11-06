const MAP_ID_MAX_LENGTH = 256;

export function buildWiseMappingEditorUrl(baseUrl: string, mapId: string) {
  // Upstream WiseMapping serves the editor at /c/maps/{id}/edit. The map ID
  // is encoded exactly once here as a single path segment; the base URL is
  // already validated by the API before it reaches the client.
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/c/maps/${encodeURIComponent(mapId)}/edit`;
}

/**
 * Resolve a raw map ID or an editor URL for the configured WiseMapping
 * instance. URL input is accepted only for the exact editor route on the
 * configured origin and base path; the returned value is always the raw ID.
 */
export function parseWiseMappingMapId(
  input: string,
  baseUrl: string,
): string | null {
  const value = input.trim();
  if (!value) return null;

  if (!/^https?:\/\//i.test(value)) {
    return isValidMapId(value) ? value : null;
  }

  let base: URL;
  let editorUrl: URL;
  try {
    base = new URL(baseUrl);
    editorUrl = new URL(value);
  } catch {
    return null;
  }

  if (
    editorUrl.origin !== base.origin ||
    editorUrl.username ||
    editorUrl.password ||
    editorUrl.search ||
    editorUrl.hash
  ) {
    return null;
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  const routePrefix = `${basePath}/c/maps/`;
  if (!editorUrl.pathname.startsWith(routePrefix)) return null;

  const routeSuffix = editorUrl.pathname.slice(routePrefix.length);
  const match = /^([^/]+)\/edit$/.exec(routeSuffix);
  if (!match) return null;

  let mapId: string;
  try {
    mapId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  return isValidMapId(mapId) ? mapId : null;
}

function isValidMapId(mapId: string): boolean {
  if (
    mapId.length === 0 ||
    mapId.length > MAP_ID_MAX_LENGTH ||
    mapId === "." ||
    mapId === ".." ||
    /[/\\?#%\s]/.test(mapId)
  ) {
    return false;
  }

  for (const char of mapId) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
  }

  return true;
}
