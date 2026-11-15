import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TaskCardLabels from "./task-labels";

const state = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/hooks/queries/label/use-get-labels-by-task", () => ({
  default: (_taskId: string, enabled = true) => {
    state.enabled = enabled;
    return { data: [] };
  },
}));

afterEach(() => cleanup());

describe("TaskCardLabels", () => {
  it("renders authorized labels from the guest board payload without a per-card request", () => {
    state.enabled = true;
    render(
      <TaskCardLabels
        taskId="task-1"
        labels={[{ id: "label-1", name: "UAT", color: "#123456" }]}
      />,
    );

    expect(screen.getByText("UAT")).toBeVisible();
    expect(state.enabled).toBe(false);
  });
});
