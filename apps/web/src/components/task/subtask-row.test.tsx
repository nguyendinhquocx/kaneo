import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Task from "@/types/task";
import SubtaskRow from "./subtask-row";

const { updateTaskTitle } = vi.hoisted(() => ({
  updateTaskTitle: vi.fn(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock(
  "@/components/kanban-board/task-card-context-menu/task-card-context-menu-content",
  () => ({
    default: () => null,
  }),
);
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/hooks/mutations/task/use-update-task-title", () => ({
  useUpdateTaskTitle: () => ({
    mutateAsync: updateTaskTitle,
    isPending: false,
  }),
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      return `${key} ${Object.values(opts).map(String).join(" ")}`;
    },
  }),
}));
vi.mock("./subtask-assignee-popover", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./subtask-status-popover", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
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
  workMarkerCounts: {
    redCross: 2,
    boxedRedCross: 0,
    redCircle: 4,
    greenCheck: 0,
  },
  projectId: "project-1",
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  updateTaskTitle.mockReset();
  updateTaskTitle.mockResolvedValue({ ...task, title: "New title" });
});

describe("SubtaskRow inline title editing", () => {
  it("saves from the parent row without navigating and immediately shows the new title", async () => {
    const onNavigate = vi.fn();
    render(
      <SubtaskRow
        task={task}
        tasks={[task]}
        projectId="project-1"
        workspaceId="workspace-1"
        isSelected={false}
        isFocused={false}
        isCompleted={false}
        canEdit
        selectionRadius="rounded-md"
        assignee={null}
        onToggleComplete={vi.fn()}
        onNavigate={onNavigate}
        onDeleteClick={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /tasks:subtasks\.editTitle/ }),
    );
    const input = screen.getByRole("textbox", {
      name: /tasks:subtasks\.editTitle/,
    });
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(updateTaskTitle).toHaveBeenCalledWith({
        ...task,
        title: "New title",
      });
      expect(screen.getByText("New title")).toBeVisible();
    });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("SubtaskRow reorder affordances and markers", () => {
  function renderRow() {
    return render(
      <SubtaskRow
        task={task}
        tasks={[task]}
        projectId="project-1"
        workspaceId="workspace-1"
        isSelected={false}
        isFocused={false}
        isCompleted={false}
        canEdit
        selectionRadius="rounded-md"
        assignee={null}
        onToggleComplete={vi.fn()}
        onNavigate={vi.fn()}
        onDeleteClick={vi.fn()}
      />,
    );
  }

  it("renders no up/down arrow buttons — drag handle is the only reorder control", () => {
    renderRow();
    expect(
      screen.queryByRole("button", { name: "tasks:subtasks.moveUp" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "tasks:subtasks.moveDown" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /tasks:subtasks\.drag/ }),
    ).toBeInTheDocument();
  });

  it("shows the marker cluster with compacted counts next to the title", () => {
    renderRow();
    // Accessible name carries marker name + count, never a status meaning.
    const cluster = screen.getByRole("img");
    expect(cluster.getAttribute("aria-label")).toContain("4");
    // Compaction: 4+ renders one glyph plus ×N instead of repeated glyphs.
    expect(cluster.textContent).toContain("×4");
  });
});
