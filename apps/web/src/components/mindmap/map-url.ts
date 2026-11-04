export function buildWiseMappingEditorUrl(baseUrl: string, mapId: string) {
  // Upstream WiseMapping serves the editor at /c/maps/{id}/edit. The map ID
  // is encoded exactly once here as a single path segment; the base URL is
  // already validated by the API before it reaches the client.
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/c/maps/${encodeURIComponent(mapId)}/edit`;
}
