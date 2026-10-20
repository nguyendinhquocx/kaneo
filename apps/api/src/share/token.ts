import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Capability tokens carry at least 256 bits of entropy. The SHA-256 hash is
// used for lookup; an AEAD ciphertext permits authorized owners to re-copy new
// links without storing the bearer token in plaintext. Never log raw tokens.
export const SHARE_TOKEN_BYTES = 32;

export function generateShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const SHARE_TOKEN_CIPHERTEXT_VERSION = "v1";
const SHARE_TOKEN_KEY_BYTES = 32;

function getShareTokenEncryptionKey(): Buffer {
  const encodedKey = process.env.SHARE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!encodedKey) {
    throw new Error("SHARE_TOKEN_ENCRYPTION_KEY is not configured.");
  }

  const key = Buffer.from(encodedKey, "base64url");
  if (
    key.length !== SHARE_TOKEN_KEY_BYTES ||
    key.toString("base64url") !== encodedKey
  ) {
    throw new Error(
      "SHARE_TOKEN_ENCRYPTION_KEY must be a 32-byte base64url value.",
    );
  }
  return key;
}

// The database keeps the lookup hash plus authenticated ciphertext. Only the
// key holder can recover a URL, and callers must separately pass the workspace
// `project:share` gate before the decrypted value is returned.
export function shareLinkTokenAad(input: {
  id: string;
  resourceType: string;
  resourceId: string;
  permission: string;
}) {
  return `share-link:v1\u0000${input.id}\u0000${input.resourceType}\u0000${input.resourceId}\u0000${input.permission}`;
}

export function encryptShareToken(
  token: string,
  associatedData: string,
): string {
  const key = getShareTokenEncryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    SHARE_TOKEN_CIPHERTEXT_VERSION,
    nonce.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptShareToken(
  storedValue: string,
  expectedHash: string,
  associatedData: string,
): string {
  const [version, encodedNonce, encodedTag, encodedCiphertext, extra] =
    storedValue.split(".");
  if (
    version !== SHARE_TOKEN_CIPHERTEXT_VERSION ||
    !encodedNonce ||
    !encodedTag ||
    !encodedCiphertext ||
    extra !== undefined
  ) {
    throw new Error("Stored share token ciphertext is invalid.");
  }

  const key = getShareTokenEncryptionKey();
  const nonce = Buffer.from(encodedNonce, "base64url");
  const tag = Buffer.from(encodedTag, "base64url");
  const ciphertext = Buffer.from(encodedCiphertext, "base64url");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Stored share token ciphertext is invalid.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(tag);
  const token = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");

  if (!shareTokenHashMatches(token, expectedHash)) {
    throw new Error("Stored share token does not match its lookup hash.");
  }
  return token;
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
