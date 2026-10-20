import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DocumentShareReader from "./document-share-reader";
import GoalShareReader from "./goal-share-reader";
import ProjectShareReader from "./project-share-reader";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("@/components/public-project/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/public-project/kanban-view", () => ({
  PublicKanbanView: () => <div data-testid="public-kanban" />,
}));
vi.mock("@/components/public-project/list-view", () => ({
  PublicListView: () => <div data-testid="public-list" />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderWithQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const project = {
  name: "Shared project",
  slug: "SHR",
  description: null,
  columns: [{ id: "column-1", name: "To do", slug: "to-do", tasks: [] }],
  archivedTasks: [],
  plannedTasks: [],
};

describe("public share edit affordances", () => {
  it("keeps a view-only document read-only and reveals its editor from the edit button", () => {
    const { rerender } = renderWithQueryClient(
      <DocumentShareReader
        data={{
          id: "document-1",
          title: "Shared doc",
          content: "Body",
          revision: 1,
          scope: "view",
        }}
        token="view-token"
      />,
    );

    expect(screen.queryByRole("button", { name: "edit" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();

    rerender(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <DocumentShareReader
          data={{
            id: "document-1",
            title: "Shared doc",
            content: "Body",
            revision: 1,
            scope: "edit",
          }}
          token="edit-token"
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(
      screen.getByRole("textbox", { name: "document.titleLabel" }),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "document.contentLabel" }),
    ).toBeVisible();
  });

  it("does not enable goal check-ins until an edit-link holder chooses Edit", () => {
    renderWithQueryClient(
      <GoalShareReader
        data={{
          name: "Weekly goal",
          archivedAt: null,
          scope: "edit",
          targetPerWeek: 3,
          checkins: [],
        }}
        token="goal-token"
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(checkboxes[0]).toBeEnabled();
  });

  it("shows a project edit action only for edit scope and gates task creation behind it", () => {
    const { rerender } = renderWithQueryClient(
      <ProjectShareReader
        data={{ ...project, scope: "view" } as never}
        token="view-token"
      />,
    );

    expect(screen.queryByRole("button", { name: "edit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "project.newTask" }),
    ).toBeNull();

    rerender(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ProjectShareReader
          data={{ ...project, scope: "edit" } as never}
          token="edit-token"
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: "edit" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "project.newTask" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(
      screen.getByRole("button", { name: "project.newTask" }),
    ).toBeVisible();
  });
});
