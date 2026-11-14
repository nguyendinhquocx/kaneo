import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { cloneElement, isValidElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommentCard from "./comment-card";

const uiState = vi.hoisted(() => ({
  canShare: false,
  canUpdate: false,
  capability: null as unknown,
  binding: null as unknown,
  currentUser: null as null | { id: string },
}));

vi.mock("@/components/activity/comment-editor", () => ({
  default: ({ value }: { value: string }) => <div>{value}</div>,
}));

vi.mock("@/components/providers/auth-provider/hooks/use-auth", () => ({
  useAuth: () => ({ user: uiState.currentUser }),
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageShareLinks: () => uiState.canShare,
    canManageTasks: () => uiState.canUpdate,
  }),
}));
vi.mock("@/components/share/share-capability", () => ({
  getShareCapability: () => uiState.capability,
}));
vi.mock("@/hooks/queries/agent-session/use-get-task-binding-status", () => ({
  useGetTaskBindingStatus: () => ({ data: uiState.binding, isLoading: false, isError: false }),
}));
vi.mock("@/hooks/queries/agent-session/use-get-comment-delivery-status", () => ({
  useGetCommentDeliveryStatus: () => ({ data: undefined }),
}));
vi.mock("@/hooks/mutations/agent-session/use-send-comment-to-pi", () => ({
  useSendCommentToPi: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/mutations/comment/use-update-comment", () => ({
  default: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { sessionId?: string; host?: string }) => {
      if (key === "activity:comment.sendToPi") return "Send to Pi";
      if (key === "activity:comment.sendToPiTarget") {
        return `session ${vars?.sessionId} on ${vars?.host}`;
      }
      if (key === "activity:comment.resendToPi") return "Send again";
      return key;
    },
  }),
}));

vi.mock("@/lib/format", () => ({
  formatRelativeTime: () => "2 hours ago",
  formatDateTime: () => "Apr 5, 2026, 11:38 AM",
}));

vi.mock("@/components/ui/tooltip", async () => {
  const React = await import("react");

  function Tooltip({ children }: { children: ReactNode }) {
    const [open, setOpen] = React.useState(false);
    return (
      <div data-testid="tooltip-root">
        {React.Children.map(children, (child) =>
          isValidElement(child)
            ? cloneElement(
                child as ReactElement<{
                  open?: boolean;
                  setOpen?: (open: boolean) => void;
                }>,
                {
                  open,
                  setOpen,
                },
              )
            : child,
        )}
      </div>
    );
  }

  function TooltipTrigger({
    children,
    setOpen,
  }: {
    children: ReactElement;
    setOpen?: (open: boolean) => void;
  }) {
    return cloneElement(children as ReactElement<Record<string, unknown>>, {
      onMouseEnter: () => setOpen?.(true),
      onMouseLeave: () => setOpen?.(false),
      onFocus: () => setOpen?.(true),
      onBlur: () => setOpen?.(false),
    });
  }

  function TooltipContent({
    children,
    open,
  }: {
    children: ReactNode;
    open?: boolean;
  }) {
    return open ? <div role="tooltip">{children}</div> : null;
  }

  function TooltipProvider({ children }: { children: ReactNode }) {
    return <>{children}</>;
  }

  return {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
  };
});

function renderCommentCard(options: Partial<typeof uiState> = {}) {
  uiState.canShare = options.canShare ?? false;
  uiState.canUpdate = options.canUpdate ?? false;
  uiState.capability = options.capability ?? null;
  uiState.binding = options.binding ?? null;
  uiState.currentUser = options.currentUser ?? null;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <CommentCard
        commentId="comment-1"
        taskId="task-1"
        content="Test comment"
        createdAt="2026-04-05T09:38:50.000Z"
        user={{
          id: "user-1",
          name: "Tin",
          email: "tin@example.com",
          image: null,
        }}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("CommentCard", () => {
  it("shows Send to Pi for task:update even without project:share", () => {
    renderCommentCard({
      currentUser: { id: "user-1" },
      canUpdate: true,
      canShare: false,
      binding: {
        bound: true,
        online: true,
        bindingId: "binding-1",
        bindingGeneration: 2,
        sessionId: "pi-session-exact",
        hostId: "pi-prodesk",
      },
    });
    expect(
      screen.getByRole("button", {
        name: /Send to Pi.*pi-session-exact.*pi-prodesk/,
      }),
    ).toBeVisible();
  });

  it("hides Send to Pi on a share-capability surface and when no binding is live", () => {
    const { rerender } = renderCommentCard({
      currentUser: { id: "user-1" },
      canUpdate: true,
      capability: {
        resourceType: "task",
        permission: "edit",
        token: "share-token",
        projectId: "project-1",
        rootTaskId: "task-1",
      },
      binding: {
        bound: true,
        online: true,
        bindingId: "binding-1",
        bindingGeneration: 1,
        sessionId: "pi-session",
        hostId: "pi-host",
      },
    });
    expect(screen.queryByRole("button", { name: /Send to Pi/ })).toBeNull();

    uiState.capability = null;
    uiState.binding = { bound: true, online: false, hostId: "pi-host" };
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <CommentCard
          commentId="comment-1"
          taskId="task-1"
          content="Test comment"
          createdAt="2026-04-05T09:38:50.000Z"
          user={{ id: "user-1", name: "Tin", email: "tin@example.com", image: null }}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: /Send to Pi/ })).toBeNull();
  });

  it("shows full date+short time in tooltip on hover/focus", async () => {
    renderCommentCard();

    const trigger = screen.getByRole("button", {
      name: "Apr 5, 2026, 11:38 AM",
    });

    fireEvent.mouseEnter(trigger);
    expect(await screen.findByText("Apr 5, 2026, 11:38 AM")).toBeVisible();

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByText("Apr 5, 2026, 11:38 AM")).not.toBeInTheDocument();

    fireEvent.focus(trigger);
    expect(await screen.findByText("Apr 5, 2026, 11:38 AM")).toBeVisible();
  });
});
