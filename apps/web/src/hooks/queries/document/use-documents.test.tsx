import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareCapabilityProvider } from "@/components/share/share-capability";
import { useGetDocuments } from "./use-documents";

const mocks = vi.hoisted(() => ({ listShareFullDocuments: vi.fn() }));

vi.mock("@/fetchers/share/share-full-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/fetchers/share/share-full-api")>();
  return { ...actual, listShareFullDocuments: mocks.listShareFullDocuments };
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("full-share document list polling", () => {
  it("shares one token-scoped poll between active and archived views", async () => {
    mocks.listShareFullDocuments.mockResolvedValue([
      {
        id: "active-doc",
        title: "Active",
        revision: 1,
        archivedAt: null,
        createdAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
      },
      {
        id: "archived-doc",
        title: "Archived",
        revision: 2,
        archivedAt: "2026-10-24T00:00:00.000Z",
        createdAt: "2026-10-24T00:00:00.000Z",
        updatedAt: "2026-10-24T00:00:00.000Z",
      },
    ]);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ShareCapabilityProvider token="share-token" projectId="project-1">
          {children}
        </ShareCapabilityProvider>
      </QueryClientProvider>
    );

    const { result, unmount } = renderHook(
      () =>
        [
          useGetDocuments("project-1"),
          useGetDocuments("project-1", true),
        ] as const,
      { wrapper },
    );

    await waitFor(() => {
      expect(mocks.listShareFullDocuments).toHaveBeenCalledTimes(1);
      expect(result.current[0].data).toHaveLength(1);
      expect(result.current[1].data).toHaveLength(2);
    });
    await waitFor(
      () => expect(mocks.listShareFullDocuments).toHaveBeenCalledTimes(2),
      { timeout: 12_000, interval: 100 },
    );

    unmount();
    await act(async () => queryClient.clear());
  }, 15_000);
});
