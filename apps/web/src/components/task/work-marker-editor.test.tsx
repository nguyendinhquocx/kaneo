import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Task from "@/types/task";
import WorkMarkerEditor from "./work-marker-editor";

const { saveMarkers, toastError } = vi.hoisted(() => ({
  saveMarkers: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/mutations/task/use-update-work-markers", () => ({
  useUpdateWorkMarkers: () => ({
    mutateAsync: saveMarkers,
    isPending: false,
  }),
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: toastError },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${Object.values(values).join(" ")}` : key,
  }),
}));

const task: Task = {
  id: "task-1",
  title: "Task under test",
  number: 1,
  description: null,
  status: "to-do",
  priority: "no-priority",
  startDate: null,
  dueDate: null,
  position: 0,
  createdAt: "2026-10-28T00:00:00.000Z",
  userId: null,
  assigneeId: null,
  assigneeName: null,
  projectId: "project-1",
  workMarkerCounts: {
    redCross: 0,
    boxedRedCross: 0,
    redCircle: 0,
    greenCheck: 0,
  },
};

afterEach(() => {
  cleanup();
  saveMarkers.mockReset();
  toastError.mockReset();
});

describe("WorkMarkerEditor", () => {
  it("serializes rapid clicks so a stale full-map request cannot lose an increment", async () => {
    let resolveSave: (() => void) | undefined;
    saveMarkers.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    render(
      <WorkMarkerEditor
        task={task}
        projectId="project-1"
        workspaceId="workspace-1"
      />,
    );

    const increase = screen.getByRole("button", {
      name: "tasks:workMarkers.increase tasks:workMarkers.redCross Task under test",
    });
    fireEvent.click(increase);
    fireEvent.click(increase);

    // Only the first full-map update is sent while it is in flight. Without
    // the synchronous lock, both calls would submit redCross=1 from stale
    // props, and the second click would be silently lost.
    expect(saveMarkers).toHaveBeenCalledTimes(1);
    expect(saveMarkers).toHaveBeenCalledWith({
      redCross: 1,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    });

    resolveSave?.();
    await waitFor(() => expect(saveMarkers).toHaveBeenCalledTimes(1));
  });

  it("keeps saved counts unchanged and reports the error when a write fails", async () => {
    saveMarkers.mockRejectedValue(new Error("network failure"));
    render(
      <WorkMarkerEditor
        task={{
          ...task,
          workMarkerCounts: { ...task.workMarkerCounts, redCross: 2 },
        }}
        projectId="project-1"
        workspaceId="workspace-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks:workMarkers.increase tasks:workMarkers.redCross Task under test",
      }),
    );

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("network failure"),
    );
    expect(screen.getByText("2", { exact: true })).toBeInTheDocument();
  });
});
