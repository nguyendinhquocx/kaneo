import { afterEach, describe, expect, it, vi } from "vitest";

const shareState = vi.hoisted(() => ({ active: false }));

vi.mock("@/components/share/share-capability", () => ({
  getShareCapability: () =>
    shareState.active
      ? {
          resourceType: "task",
          permission: "edit",
          token: "test-token",
          projectId: "project-1",
          rootTaskId: "task-1",
        }
      : null,
}));

import { shareAwareAuthFetch } from "./share-aware-auth-fetch";

afterEach(() => {
  shareState.active = false;
  vi.restoreAllMocks();
});

describe("shareAwareAuthFetch", () => {
  it("answers organization lookups locally while a share capability is active", async () => {
    shareState.active = true;
    const networkFetch = vi.spyOn(globalThis, "fetch");

    const organizationList = await shareAwareAuthFetch(
      "https://kaneo.test/api/auth/organization/list",
    );
    const fullOrganization = await shareAwareAuthFetch(
      "https://kaneo.test/api/auth/organization/get-full-organization",
    );

    expect(organizationList.status).toBe(200);
    expect(await organizationList.json()).toEqual([]);
    expect(fullOrganization.status).toBe(200);
    expect(await fullOrganization.json()).toEqual({});
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("does not intercept authenticated organization requests", async () => {
    shareState.active = false;
    const response = new Response("authenticated", { status: 200 });
    const networkFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response);

    const result = await shareAwareAuthFetch(
      "https://kaneo.test/api/auth/organization/list",
    );

    expect(result).toBe(response);
    expect(networkFetch).toHaveBeenCalledOnce();
  });

  it("does not intercept unrelated API requests during a share", async () => {
    shareState.active = true;
    const response = new Response("unrelated", { status: 200 });
    const networkFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response);

    const result = await shareAwareAuthFetch("https://kaneo.test/api/task/1");

    expect(result).toBe(response);
    expect(networkFetch).toHaveBeenCalledOnce();
  });
});
