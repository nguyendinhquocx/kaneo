import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import useCreateTaskRelation from "./use-create-task-relation";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  createTaskRelation: vi.fn(),
  createShareFullRelation: vi.fn(),
  getShareCapability: vi.fn(() => null),
  invalidateShareQueries: vi.fn(),
}));

vi.mock("@/fetchers/task/get-task", () => ({ default: mocks.getTask }));
vi.mock("@/fetchers/task-relation/create-task-relation", () => ({
  default: mocks.createTaskRelation,
}));
vi.mock("@/fetchers/share/share-full-api", () => ({
  createShareFullRelation: mocks.createShareFullRelation,
}));
vi.mock("@/components/share/share-capability", () => ({
  getShareCapability: mocks.getShareCapability,
  invalidateShareQueries: mocks.invalidateShareQueries,
}));

describe("useCreateTaskRelation content revision", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reads the real parent revision before creating a subtask relation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mocks.getTask.mockResolvedValue({ id: "parent-1", contentRevision: 7 });
    mocks.createTaskRelation.mockResolvedValue({ id: "relation-1" });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCreateTaskRelation(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        sourceTaskId: "parent-1",
        targetTaskId: "child-1",
        relationType: "subtask",
      });
    });

    expect(mocks.getTask).toHaveBeenCalledWith("parent-1");
    expect(mocks.createTaskRelation).toHaveBeenCalledWith({
      sourceTaskId: "parent-1",
      targetTaskId: "child-1",
      relationType: "subtask",
      expectedParentContentRevision: 7,
    });
  });
});
