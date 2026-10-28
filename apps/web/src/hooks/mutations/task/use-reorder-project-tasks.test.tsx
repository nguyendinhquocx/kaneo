import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectBoardTask, ProjectWithTasks } from "@/types/project";
import { reorderProjectTasks, resolveTaskReorderIntent } from "@/lib/task-reorder";
import { useReorderProjectTasks } from "./use-reorder-project-tasks";

const { updateTask, toastError } = vi.hoisted(() => ({
  updateTask: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/mutations/task/use-update-task", () => ({
  useUpdateTask: () => ({ mutateAsync: updateTask }),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: toastError } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function task(id: string, position: number): ProjectBoardTask {
  return {
    id,
    projectId: "project-1",
    title: id,
    number: position + 1,
    description: null,
    status: "todo",
    priority: "no-priority",
    startDate: null,
    dueDate: null,
    position,
    createdAt: "2026-10-28T00:00:00.000Z",
    userId: null,
    assigneeId: null,
    assigneeName: null,
    workMarkerCounts: {
      redCross: 0,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    },
    isSubtask: false,
    nextSubtaskPreview: null,
  };
}

function makeProject(): ProjectWithTasks {
  return {
    id: "project-1",
    name: "Project",
    slug: "PRJ",
    icon: null,
    description: null,
    workspaceId: "workspace-1",
    isPublic: false,
    showSubtaskCardsByDefault: true,
    showAssigneesByDefault: true,
    showPriorityByDefault: true,
    columns: [
      {
        id: "todo",
        slug: "todo",
        name: "To Do",
        icon: null,
        isFinal: false,
        tasks: [task("a", 0), task("b", 1), task("c", 2)],
      },
      {
        id: "doing",
        slug: "doing",
        name: "Doing",
        icon: null,
        isFinal: false,
        tasks: [],
      },
    ],
    plannedTasks: [],
    archivedTasks: [],
  } as ProjectWithTasks;
}

function ids(project: ProjectWithTasks) {
  return project.columns.map((column) => column.tasks.map((task) => task.id));
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useReorderProjectTasks", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    updateTask.mockReset();
    toastError.mockReset();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("updates the task-list projection before the network writes finish", async () => {
    const previous = makeProject();
    queryClient.setQueryData(["tasks", previous.id], previous);
    const intent = resolveTaskReorderIntent(previous, "b", "doing");
    const { project: optimisticProject, changedTasks } = reorderProjectTasks(
      previous,
      intent!,
    );
    const resolvers: Array<() => void> = [];
    updateTask.mockImplementation(
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    const { result } = renderHook(() => useReorderProjectTasks(), {
      wrapper: createWrapper(queryClient),
    });

    let mutation!: Promise<void>;
    act(() => {
      mutation = result.current.mutateAsync({
        projectId: previous.id,
        taskId: "b",
        optimisticProject,
        changedTasks,
      });
    });

    await waitFor(() => {
      expect(ids(queryClient.getQueryData<ProjectWithTasks>(["tasks", previous.id])!)).toEqual([
        ["a", "c"],
        ["b"],
      ]);
    });
    expect(updateTask).toHaveBeenCalledTimes(2);

    await act(async () => {
      for (const resolve of resolvers) resolve();
      await mutation;
    });
    expect(ids(queryClient.getQueryData<ProjectWithTasks>(["tasks", previous.id])!)).toEqual([
      ["a", "c"],
      ["b"],
    ]);
  });

  it("rolls back the optimistic order and reports an error if any write fails", async () => {
    const previous = makeProject();
    queryClient.setQueryData(["tasks", previous.id], previous);
    const intent = resolveTaskReorderIntent(previous, "b", "doing");
    const { project: optimisticProject, changedTasks } = reorderProjectTasks(
      previous,
      intent!,
    );
    updateTask.mockRejectedValue(new Error("permission denied"));
    const { result } = renderHook(() => useReorderProjectTasks(), {
      wrapper: createWrapper(queryClient),
    });

    await expect(
      act(() =>
        result.current.mutateAsync({
          projectId: previous.id,
          taskId: "b",
          optimisticProject,
          changedTasks,
        }),
      ),
    ).rejects.toThrow("permission denied");

    expect(ids(queryClient.getQueryData<ProjectWithTasks>(["tasks", previous.id])!)).toEqual([
      ["a", "b", "c"],
      [],
    ]);
    expect(toastError).toHaveBeenCalledWith("permission denied");
  });
});
