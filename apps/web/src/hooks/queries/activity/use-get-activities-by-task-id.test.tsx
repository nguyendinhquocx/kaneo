import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareCapabilityProvider } from "@/components/share/share-capability";
import { getShareFullTaskDetail } from "@/fetchers/share/share-full-api";
import useGetActivitiesByTaskId from "./use-get-activities-by-task-id";

vi.mock("@/fetchers/share/share-full-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/fetchers/share/share-full-api")>();
  return {
    ...actual,
    getShareFullTaskDetail: vi.fn().mockResolvedValue({ comments: [] }),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("full-share activity refresh", () => {
  it("polls the comment timeline every ten seconds while the tab is visible", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ShareCapabilityProvider token="full-token" projectId="project-1">
          {children}
        </ShareCapabilityProvider>
      </QueryClientProvider>
    );

    const { unmount } = renderHook(
      () => useGetActivitiesByTaskId("task-1"),
      { wrapper },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(getShareFullTaskDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getShareFullTaskDetail).toHaveBeenCalledTimes(2);
    unmount();
    queryClient.clear();
  });
});
