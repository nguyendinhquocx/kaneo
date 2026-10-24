import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareRequestError } from "@/fetchers/share/share-request-error";
import type { ProjectWithTasks } from "@/types/project";
import ShareProjectCapabilityContent from "./share-project-capability-content";

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined as ProjectWithTasks | undefined,
    isLoading: true,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/queries/task/use-get-tasks", () => ({
  useGetTasks: () => mocks.query,
}));
vi.mock("./share-project-surface", () => ({
  default: ({ children }: { children?: ReactNode }) => (
    <div data-testid="project-surface">{children}</div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const project = {
  id: "project-1",
  name: "Shared project",
  columns: [],
  archivedTasks: [],
  plannedTasks: [],
} as unknown as ProjectWithTasks;

function renderCapabilityContent() {
  return render(
    <ShareProjectCapabilityContent
      token="full-token"
      projectId={project.id}
      initialProject={project}
      taskDetails={<div data-testid="task-sheet">Cached task content</div>}
    >
      <div>Project contents</div>
    </ShareProjectCapabilityContent>,
  );
}

describe("share project authorization gate", () => {
  it("unmounts the task sheet when a later capability check fails", () => {
    mocks.query = {
      data: project,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    const view = renderCapabilityContent();
    expect(screen.getByTestId("task-sheet")).toBeVisible();

    mocks.query = {
      data: project,
      isLoading: false,
      isError: true,
      error: new ShareRequestError("invalid"),
      refetch: vi.fn(),
    };
    view.rerender(
      <ShareProjectCapabilityContent
        token="full-token"
        projectId={project.id}
        initialProject={project}
        taskDetails={<div data-testid="task-sheet">Cached task content</div>}
      >
        <div>Project contents</div>
      </ShareProjectCapabilityContent>,
    );

    expect(screen.queryByTestId("task-sheet")).toBeNull();
    expect(screen.queryByText("Project contents")).toBeNull();
    expect(screen.getByText("invalid.title")).toBeVisible();
  });
});
