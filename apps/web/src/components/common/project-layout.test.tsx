import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectLayout from "./project-layout";

const locationPathname = vi.hoisted(() => vi.fn());
const embeddedConfigMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "mindMapPageTitle" ? "Mind Map" : key),
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: locationPathname() }),
}));

vi.mock("@/components/common/layout", () => {
  const Layout = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  const Header = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="layout-header">{children}</div>
  );
  const Content = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  return { default: Object.assign(Layout, { Header, Content }) };
});

vi.mock("@/components/common/header/mobile-project-nav", () => ({
  default: (props: { activeView: string }) => (
    <div data-testid="mobile-nav-mock" data-active-view={props.activeView} />
  ),
}));

vi.mock("@/components/common/header/project-crumb-select", () => ({
  default: () => <div />,
}));

vi.mock("@/components/common/header/workspace-crumb-select", () => ({
  default: () => <div />,
}));

vi.mock("@/components/shared/modals/create-project-modal", () => ({
  default: () => null,
}));

vi.mock("@/components/ui/kbd", () => ({
  KbdSequence: () => <span />,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button type="button" data-testid="sidebar-trigger" />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/hooks/queries/project/use-get-project", () => ({
  default: () => ({ data: { name: "P" } }),
}));

vi.mock(
  "@/hooks/queries/embedded-integration/use-embedded-services-config",
  () => ({ default: (...args: unknown[]) => embeddedConfigMock(...args) }),
);

vi.mock("@/hooks/use-project-websocket", () => ({
  useProjectWebSocket: () => {},
}));

afterEach(cleanup);

beforeEach(() => {
  embeddedConfigMock.mockReturnValue({
    data: { wisemapping: { enabled: true } },
  });
});

describe("ProjectLayout mind map view", () => {
  it("detects the mindmap route and keeps the view switcher visible", () => {
    locationPathname.mockReturnValue(
      "/dashboard/workspace/ws-1/project/p-1/mindmap",
    );

    render(
      <ProjectLayout projectId="p-1" workspaceId="ws-1">
        <div>content</div>
      </ProjectLayout>,
    );

    expect(screen.getByTestId("mobile-nav-mock")).toHaveAttribute(
      "data-active-view",
      "mindmap",
    );

    const switcherButton = screen.getByRole("button", { name: "Mind Map" });
    expect(switcherButton).toBeInTheDocument();

    // Mobile picker and desktop switcher are mutually exclusive breakpoints.
    const switcher = switcherButton.parentElement as HTMLElement;
    expect(switcher.className).toContain("hidden");
    expect(switcher.className).toContain("md:inline-flex");
    expect(switcher.className).not.toContain("sm:inline-flex");
  });

  it("hides the Mind Map switcher when the workspace toggle is off", () => {
    locationPathname.mockReturnValue(
      "/dashboard/workspace/ws-1/project/p-1/board",
    );
    embeddedConfigMock.mockReturnValue({
      data: { wisemapping: { enabled: false } },
    });

    render(
      <ProjectLayout projectId="p-1" workspaceId="ws-1">
        <div>content</div>
      </ProjectLayout>,
    );

    expect(screen.queryByRole("button", { name: "Mind Map" })).toBeNull();
    expect(screen.getByRole("button", { name: "Docs" })).toBeInTheDocument();
  });

  it("defaults to the board view on non-view routes", () => {
    locationPathname.mockReturnValue("/dashboard/workspace/ws-1/project/p-1");

    render(
      <ProjectLayout projectId="p-1" workspaceId="ws-1">
        <div>content</div>
      </ProjectLayout>,
    );

    expect(screen.getByTestId("mobile-nav-mock")).toHaveAttribute(
      "data-active-view",
      "board",
    );
    expect(
      screen.getByRole("button", { name: "Mind Map" }),
    ).toBeInTheDocument();
  });
});
