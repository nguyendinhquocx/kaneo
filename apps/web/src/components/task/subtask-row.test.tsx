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
vi.mock("./work-marker-picker", () => ({
  default: ({ task, trigger }: { task: Task; trigger?: string }) =>
    trigger === "icon" ? (
      <button type="button" aria-label={`Choose marker for ${task.title}`}>
        marker
      </button>
    ) : null,
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
  function renderRow(rowTask: Task = task) {
    return render(
      <SubtaskRow
        task={rowTask}
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

  it("renders no arrow reorder buttons — the drag handle is the only reorder control", () => {
    const { container } = renderRow();
    expect(
      screen.queryByRole("button", { name: /move(up|down)/i }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector("svg.lucide-arrow-up, svg.lucide-arrow-down"),
    ).toBeNull();
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

  it("keeps all marker glyphs inline with the title on narrow rows", () => {
    const allRepeated: Task = {
      ...task,
      workMarkerCounts: {
        redCross: 3,
        boxedRedCross: 3,
        redCircle: 3,
        greenCheck: 3,
      },
    };
    const { container } = renderRow(allRepeated);
    const cluster = screen.getByRole("img");
    expect(cluster.getAttribute("aria-label")).toContain("redCross");
    expect(cluster.getAttribute("aria-label")).toContain("boxedRedCross");
    expect(cluster.getAttribute("aria-label")).toContain("redCircle");
    expect(cluster.getAttribute("aria-label")).toContain("greenCheck");
    expect(cluster.textContent).toContain("❌❌❌");
    expect(cluster.textContent).toContain("❎❎❎");
    expect(cluster.textContent).toContain("⭕⭕⭕");
    expect(cluster.textContent).toContain("✅✅✅");
    const titleButton = screen.getByRole("button", { name: "Old title" });
    expect(titleButton.parentElement).toBe(cluster.parentElement);
    expect(titleButton.querySelector("span.truncate")).toBeInTheDocument();
    expect(container.querySelector(".basis-full.items-center")).toBeInTheDocument();
  });

  it("places a quick marker action directly before the title edit button", () => {
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

    const markerButton = screen.getByRole("button", {
      name: "Choose marker for Old title",
    }) as HTMLButtonElement;
    const editButton = screen.getByRole("button", {
      name: /tasks:subtasks\.editTitle/,
    }) as HTMLButtonElement;
    const buttons = Array.from(document.querySelectorAll("button"));
    expect(buttons.indexOf(markerButton) + 1).toBe(buttons.indexOf(editButton));

    fireEvent.click(markerButton);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
