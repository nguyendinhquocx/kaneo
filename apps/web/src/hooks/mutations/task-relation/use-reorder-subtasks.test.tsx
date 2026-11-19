import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReorderSubtasks } from "./use-reorder-subtasks";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  reorderSubtasks: vi.fn(),
  reorderShareFullSubtasks: vi.fn(),
  getShareCapability: vi.fn(() => null),
}));

vi.mock("@/fetchers/task/get-task", () => ({ default: mocks.getTask }));
vi.mock("@/fetchers/task-relation/reorder-subtasks", () => ({
  reorderSubtasks: mocks.reorderSubtasks,
}));
vi.mock("@/fetchers/share/share-full-api", () => ({
  reorderShareFullSubtasks: mocks.reorderShareFullSubtasks,
}));
vi.mock("@/components/share/share-capability", () => ({
  getShareCapability: mocks.getShareCapability,
}));

describe("useReorderSubtasks content revision", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reads the current parent revision before persisting the new order", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    mocks.getTask.mockResolvedValue({ id: "parent-1", contentRevision: 7 });
    mocks.reorderSubtasks.mockResolvedValue([]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useReorderSubtasks(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        taskId: "parent-1",
        projectId: "project-1",
        orderedTargetTaskIds: ["child-2", "child-1"],
      });
    });

    expect(mocks.getTask).toHaveBeenCalledWith("parent-1");
    expect(mocks.reorderSubtasks).toHaveBeenCalledWith({
      taskId: "parent-1",
      orderedTargetTaskIds: ["child-2", "child-1"],
      expectedParentContentRevision: 7,
    });
  });
});
