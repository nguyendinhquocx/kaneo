import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: keyboard drags own
// Space/Enter/ArrowUp/ArrowDown/Escape; the list keyboard handler must not
// run list actions while a drag is active, and idle behavior must survive.

const { reorderMock, navigateMock } = vi.hoisted(() => ({
  reorderMock: vi.fn(),
  navigateMock: vi.fn(),
}));

type DndHandlers = {
  onDragStart?: (event?: unknown) => void;
  onDragEnd?: (event?: unknown) => void;
  onDragCancel?: (event?: unknown) => void;
  announcements?: Record<string, (event: unknown) => string>;
};

let dndHandlers: DndHandlers = {};

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
    onDragCancel,
    accessibility,
  }: {
    children: ReactNode;
    onDragStart?: (event?: unknown) => void;
    onDragEnd?: (event?: unknown) => void;
    onDragCancel?: (event?: unknown) => void;
    accessibility?: {
      announcements?: Record<string, (event: unknown) => string>;
    };
  }) => {
    dndHandlers = {
      onDragStart,
      onDragEnd,
      onDragCancel,
      announcements: accessibility?.announcements,
    };
    return <div data-testid="dnd-context">{children}</div>;
  },
}));

vi.mock("@dnd-kit/sortable", () => ({
  arrayMove: (
    items: string[],
    from: number,
    to: number,
  ): string[] => {
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  },
  SortableContext: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  verticalListSortingStrategy: undefined,
}));

vi.mock("./subtask-row", () => ({
  default: ({
    task,
    isSelected,
    isFocused,
    onToggleComplete,
    onNavigate,
  }: {
    task: { id: string; title: string };
    isSelected: boolean;
    isFocused: boolean;
    onToggleComplete: () => void;
    onNavigate: () => void;
  }) => (
    <div
      data-testid={`subtask-row-${task.id}`}
      data-selected={isSelected ? "true" : "false"}
      data-focused={isFocused ? "true" : "false"}
    >
      <span>{task.title}</span>
      <button type="button" onClick={onToggleComplete}>
        toggle-{task.id}
      </button>
      <button type="button" onClick={onNavigate}>
        open-{task.id}
      </button>
    </div>
  ),
}));

vi.mock("@/hooks/queries/task-relation/use-get-task-relations", () => ({
  default: () => ({ data: relationsFixture }),
}));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "workspace-1" } }),
}));
vi.mock("@/hooks/queries/workspace-users/use-get-active-workspace-users", () => ({
  default: () => ({ data: { members: [] } }),
  useGetActiveWorkspaceUsers: () => ({ data: { members: [] } }),
}));
vi.mock("@/hooks/mutations/task/use-create-task", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/mutations/task-relation/use-create-task-relation", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/task-relation/use-reorder-subtasks", () => ({
  useReorderSubtasks: () => ({ mutate: reorderMock }),
}));
vi.mock("@/hooks/mutations/task/use-delete-task", () => ({
  useDeleteTask: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-status", () => ({
  useUpdateTaskStatus: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/queries/column/use-get-columns", () => ({
  useGetColumns: () => ({
    data: [
      { id: "c1", slug: "to-do", isFinal: false },
      { id: "c2", slug: "done", isFinal: true },
    ],
  }),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canManageTasks: () => true }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));
vi.mock("@/components/share/share-capability", () => ({
  getShareCapability: () => null,
}));
vi.mock("@/query-client", () => ({
  default: { invalidateQueries: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      return `${key} ${opts.title ?? ""} ${opts.position ?? ""}/${opts.total ?? ""}`.trim();
    },
  }),
}));

const parentTask = {
  id: "parent-1",
  title: "Parent",
  number: 1,
  status: "to-do",
  priority: "no-priority",
  projectId: "project-1",
  position: 0,
  userId: null,
  assigneeName: null,
  workMarkerCounts: {
    redCross: 0,
    boxedRedCross: 0,
    redCircle: 0,
    greenCheck: 0,
  },
};

function childTask(id: string, title: string) {
  return {
    ...parentTask,
    id,
    title,
    number: id === "child-1" ? 2 : 3,
    workMarkerCounts: {
      redCross: 2,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    },
  };
}

const relationsFixture = [
  {
    id: "rel-1",
    relationType: "subtask",
    sourceTaskId: "parent-1",
    targetTaskId: "child-1",
    position: 0,
    createdAt: "",
    sourceTask: parentTask,
    targetTask: childTask("child-1", "First child"),
  },
  {
    id: "rel-2",
    relationType: "subtask",
    sourceTaskId: "parent-1",
    targetTaskId: "child-2",
    position: 1,
    createdAt: "",
    sourceTask: parentTask,
    targetTask: childTask("child-2", "Second child"),
  },
];

function pressKey(key: string, target?: Element) {
  const eventTarget = target ?? screen.getByTestId("subtask-row-child-1");
  fireEvent(eventTarget, new KeyboardEvent("keydown", { key, bubbles: true }));
}

async function renderSubtasks() {
  const { default: TaskSubtasks } = await import("./task-subtasks");
  render(
    <TaskSubtasks
      taskId="parent-1"
      projectId="project-1"
      workspaceId="workspace-1"
    />,
  );
  await waitFor(() => {
    expect(screen.getByTestId("subtask-row-child-1")).toBeInTheDocument();
  });
}

describe("TaskSubtasks keyboard DnD isolation", () => {
  beforeEach(() => {
    dndHandlers = {};
    reorderMock.mockReset();
    navigateMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    dndHandlers = {};
  });

  it("keeps idle Space selection and Escape clear working before any drag", { timeout: 20_000 }, async () => {
    await renderSubtasks();

    fireEvent.mouseDown(screen.getByTestId("subtask-row-child-1"));
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.focused,
    ).toBe("true");
    pressKey(" ");
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.selected,
    ).toBe("true");

    pressKey("Escape");
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.selected,
    ).toBe("false");
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.focused,
    ).toBe("false");
  });

  it("gives Space/Enter/Arrows/Escape to dnd-kit while a drag is active", { timeout: 20_000 }, async () => {
    await renderSubtasks();

    fireEvent.mouseDown(screen.getByTestId("subtask-row-child-1"));
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.focused,
    ).toBe("true");

    act(() => {
      dndHandlers.onDragStart?.({ active: { id: "child-1" } });
    });

    pressKey(" ");
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.selected,
    ).toBe("false");
    pressKey("Enter");
    expect(navigateMock).not.toHaveBeenCalled();
    pressKey("ArrowDown");
    // Focus index did not move — dnd-kit owns the arrow keys.
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.focused,
    ).toBe("true");
    pressKey("Escape");
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.selected,
    ).toBe("false");

    act(() => {
      dndHandlers.onDragEnd?.({
        active: { id: "child-1" },
        over: { id: "child-2" },
      });
    });

    // After drop, reorder persists the new order and list keys work again.
    expect(reorderMock).toHaveBeenCalledWith({
      taskId: "parent-1",
      projectId: "project-1",
      orderedTargetTaskIds: ["child-2", "child-1"],
    });

    fireEvent.mouseDown(screen.getByTestId("subtask-row-child-1"));
    pressKey(" ");
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.selected,
    ).toBe("true");
  });

  it("keeps pre-drag selection through Escape during an active drag", { timeout: 20_000 }, async () => {
    await renderSubtasks();

    fireEvent.mouseDown(screen.getByTestId("subtask-row-child-1"));
    pressKey(" ");
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.selected,
    ).toBe("true");

    act(() => {
      dndHandlers.onDragStart?.({ active: { id: "child-2" } });
    });
    pressKey("Escape");
    // Selection made before the drag survives the Escape key press.
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.selected,
    ).toBe("true");

    act(() => {
      dndHandlers.onDragCancel?.();
    });
    pressKey("Escape");
    expect(
      screen.getByTestId("subtask-row-child-1").dataset.selected,
    ).toBe("false");
  });

  it("announces task title and position on lift, move and drop", { timeout: 20_000 }, async () => {
    await renderSubtasks();

    const start = dndHandlers.announcements?.onDragStart?.({
      active: { id: "child-1" },
    });
    expect(start).toContain("First child");
    expect(start).toContain("1/2");

    const move = dndHandlers.announcements?.onDragOver?.({
      active: { id: "child-1" },
      over: { id: "child-2" },
    });
    expect(move).toContain("2/2");

    const end = dndHandlers.announcements?.onDragEnd?.({
      active: { id: "child-1" },
      over: { id: "child-2" },
    });
    expect(end).toContain("First child");
    expect(end).toContain("2/2");

    const cancel = dndHandlers.announcements?.onDragCancel?.({
      active: { id: "child-1" },
    });
    expect(cancel).toContain("First child");
  });
});
