import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectBoardTask, ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";
import useUpdateWorkMarkers from "./use-update-work-markers";

const { saveMarkers } = vi.hoisted(() => ({ saveMarkers: vi.fn() }));

vi.mock("@/fetchers/task/update-work-markers", () => ({
  default: (...args: unknown[]) => saveMarkers(...args),
}));

const zeroCounts = {
  redCross: 0,
  boxedRedCross: 0,
  redCircle: 0,
  greenCheck: 0,
};

function task(id: string, projectId: string): ProjectBoardTask {
  return {
    id,
    projectId,
    title: id,
    number: 1,
    description: null,
    status: "todo",
    priority: "no-priority",
    startDate: null,
    dueDate: null,
    position: 0,
    createdAt: "2026-10-28T00:00:00.000Z",
    userId: null,
    assigneeId: null,
    assigneeName: null,
    workMarkerCounts: { ...zeroCounts },
    isSubtask: false,
    nextSubtaskPreview: null,
  };
}

function projectWith(taskValue: ProjectBoardTask): ProjectWithTasks {
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
        tasks: [taskValue],
      },
    ],
    plannedTasks: [],
    archivedTasks: [],
  } as ProjectWithTasks;
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useUpdateWorkMarkers optimistic projections", () => {
  let queryClient: QueryClient;
  let child: ProjectBoardTask;
  let parent: ProjectBoardTask;
  let taskDetail: Task;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    saveMarkers.mockReset();
    child = task("child-1", "project-1");
    parent = {
      ...task("parent-1", "project-1"),
      nextSubtaskPreview: {
        id: child.id,
        title: child.title,
        workMarkerCounts: { ...zeroCounts },
      },
    };
    taskDetail = child;
    queryClient.setQueryData(["task", child.id], taskDetail);
    queryClient.setQueryData(["tasks", "project-1"], projectWith(parent));
    queryClient.setQueryData(["task-relations", parent.id], [
      { id: "relation-1", sourceTask: parent, targetTask: child },
    ]);
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("updates task, parent preview, and open subtask rows before the server responds", async () => {
    let resolveSave: (() => void) | undefined;
    saveMarkers.mockImplementation(
      () => new Promise<void>((resolve) => (resolveSave = resolve)),
    );
    const { result } = renderHook(
      () => useUpdateWorkMarkers(child.id, "project-1"),
      { wrapper: createWrapper(queryClient) },
    );
    const nextCounts = { ...zeroCounts, redCircle: 3 };

    let mutation!: Promise<unknown>;
    act(() => {
      mutation = result.current.mutateAsync(nextCounts);
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<Task>(["task", child.id])?.workMarkerCounts,
      ).toEqual(nextCounts);
      const updatedProject = queryClient.getQueryData<ProjectWithTasks>([
        "tasks",
        "project-1",
      ])!;
      expect(updatedProject.columns[0]?.tasks[0]?.nextSubtaskPreview?.workMarkerCounts).toEqual(nextCounts);
      const relations = queryClient.getQueryData<
        Array<{ targetTask: Task }>
      >(["task-relations", parent.id]);
      expect(relations?.[0]?.targetTask.workMarkerCounts).toEqual(nextCounts);
    });
    expect(saveMarkers).toHaveBeenCalledWith(child.id, nextCounts);

    await act(async () => {
      resolveSave?.();
      await mutation;
    });
  });

  it("restores every cached projection when the server rejects the marker write", async () => {
    saveMarkers.mockRejectedValue(new Error("write rejected"));
    const { result } = renderHook(
      () => useUpdateWorkMarkers(child.id, "project-1"),
      { wrapper: createWrapper(queryClient) },
    );
    const nextCounts = { ...zeroCounts, greenCheck: 3 };

    await expect(
      act(() => result.current.mutateAsync(nextCounts)),
    ).rejects.toThrow("write rejected");

    expect(queryClient.getQueryData<Task>(["task", child.id])?.workMarkerCounts).toEqual(zeroCounts);
    expect(
      queryClient.getQueryData<ProjectWithTasks>(["tasks", "project-1"])?.columns[0]?.tasks[0]?.nextSubtaskPreview?.workMarkerCounts,
    ).toEqual(zeroCounts);
    const relations = queryClient.getQueryData<Array<{ targetTask: Task }>>([
      "task-relations",
      parent.id,
    ]);
    expect(relations?.[0]?.targetTask.workMarkerCounts).toEqual(zeroCounts);
  });
});
