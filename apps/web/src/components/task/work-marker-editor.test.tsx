import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Task from "@/types/task";
import WorkMarkerEditor from "./work-marker-editor";

const { saveMarkers, toastError } = vi.hoisted(() => ({
  saveMarkers: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/mutations/task/use-update-work-markers", async () => {
  const React = await import("react");
  return {
    useUpdateWorkMarkers: () => {
      const [isPending, setIsPending] = React.useState(false);
      const mutateAsync = async (counts: unknown) => {
        setIsPending(true);
        try {
          return await saveMarkers(counts);
        } finally {
          setIsPending(false);
        }
      };
      return { mutateAsync, isPending };
    },
  };
});
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
    expect(
      screen.getByRole("group", { name: "tasks:workMarkers.title" }),
    ).toBeInTheDocument();

    const increase = screen.getByRole("button", {
      name: "tasks:workMarkers.increase tasks:workMarkers.redCross Task under test",
    });
    increase.focus();
    fireEvent.click(increase);

    // The pending state is exposed to assistive technology, but the button
    // is not natively disabled: keyboard focus must remain on the control.
    expect(increase).toHaveAttribute("aria-disabled", "true");
    expect(increase).not.toBeDisabled();
    expect(document.activeElement).toBe(increase);
    expect(screen.getByRole("status")).toBeVisible();

    // A second rapid click is guarded synchronously while the first full-map
    // request is in flight; it cannot overwrite the same stale count map.
    fireEvent.click(increase);
    expect(saveMarkers).toHaveBeenCalledTimes(1);
    expect(saveMarkers).toHaveBeenCalledWith({
      redCross: 1,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    });

    resolveSave?.();
    await waitFor(() => {
      expect(increase).toHaveAttribute("aria-disabled", "false");
      expect(document.activeElement).toBe(increase);
    });
  });

  it("keeps boundary controls focusable while exposing aria-disabled", () => {
    render(
      <WorkMarkerEditor
        task={task}
        projectId="project-1"
        workspaceId="workspace-1"
      />,
    );

    const decrease = screen.getByRole("button", {
      name: "tasks:workMarkers.decrease tasks:workMarkers.redCross Task under test",
    });
    expect(decrease).toHaveAttribute("aria-disabled", "true");
    expect(decrease).not.toBeDisabled();

    decrease.focus();
    fireEvent.click(decrease);
    expect(document.activeElement).toBe(decrease);
    expect(saveMarkers).not.toHaveBeenCalled();
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
