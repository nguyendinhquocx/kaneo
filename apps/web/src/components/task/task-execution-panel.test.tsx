import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TaskExecutionPanel from "./task-execution-panel";

const useGetTaskRuns = vi.fn();
const useGetTaskRunEvidence = vi.fn();
const useGetExecutionAgents = vi.fn();
const useGetExecutionManifest = vi.fn();
const useReviewTaskRun = vi.fn();

vi.mock("@/hooks/queries/execution/use-get-task-runs", () => ({
  default: (taskId: string) => useGetTaskRuns(taskId),
}));
vi.mock("@/hooks/queries/execution/use-get-task-run-evidence", () => ({
  default: (taskId: string, runId: string | undefined) =>
    useGetTaskRunEvidence(taskId, runId),
}));
vi.mock("@/hooks/queries/execution/use-get-execution-agents", () => ({
  default: () => useGetExecutionAgents(),
}));
vi.mock("@/hooks/queries/execution/use-get-execution-manifest", () => ({
  default: (projectId: string) => useGetExecutionManifest(projectId),
}));
vi.mock("@/hooks/mutations/execution/use-review-task-run", () => ({
  default: () => useReviewTaskRun(),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canReviewExecutions: () => true }),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const run = {
  id: "run-1",
  taskId: "task-1",
  manifestId: "manifest-1",
  manifestVersion: 2,
  protocolVersion: 1,
  repositoryOwner: "owner",
  repositoryName: "repo",
  baseBranch: "main",
  state: "in_review",
  role: "implement",
  agentPrincipalId: "agent-1",
  hostId: "pi-laptop",
  branchName: "pi-laptop/task-1-run-1-worker",
  scope: ["apps/web/src"],
  baseSha: "a".repeat(40),
  commitSha: "b".repeat(40),
  prNumber: null,
  prUrl: null,
  prState: null,
  evidence: {},
  blocker: null,
  nextAction: null,
  leaseEpoch: 1,
  leaseActive: false,
  leaseExpiresAt: "2026-08-11T00:00:00.000Z",
  lastHeartbeatAt: "2026-08-11T00:00:00.000Z",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};

const manifest = {
  id: "manifest-1",
  projectId: "project-1",
  repositoryOwner: "owner",
  repositoryName: "repo",
  baseBranch: "main",
  docs: [],
  verificationProfile: "web",
  allowedAgentIds: ["agent-1"],
  policy: {},
  manifestVersion: 2,
  protocolVersion: 1,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskExecutionPanel", () => {
  it("shows parent review controls and submits bounded verification evidence", async () => {
    const mutateAsync = vi.fn().mockResolvedValue(run);
    useGetTaskRuns.mockReturnValue({
      data: [run],
      isLoading: false,
      isError: false,
    });
    useGetTaskRunEvidence.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });
    useGetExecutionAgents.mockReturnValue({
      data: [{ id: "agent-1", runtimeId: "pi-laptop", hostId: "pi-laptop" }],
    });
    useGetExecutionManifest.mockReturnValue({ data: manifest });
    useReviewTaskRun.mockReturnValue({ mutateAsync, isPending: false });

    render(<TaskExecutionPanel taskId="task-1" projectId="project-1" />);

    expect(screen.getByText("tasks:detail.execution.title")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "tasks:detail.execution.review.approve",
      }),
    ).toBeVisible();

    fireEvent.change(
      screen.getByLabelText(
        "tasks:detail.execution.review.verificationProfile",
      ),
      {
        target: { value: "web" },
      },
    );
    fireEvent.change(
      screen.getByLabelText("tasks:detail.execution.review.changedFiles"),
      {
        target: {
          value: "apps/web/src/components/task/task-execution-panel.tsx",
        },
      },
    );
    fireEvent.change(
      screen.getByLabelText("tasks:detail.execution.review.commands"),
      {
        target: { value: "pnpm --filter @kaneo/web test -- --run" },
      },
    );
    fireEvent.click(
      screen.getByLabelText("tasks:detail.execution.review.diffWithinScope"),
    );
    fireEvent.click(
      screen.getByLabelText("tasks:detail.execution.review.branchValid"),
    );
    fireEvent.click(
      screen.getByLabelText("tasks:detail.execution.review.testsPassed"),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks:detail.execution.review.approve",
      }),
    );

    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        runId: "run-1",
        json: expect.objectContaining({
          decision: "approve",
          action: "none",
          verification: expect.objectContaining({
            verificationProfile: "web",
            changedFiles: [
              "apps/web/src/components/task/task-execution-panel.tsx",
            ],
            commands: ["pnpm --filter @kaneo/web test -- --run"],
            diffWithinScope: true,
            branchValid: true,
            testsPassed: true,
          }),
        }),
      }),
    );
  });

  it("surfaces worker and evidence query failures instead of hiding them", () => {
    useGetTaskRuns.mockReturnValue({
      data: [run],
      isLoading: false,
      isError: false,
    });
    useGetTaskRunEvidence.mockReturnValue({
      data: [],
      isLoading: false,
      isError: true,
    });
    useGetExecutionAgents.mockReturnValue({
      data: [],
      isError: true,
    });
    useGetExecutionManifest.mockReturnValue({ data: manifest });
    useReviewTaskRun.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });

    render(<TaskExecutionPanel taskId="task-1" projectId="project-1" />);

    expect(
      screen.getByText("tasks:detail.execution.agentsError"),
    ).toBeVisible();
    expect(
      screen.getByText("tasks:detail.execution.evidenceError"),
    ).toBeVisible();
  });
});
