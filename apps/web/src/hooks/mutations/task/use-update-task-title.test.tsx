import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Task from "@/types/task";
import { useUpdateTaskTitle } from "./use-update-task-title";

const { updateTaskTitle } = vi.hoisted(() => ({
  updateTaskTitle: vi.fn(),
}));

vi.mock("@/fetchers/task/update-task-title", () => ({
  default: updateTaskTitle,
}));

const task: Task = {
  id: "child-1",
  title: "Old title",
  number: 2,
  description: null,
  status: "to-do",
  priority: "no-priority",
  startDate: null,
  dueDate: null,
  position: 2,
  createdAt: "2026-10-21T00:00:00.000Z",
  userId: null,
  assigneeId: null,
  assigneeName: null,
  projectId: "project-1",
};

beforeEach(() => {
  updateTaskTitle.mockReset();
  updateTaskTitle.mockResolvedValue({ ...task, title: "New title" });
});

describe("useUpdateTaskTitle", () => {
  it("updates cached parent and child relation labels before navigation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["task", task.id], task);
    queryClient.setQueryData(
      ["task-relations", "parent-1"],
      [
        {
          id: "relation-1",
          sourceTaskId: "parent-1",
          targetTaskId: task.id,
          relationType: "subtask",
          position: 0,
          sourceTask: { ...task, id: "parent-1", title: "Parent" },
          targetTask: task,
        },
      ],
    );

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdateTaskTitle(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ ...task, title: "New title" });
    });

    expect(queryClient.getQueryData(["task", task.id])).toMatchObject({
      title: "New title",
    });
    expect(
      queryClient.getQueryData<Array<{ targetTask: Task }>>([
        "task-relations",
        "parent-1",
      ]),
    ).toMatchObject([{ targetTask: { title: "New title" } }]);
  });
});
