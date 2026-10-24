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
vi.mock("@/hooks/queries/workspace-users/use-get-active-workspace-users", () => ({
  useGetActiveWorkspaceUsers: () => ({ data: { members: [] } }),
}));
vi.mock("@/hooks/queries/label/use-get-labels-by-task", () => ({
  default: () => ({ data: [] }),
}));
vi.mock("@/hooks/queries/gitea-integration/use-get-gitea-integration", () => ({
  default: () => ({ data: undefined }),
}));
vi.mock("@/hooks/queries/github-integration/use-get-github-integration", () => ({
  default: () => ({ data: undefined }),
}));
vi.mock("@/hooks/queries/project/use-get-projects", () => ({
  default: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageTasks: () => true,
    canAssignTasks: () => false,
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
  });
});
