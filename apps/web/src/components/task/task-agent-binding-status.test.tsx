import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TaskAgentBindingStatus from "./task-agent-binding-status";

const query = vi.hoisted(() => ({
  data: null as null | { bound: boolean; online: boolean; hostId?: string },
  isLoading: false,
  isError: false,
}));

vi.mock("@/hooks/queries/agent-session/use-get-task-binding-status", () => ({
  useGetTaskBindingStatus: () => query,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { host?: string }) =>
      key === "tasks:detail.agentBinding.host"
        ? `Host: ${vars?.host ?? ""}`
        : key === "tasks:detail.agentBinding.online"
          ? "Pi connected"
          : "Pi offline",
  }),
}));

afterEach(() => {
  cleanup();
  query.data = null;
  query.isLoading = false;
  query.isError = false;
});

describe("TaskAgentBindingStatus", () => {
  it("shows the bound session's online state and canonical host", () => {
    query.data = { bound: true, online: true, hostId: "pi-prodesk" };
    render(<TaskAgentBindingStatus taskId="task-1" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Pi connected · Host: pi-prodesk",
    );
  });

  it("shows offline for a bound session with an old heartbeat", () => {
    query.data = { bound: true, online: false, hostId: "pi-laptop" };
    render(<TaskAgentBindingStatus taskId="task-1" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Pi offline · Host: pi-laptop",
    );
  });

  it("renders nothing when the card is not bound or status is unavailable", () => {
    query.data = { bound: false, online: false };
    const { container, rerender } = render(
      <TaskAgentBindingStatus taskId="task-1" />,
    );
    expect(container).toBeEmptyDOMElement();
    query.data = { bound: true, online: false };
    query.isError = true;
    rerender(<TaskAgentBindingStatus taskId="task-1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
