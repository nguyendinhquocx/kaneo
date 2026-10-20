import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptShareToken,
  encryptShareToken,
  generateShareToken,
  hashShareToken,
  shareLinkTokenAad,
} from "../../apps/api/src/share/token";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("share token encryption", () => {
  it("round-trips a token without persisting plaintext", () => {
    vi.stubEnv(
      "SHARE_TOKEN_ENCRYPTION_KEY",
      Buffer.alloc(32, 17).toString("base64url"),
    );
    const token = generateShareToken();
    const associatedData = shareLinkTokenAad({
      id: "share-1",
      resourceType: "document",
      resourceId: "document-1",
      permission: "view",
    });
    const ciphertext = encryptShareToken(token, associatedData);

    expect(ciphertext).not.toContain(token);
    expect(ciphertext).not.toContain(hashShareToken(token));
    expect(
      decryptShareToken(ciphertext, hashShareToken(token), associatedData),
    ).toBe(token);
  });

  it("rejects modified ciphertext and a mismatched lookup hash", () => {
    vi.stubEnv(
      "SHARE_TOKEN_ENCRYPTION_KEY",
      Buffer.alloc(32, 23).toString("base64url"),
    );
    const token = generateShareToken();
    const associatedData = shareLinkTokenAad({
      id: "share-2",
      resourceType: "activity_comment",
      resourceId: "comment-1",
      permission: "view",
    });
    const ciphertext = encryptShareToken(token, associatedData);
    const parts = ciphertext.split(".");
    const encodedCiphertext = parts[3] ?? "";
    parts[3] = `${encodedCiphertext.startsWith("A") ? "B" : "A"}${encodedCiphertext.slice(1)}`;

    expect(() =>
      decryptShareToken(parts.join("."), hashShareToken(token), associatedData),
    ).toThrow();
    expect(() =>
      decryptShareToken(
        ciphertext,
        hashShareToken("other-token"),
        associatedData,
      ),
    ).toThrow("Stored share token does not match its lookup hash.");
    expect(() =>
      decryptShareToken(
        ciphertext,
        hashShareToken(token),
        shareLinkTokenAad({
          id: "other-share",
          resourceType: "activity_comment",
          resourceId: "comment-1",
          permission: "view",
        }),
      ),
    ).toThrow();
  });

  it("fails closed when the encryption key is absent or malformed", () => {
    vi.stubEnv("SHARE_TOKEN_ENCRYPTION_KEY", "");
    expect(() => encryptShareToken(generateShareToken())).toThrow(
      "SHARE_TOKEN_ENCRYPTION_KEY is not configured.",
    );

    vi.stubEnv("SHARE_TOKEN_ENCRYPTION_KEY", "too-short");
    expect(() => encryptShareToken(generateShareToken())).toThrow(
      "SHARE_TOKEN_ENCRYPTION_KEY must be a 32-byte base64url value.",
    );
  });
});
