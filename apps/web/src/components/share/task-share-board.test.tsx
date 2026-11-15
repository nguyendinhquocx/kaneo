import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskShareRootPayload } from "@/fetchers/share/share-task-api";
import TaskShareBoard from "./task-share-board";

const state = vi.hoisted(() => ({ project: null as unknown }));

vi.mock("@/components/board/board-toolbar", () => ({
  default: () => <div data-testid="board-toolbar" />,
}));
vi.mock("@/components/kanban-board", () => ({
  default: ({ project }: { project: unknown }) => {
    state.project = project;
    return <div data-testid="kanban-board" />;
  },
}));
vi.mock("@/components/list-view", () => ({ default: () => <div data-testid="list-view" /> }));
vi.mock("@/store/project", () => ({
  default: () => ({ setProject: vi.fn() }),
}));
vi.mock("@/store/user-preferences", () => ({
  useUserPreferencesStore: () => ({ viewMode: "board", setViewMode: vi.fn() }),
}));
vi.mock("@/hooks/use-board-sort", () => ({
  useBoardSort: () => ({ sort: { field: "position", direction: "asc" }, setSort: vi.fn() }),
}));
vi.mock("@/hooks/use-task-filters-with-labels-support", () => ({
  useTaskFiltersWithLabelsSupport: (project: unknown) => ({
    filteredProject: project,
    filters: {},
    updateFilter: vi.fn(),
    clearFilters: vi.fn(),
    hasActiveFilters: false,
    updateLabelFilter: vi.fn(),
  }),
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

afterEach(() => {
  cleanup();
  state.project = null;
});

const card = (id: string, status: string, title: string) => ({
  id,
  number: id === "root" ? 124 : 125,
  title,
  description: null,
  status,
  statusLabel: status,
  priority: null,
  startDate: null,
  dueDate: null,
  contentRevision: 1,
  workMarkerCounts: { redCross: 0, boxedRedCross: 0, redCircle: 0, greenCheck: 0 },
  labels: [],
  assetRefs: [],
});

describe("TaskShareBoard", () => {
  it("renders the real board with only the shared root card and its scoped subtask preview", () => {
    const payload: TaskShareRootPayload = {
      permission: "view",
      rootTaskId: "root",
      scopeProjectId: "project-1",
      statusOptions: [
        { slug: "to-do", name: "To Do", isFinal: false },
        { slug: "implement", name: "Implement", isFinal: false },
      ],
      root: { ...card("root", "implement", "pi android"), labels: [{ id: "label", name: "UAT", color: "#123456" }] },
      subtasks: [card("child", "to-do", "agent - review spec")],
      commentsPage: { items: [], nextCursor: null },
    };

    render(<TaskShareBoard token="share-token" payload={payload} />);

    expect(screen.getByTestId("board-toolbar")).toBeVisible();
    expect(screen.getByTestId("kanban-board")).toBeVisible();
    const project = state.project as {
      columns: Array<{ slug: string; tasks: Array<{ id: string; labels?: Array<{ name: string }>; nextSubtaskPreview: { title: string } | null }> }>;
    };
    const shownTasks = project.columns.flatMap((column) => column.tasks);
    expect(shownTasks.map((task) => task.id)).toEqual(["root"]);
    expect(shownTasks[0]?.labels?.[0]?.name).toBe("UAT");
    expect(shownTasks[0]?.nextSubtaskPreview?.title).toBe("agent - review spec");
  });
});
