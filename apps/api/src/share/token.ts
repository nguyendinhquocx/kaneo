import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// SPEC-2026-10-08-kaneo-workspace-collaboration: capability tokens carry at
// least 256 bits of entropy. Only the SHA-256 hash is ever persisted; the raw
// token exists in the create-response body once and must never be logged.
export const SHARE_TOKEN_BYTES = 32;

export function generateShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Constant-time comparison for caller-supplied tokens against stored hashes.
export function shareTokenHashMatches(token: string, expectedHash: string) {
  const actual = hashShareToken(token);
  const expected = Buffer.from(expectedHash, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (expected.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expected);
}

// Cheap shape check before a DB lookup: 32 bytes => 43 base64url chars.
export function isPlausibleShareToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
