import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Task from "@/types/task";
import WorkMarkerPicker from "./work-marker-picker";

const { saveMarkers, toastError } = vi.hoisted(() => ({
  saveMarkers: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/mutations/task/use-update-work-markers", () => ({
  useUpdateWorkMarkers: () => ({ mutateAsync: saveMarkers, isPending: false }),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: toastError } }));
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

describe("WorkMarkerPicker", () => {
  it("offers four triple presets and writes only the selected marker", async () => {
    saveMarkers.mockResolvedValue(undefined);
    render(
      <WorkMarkerPicker
        task={task}
        projectId="project-1"
        workspaceId="workspace-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "tasks:workMarkers.title" }));
    const redCross = screen.getByRole("button", {
      name: "tasks:workMarkers.countAria tasks:workMarkers.redCross 3",
    });
    expect(screen.getAllByRole("button")).toHaveLength(5);
    fireEvent.click(redCross);

    await waitFor(() => {
      expect(saveMarkers).toHaveBeenCalledWith({
        redCross: 3,
        boxedRedCross: 0,
        redCircle: 0,
        greenCheck: 0,
      });
    });
  });

  it("clears only an exact active triple when the same preset is chosen again", async () => {
    saveMarkers.mockResolvedValue(undefined);
    render(
      <WorkMarkerPicker
        task={{
          ...task,
          workMarkerCounts: { ...task.workMarkerCounts, redCircle: 3 },
        }}
        projectId="project-1"
        workspaceId="workspace-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "tasks:workMarkers.title" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks:workMarkers.countAria tasks:workMarkers.redCircle 3",
      }),
    );

    await waitFor(() => {
      expect(saveMarkers).toHaveBeenCalledWith({
        redCross: 0,
        boxedRedCross: 0,
        redCircle: 0,
        greenCheck: 0,
      });
    });
  });

  it("normalizes legacy multi-marker counts only after an explicit preset choice", async () => {
    saveMarkers.mockResolvedValue(undefined);
    render(
      <WorkMarkerPicker
        task={{
          ...task,
          workMarkerCounts: {
            redCross: 1,
            boxedRedCross: 0,
            redCircle: 3,
            greenCheck: 0,
          },
        }}
        projectId="project-1"
        workspaceId="workspace-1"
      />,
    );

    expect(screen.getByRole("button", { name: "tasks:workMarkers.title" })).toBeVisible();
    expect(saveMarkers).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "tasks:workMarkers.title" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks:workMarkers.countAria tasks:workMarkers.redCross 3",
      }),
    );

    await waitFor(() => {
      expect(saveMarkers).toHaveBeenCalledWith({
        redCross: 3,
        boxedRedCross: 0,
        redCircle: 0,
        greenCheck: 0,
      });
    });
  });

  it("reports a failed save and leaves the picker open for recovery", async () => {
    saveMarkers.mockRejectedValue(new Error("network failure"));
    render(
      <WorkMarkerPicker
        task={task}
        projectId="project-1"
        workspaceId="workspace-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "tasks:workMarkers.title" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks:workMarkers.countAria tasks:workMarkers.boxedRedCross 3",
      }),
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("network failure");
      expect(screen.getByRole("group", { name: "tasks:workMarkers.title" })).toBeVisible();
    });
  });

  it("labels the inline icon trigger for the task", () => {
    render(
      <WorkMarkerPicker
        task={task}
        projectId="project-1"
        workspaceId="workspace-1"
        trigger="icon"
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "tasks:workMarkers.openForTask Task under test",
      }),
    ).toBeInTheDocument();
  });
});
