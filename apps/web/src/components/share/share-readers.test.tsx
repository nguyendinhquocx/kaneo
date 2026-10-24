import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ShareFullProjectPayload,
} from "@/fetchers/share/share-full-api";
import type { ShareProjectPayload } from "@/fetchers/share/share-public-api";
import DocumentShareReader from "./document-share-reader";
import GoalShareReader from "./goal-share-reader";
import ProjectShareReader from "./project-share-reader";
import ShareLinkState from "./share-link-state";
import ShareProjectRouteContent from "./share-project-route-content";

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
  id: "project-1",
  name: "Shared project",
  slug: "SHR",
  icon: null,
  description: null,
  isPublic: true,
  columns: [
    {
      id: "column-1",
      name: "To do",
      slug: "to-do",
      icon: null,
      isFinal: false,
      tasks: [],
    },
  ],
  archivedTasks: [],
  plannedTasks: [],
};

describe("project share scope routing", () => {
  it("keeps view/edit links on the legacy reader and mounts full only for full scope", () => {
    const fullSurface = (payload: ShareFullProjectPayload) => (
      <div data-testid="full-surface">{payload.scope}</div>
    );
    const { rerender } = renderWithQueryClient(
      <ShareProjectRouteContent
        token="view-token"
        data={{ ...project, scope: "view" } as ShareProjectPayload}
        fullSurface={fullSurface}
      />,
    );
    expect(screen.getByTestId("public-kanban")).toBeVisible();
    expect(screen.queryByTestId("full-surface")).toBeNull();

    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ShareProjectRouteContent
          token="edit-token"
          data={{ ...project, scope: "edit" } as ShareProjectPayload}
          fullSurface={fullSurface}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: "edit" })).toBeVisible();
    expect(screen.queryByTestId("full-surface")).toBeNull();

    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ShareProjectRouteContent
          token="full-token"
          data={{ scope: "full" } as ShareProjectPayload}
          fullSurface={fullSurface}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("full-surface")).toHaveTextContent("full");
  });
});

describe("share-link recovery states", () => {
  it("explains invalid/revoked links and does not offer a login redirect", () => {
    renderWithQueryClient(<ShareLinkState kind="invalid" />);

    expect(screen.getByText("invalid.title")).toBeVisible();
    expect(screen.getByText("invalid.description")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /sign|log in|register/i }),
    ).toBeNull();
  });

  it("offers retry for a recoverable load error", () => {
    const onRetry = vi.fn();
    renderWithQueryClient(<ShareLinkState kind="error" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "rateLimited.retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

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
