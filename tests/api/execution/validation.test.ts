import { describe, expect, it } from "vitest";
import {
  createLeaseToken,
  getLeaseExpiry,
  hashLeaseToken,
  isLeaseExpired,
  LEASE_TTL_MS,
  stableHash,
  taskSlug,
  validateBranchName,
  validateScope,
} from "../../../apps/api/src/execution/validation";

describe("execution lease and scope validation", () => {
  it("accepts only bounded relative scopes", () => {
    expect(
      validateScope(["apps/api/src", "apps/web/src", "apps/api/src"]),
    ).toEqual(["apps/api/src", "apps/web/src"]);
    expect(() => validateScope(["../secrets"])).toThrow();
    expect(() => validateScope(["C:/secrets"])).toThrow();
    expect(() => validateScope(["*"])).toThrow();
  });

  it("rejects unsafe branch names", () => {
    expect(validateBranchName("main")).toBe("main");
    expect(validateBranchName("release/2026-08")).toBe("release/2026-08");
    expect(() => validateBranchName("../main")).toThrow();
    expect(() => validateBranchName("main@{bad}")).toThrow();
    expect(() => validateBranchName("main name")).toThrow();
  });

  it("creates an unguessable token whose hash is the stored fence", () => {
    const token = createLeaseToken();
    expect(token.raw).toHaveLength(43);
    expect(hashLeaseToken(token.raw)).toBe(token.hash);
    expect(createLeaseToken().raw).not.toBe(token.raw);
  });

  it("renews leases only before the expiry instant", () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const expires = getLeaseExpiry(now);
    expect(expires.getTime() - now.getTime()).toBe(LEASE_TTL_MS);
    expect(isLeaseExpired(expires, now)).toBe(false);
    expect(isLeaseExpired(expires, new Date(expires.getTime() + 1))).toBe(true);
  });

  it("hashes idempotency payloads independent of object key order", () => {
    expect(stableHash({ a: 1, b: ["x", "y"] })).toBe(
      stableHash({ b: ["x", "y"], a: 1 }),
    );
    expect(stableHash({ a: 1, b: ["x", "y"] })).not.toBe(
      stableHash({ a: 1, b: ["x", "z"] }),
    );
  });

  it("creates deterministic safe task branch slugs", () => {
    expect(taskSlug("Sửa giao diện đăng nhập")).toBe("sua-giao-dien-dang-nhap");
    expect(taskSlug("!!!")).toBe("task");
  });
});
