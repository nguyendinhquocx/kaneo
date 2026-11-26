import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareCapabilityProvider } from "@/components/share/share-capability";
import TaskPropertiesSidebar from "./task-properties-sidebar";

const mocks = vi.hoisted(() => ({
  task: {
    id: "task-1",
    projectId: "project-1",
    title: "Task",
    number: 1,
    status: "to-do",
    priority: "low",
    userId: null,
    description: "",
    startDate: null,
    dueDate: null,
    createdAt: new Date(0).toISOString(),
  },
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock("@/hooks/queries/task/use-get-task", () => ({
  default: () => ({ data: mocks.task }),
}));
vi.mock("@/hooks/queries/project/use-get-project", () => ({
  default: () => ({ data: { id: "project-1", slug: "PRJ" } }),
}));
vi.mock("@/hooks/queries/column/use-get-columns", () => ({
  useGetColumns: () => ({ data: [] }),
}));
vi.mock(
  "@/hooks/queries/workspace-users/use-get-active-workspace-users",
  () => ({
    useGetActiveWorkspaceUsers: () => ({ data: { members: [] } }),
  }),
);
vi.mock("@/hooks/queries/label/use-get-labels-by-task", () => ({
  default: () => ({ data: [] }),
}));
vi.mock("@/hooks/queries/gitea-integration/use-get-gitea-integration", () => ({
  default: () => ({ data: undefined }),
}));
vi.mock(
  "@/hooks/queries/github-integration/use-get-github-integration",
  () => ({
    default: () => ({ data: undefined }),
  }),
);
vi.mock("@/hooks/queries/project/use-get-projects", () => ({
  default: () => ({ data: [] }),
}));
// SPEC-2026-11-25: the agents panel needs a query client — the sidebar
// tests assert layout, so the panel renders under S0 (empty roster).
vi.mock("@/hooks/queries/agent-session/use-get-task-binding-status", () => ({
  useGetTaskBindingStatus: () => ({ data: { bound: false, online: false } }),
}));
const rosterSessions = vi.hoisted(() => ({
  list: [] as Array<{
    sessionId: string;
    host: string;
    title: string;
    cwd: string;
    model: string;
    lastSeenAt: string;
    agentPrincipalId: string;
    binding: null;
  }>,
}));

vi.mock("@/hooks/queries/agent-session/use-get-agent-session-roster", () => ({
  useGetAgentSessionRoster: () => ({
    data: { sessions: rosterSessions.list },
    isLoading: false,
    isError: false,
    isStale: true,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/mutations/agent-session/use-bind-agent-session", () => ({
  useBindAgentSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/mutations/agent-session/use-unbind-agent-session", () => ({
  useUnbindAgentSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageTasks: () => true,
    canAssignTasks: () => false,
    // SPEC-2026-11-10 T3: share-link minting is off in this fixture — the
    // Copy slot keeps its plain URL-copy behavior.
    canManageShareLinks: () => false,
    isCheckingPermissions: false,
  }),
}));
vi.mock("@/store/project", () => ({
  default: () => ({ project: null }),
}));
vi.mock("@/hooks/mutations/task/use-update-task", () => ({
  useUpdateTask: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-status-priority", () => ({
  useUpdateTaskPriority: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-status", () => ({
  useUpdateTaskStatus: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-assignee", () => ({
  useUpdateTaskAssignee: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-title", () => ({
  useUpdateTaskTitle: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-description", () => ({
  useUpdateTaskDescription: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-due-date", () => ({
  useUpdateTaskDueDate: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("./work-marker-picker", () => ({
  default: ({
    task,
    triggerClassName,
  }: {
    task: { id: string };
    triggerClassName?: string;
  }) => (
    <button
      type="button"
      className={triggerClassName}
      aria-label={`marker:${task.id}`}
    >
      Marker
    </button>
  ),
}));
vi.mock("@/components/task/task-assignee-popover", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/task/task-due-date-popover", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/task/task-labels-popover", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/task/task-move-popover", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/task/task-priority-popover", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/task/task-start-date-popover", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/task/task-status-popover", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/task/task-subtasks", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/task/task-relations", () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/kbd", () => ({
  KbdSequence: () => <span />,
}));
vi.mock("@/components/ui/calendar", () => ({
  Calendar: () => <div />,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), message: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("task properties in full share mode", () => {
  it("hides integration branch-copy control but preserves the task link control", () => {
    render(
      <ShareCapabilityProvider token="full-token" projectId="project-1">
        <TaskPropertiesSidebar
          taskId="task-1"
          projectId="project-1"
          workspaceId=""
        />
      </ShareCapabilityProvider>,
    );

    expect(
      screen.queryByRole("button", {
        name: "tasks:properties.copyTaskBranch",
      }),
    ).toBeNull();
    expect(
      screen.getAllByRole("button", {
        name: "tasks:properties.copyTaskLink",
      }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "marker:task-1" })).toBeNull();
  });

  it("SPEC-2026-11-25: mounts the agents panel in BOTH sidebar layouts (S1)", () => {
    rosterSessions.list = [
      {
        sessionId: "s-1",
        host: "pi-laptop",
        title: "live session",
        cwd: "D:/work",
        model: "glm",
        lastSeenAt: new Date().toISOString(),
        agentPrincipalId: "p1",
        binding: null,
      },
    ];
    try {
      render(
        <TaskPropertiesSidebar
          taskId="task-1"
          projectId="project-1"
          workspaceId="workspace-1"
        />,
      );
      // Mobile row and desktop block are responsive counterparts. The mobile
      // row follows its horizontal properties; the desktop block follows Labels.
      // This suite's i18n mock resolves keys verbatim.
      const buttons = screen.getAllByRole("button", {
        name: "tasks:properties.agents.assign · tasks:properties.agents.runningCount",
      });
      const markers = screen.getAllByRole("button", {
        name: "marker:task-1",
      });
      expect(buttons).toHaveLength(2);
      expect(markers).toHaveLength(2);
      expect(
        markers[0].compareDocumentPosition(buttons[0]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        markers[1].compareDocumentPosition(buttons[1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        screen
          .getByText("tasks:properties.labels")
          .compareDocumentPosition(buttons[1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      rosterSessions.list = [];
    }
  });

  it("SPEC-2026-11-25: compact modal keeps one Agents row in its own property slot", () => {
    rosterSessions.list = [
      {
        sessionId: "s-1",
        host: "pi-laptop",
        title: "live session",
        cwd: "D:/work",
        model: "glm",
        lastSeenAt: new Date().toISOString(),
        agentPrincipalId: "p1",
        binding: null,
      },
    ];
    try {
      render(
        <TaskPropertiesSidebar
          taskId="task-1"
          projectId="project-1"
          workspaceId="workspace-1"
          compact
        />,
      );
      const agents = screen.getAllByRole("button", {
        name: "tasks:properties.agents.assign · tasks:properties.agents.runningCount",
      });
      const marker = screen.getByRole("button", { name: "marker:task-1" });
      expect(agents).toHaveLength(1);
      expect(
        marker.compareDocumentPosition(agents[0]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      rosterSessions.list = [];
    }
  });

  it("SPEC-2026-11-25: share mode renders no agents control at all", () => {
    rosterSessions.list = [
      {
        sessionId: "s-1",
        host: "pi-laptop",
        title: "live session",
        cwd: "D:/work",
        model: "glm",
        lastSeenAt: new Date().toISOString(),
        agentPrincipalId: "p1",
        binding: null,
      },
    ];
    try {
      render(
        <ShareCapabilityProvider token="full-token" projectId="project-1">
          <TaskPropertiesSidebar
            taskId="task-1"
            projectId="project-1"
            workspaceId=""
          />
        </ShareCapabilityProvider>,
      );
      expect(
        screen.queryByRole("button", { name: /agents\.assign/ }),
      ).toBeNull();
    } finally {
      rosterSessions.list = [];
    }
  });

  it("exposes the compact marker action on authenticated task properties", () => {
    render(
      <TaskPropertiesSidebar
        taskId="task-1"
        projectId="project-1"
        workspaceId="workspace-1"
        compact
      />,
    );

    expect(screen.getByRole("button", { name: "marker:task-1" })).toBeVisible();
  });

  it("left-aligns the marker action with full-width desktop properties", () => {
    render(
      <TaskPropertiesSidebar
        taskId="task-1"
        projectId="project-1"
        workspaceId="workspace-1"
      />,
    );

    const markerTriggers = screen.getAllByRole("button", {
      name: "marker:task-1",
    });
    expect(markerTriggers).toHaveLength(2);
    expect(markerTriggers[0]).not.toHaveClass("w-full");
    expect(markerTriggers[1]).toHaveClass("w-full");
  });
});
