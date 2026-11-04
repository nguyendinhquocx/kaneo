import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavMain } from "./nav-main";

const navigateMock = vi.hoisted(() => vi.fn());
const configMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "ws-1", name: "WS" } }),
}));

vi.mock("@/hooks/queries/invitation/use-pending-invitations", () => ({
  usePendingInvitations: () => ({ data: [] }),
}));

vi.mock(
  "@/hooks/queries/embedded-integration/use-embedded-services-config",
  () => ({ default: (...args: unknown[]) => configMock(...args) }),
);

vi.mock("@/components/ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <ul>{children}</ul>
  ),
  SidebarMenuButton: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <li>{children}</li>
  ),
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CollapsiblePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

afterEach(cleanup);

beforeEach(() => {
  configMock.mockReturnValue({
    data: { mitra: { enabled: true } },
    isSuccess: true,
  });
});

describe("NavMain workspace calendar entry", () => {
  it("links the workspace-level calendar without project paths", () => {
    render(<NavMain />);

    const calendarButton = screen.getByRole("button", {
      name: "navigation:sidebar.calendar",
    });
    expect(calendarButton).toBeInTheDocument();

    // Active only on the exact workspace calendar route.
    expect(calendarButton.className ?? "").not.toContain("data-active");
  });

  it("does not render calendar inside a project route shape", () => {
    render(<NavMain />);
    const text = screen.getByText("navigation:sidebar.calendar");
    expect(text.closest("li")).not.toBeNull();
  });

  it("fails closed while service configuration is loading or disabled", () => {
    configMock.mockReturnValue({ data: undefined, isLoading: true });
    const { rerender } = render(<NavMain />);
    expect(screen.queryByText("navigation:sidebar.calendar")).toBeNull();

    configMock.mockReturnValue({
      data: { mitra: { enabled: false } },
      isSuccess: true,
    });
    rerender(<NavMain />);
    expect(screen.queryByText("navigation:sidebar.calendar")).toBeNull();
  });
});
