import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareCapabilityProvider } from "@/components/share/share-capability";
import type { ProjectWithTasks } from "@/types/project";
import { useMoveShareTask } from "./use-update-task";

const mocks = vi.hoisted(() => ({
  moveShareFullTask: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/fetchers/share/share-full-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/fetchers/share/share-full-api")>();
  return { ...actual, moveShareFullTask: mocks.moveShareFullTask };
});

vi.mock("@/lib/toast", () => ({ toast: { error: mocks.toastError } }));

afterEach(() => {
  vi.clearAllMocks();
});

function makeTask(id: string, status: string, position: number) {
  return {
    id,
    projectId: "project-1",
    number: null,
    title: id,
    description: null,
    status,
    priority: null,
    startDate: null,
    dueDate: null,
    position,
    createdAt: "2026-10-25T00:00:00.000Z",
    userId: null,
    assigneeId: null,
    assigneeName: null,
    labels: [],
  };
}

function makeProject() {
  return {
    id: "project-1",
    name: "Project",
    slug: "project",
    icon: null,
    description: null,
    workspaceId: "",
    isPublic: true,
    columns: [
      {
        id: "to-do",
        slug: "to-do",
        name: "To Do",
        icon: null,
        isFinal: false,
        tasks: [makeTask("first", "to-do", 0), makeTask("moving", "to-do", 1)],
      },
      {
        id: "done",
        slug: "done",
        name: "Done",
        icon: null,
        isFinal: true,
        tasks: [makeTask("destination", "done", 0)],
      },
    ],
    archivedTasks: [],
    plannedTasks: [],
  } as unknown as ProjectWithTasks;
}

describe("useMoveShareTask", () => {
  it("optimistically moves one card, sends one request, and rolls back on failure", async () => {
    let rejectMove: (error: Error) => void = () => {};
    mocks.moveShareFullTask.mockReturnValue(
      new Promise<{ success: boolean }>((_resolve, reject) => {
        rejectMove = reject;
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
    });
    const queryKey = ["share-full", "share-token"];
    const original = makeProject();
    queryClient.setQueryData(queryKey, original);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ShareCapabilityProvider token="share-token" projectId="project-1">
          {children}
        </ShareCapabilityProvider>
      </QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useMoveShareTask(), { wrapper });

    act(() => {
      result.current.mutate({ taskId: "moving", status: "done", position: 0 });
    });

    await waitFor(() => {
      expect(mocks.moveShareFullTask).toHaveBeenCalledTimes(1);
      const optimistic = queryClient.getQueryData<ProjectWithTasks>(queryKey);
      expect(optimistic?.columns[0].tasks.map((task) => task.id)).toEqual([
        "first",
      ]);
      expect(optimistic?.columns[1].tasks.map((task) => task.id)).toEqual([
        "moving",
        "destination",
      ]);
      expect(result.current.isPending).toBe(true);
    });

    await act(async () => {
      rejectMove(new Error("simulated write rejection"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.toastError).toHaveBeenCalledTimes(1);

    const rolledBack = queryClient.getQueryData<ProjectWithTasks>(queryKey);
    expect(rolledBack?.columns[0].tasks.map((task) => task.id)).toEqual([
      "first",
      "moving",
    ]);
    expect(rolledBack?.columns[1].tasks.map((task) => task.id)).toEqual([
      "destination",
    ]);

    unmount();
    queryClient.clear();
  });
});
