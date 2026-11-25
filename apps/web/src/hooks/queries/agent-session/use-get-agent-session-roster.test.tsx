import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRoster } from "@/fetchers/agent-session/agent-session-roster";
import { useGetAgentSessionRoster } from "./use-get-agent-session-roster";

// SPEC-2026-11-25 D4: eager-fetch-once, never poll.

const getRoster = vi.hoisted(() =>
  vi.fn(async () => ({ sessions: [] }) as AgentSessionRoster),
);

vi.mock("@/fetchers/agent-session/agent-session-roster", () => ({
  getAgentSessionRoster: (...args: unknown[]) => getRoster(...(args as [])),
}));

// One shared client per test: the remount assertions depend on the cache
// being the same instance across hook mounts.
function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

beforeEach(() => {
  getRoster.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useGetAgentSessionRoster", () => {
  it("fetches once on mount and never polls in the background", async () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useGetAgentSessionRoster(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getRoster).toHaveBeenCalledTimes(1);
    // The contract: no background polling — presence updates ride actions.
    expect(result.current.refetchInterval).toBeUndefined();
    expect(result.current.refetchIntervalInBackground).toBeFalsy();
    // Within staleTime a remount reuses the cache without refetching.
    const second = renderHook(() => useGetAgentSessionRoster(), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(getRoster).toHaveBeenCalledTimes(1);
  });

  it("serves stale data immediately and refreshes in the background past staleTime", async () => {
    const wrapper = makeWrapper();
    const first = renderHook(() => useGetAgentSessionRoster(), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(getRoster).toHaveBeenCalledTimes(1);

    // Age the cache past the 60s staleTime (tanstack reads Date.now), then
    // mount a second observer: stale data surfaces instantly + 1 refetch.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow + 61_000);
    try {
      const fresh = renderHook(() => useGetAgentSessionRoster(), { wrapper });
      await waitFor(() => expect(fresh.result.current.data).toBeDefined());
      expect(getRoster).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
