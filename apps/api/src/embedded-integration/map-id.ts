export const MAP_ID_MAX_LENGTH = 256;

export type ValidMapId = { valid: true; mapId: string };
export type InvalidMapId = { valid: false; reason: string };

/**
 * Validate an opaque WiseMapping map ID before it is stored or embedded in a
 * URL. The ID must be a single safe path segment:
 * - non-empty, at most 256 characters
 * - not "." or ".." (nor percent-encoded variants, which contain "%")
 * - no path/query/fragment separators, raw backslash, "%" or control chars
 * Percent-encoding is done exactly once by encodeMapId when building the
 * editor URL — encoded input is rejected so it can never be double-decoded
 * into a separator or dot segment downstream.
 */
export function validateMapId(raw: unknown): ValidMapId | InvalidMapId {
  if (typeof raw !== "string") {
    return { valid: false, reason: "mapId must be a string" };
  }

  if (raw.length === 0) {
    return { valid: false, reason: "mapId must not be empty" };
  }

  if (raw.length > MAP_ID_MAX_LENGTH) {
    return {
      valid: false,
      reason: `mapId must be at most ${MAP_ID_MAX_LENGTH} characters`,
    };
  }

  if (raw === "." || raw === "..") {
    return { valid: false, reason: "mapId must not be a dot segment" };
  }

  let hasControlChar = false;
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      hasControlChar = true;
      break;
    }
  }

  if (hasControlChar) {
    return {
      valid: false,
      reason: "mapId must not contain control characters",
    };
  }

  if (/[/\\?#%\s]/.test(raw)) {
    return {
      valid: false,
      reason:
        "mapId must be a single path segment without separators, percent-encoding or spaces",
    };
  }

  return { valid: true, mapId: raw };
}

/** Encode a validated map ID exactly once for use as one URL path segment. */
export function encodeMapId(mapId: string): string {
  return encodeURIComponent(mapId);
}
