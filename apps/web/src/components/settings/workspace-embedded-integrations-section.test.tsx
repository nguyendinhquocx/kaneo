import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkspaceEmbeddedIntegrationsSection from "./workspace-embedded-integrations-section";

const permissionMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: (...args: unknown[]) => permissionMock(...args),
}));

vi.mock("./embedded-integrations-settings", () => ({
  default: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="embedded-integrations-settings">{workspaceId}</div>
  ),
}));

afterEach(() => {
  cleanup();
  permissionMock.mockReset();
});

describe("WorkspaceEmbeddedIntegrationsSection", () => {
  it("does not flash while permission is being checked", () => {
    permissionMock.mockReturnValue({
      canManageEmbeddedIntegrations: () => false,
      isCheckingPermissions: true,
    });

    render(<WorkspaceEmbeddedIntegrationsSection workspaceId="ws-1" />);

    expect(
      screen.queryByRole("region", { name: "embedded:settings.sectionTitle" }),
    ).toBeNull();
  });

  it("hides the integration settings from members without manage_settings", () => {
    permissionMock.mockReturnValue({
      canManageEmbeddedIntegrations: () => false,
      isCheckingPermissions: false,
    });

    render(<WorkspaceEmbeddedIntegrationsSection workspaceId="ws-1" />);

    expect(screen.queryByTestId("embedded-integrations-settings")).toBeNull();
  });

  it("shows the settings section for a manage_settings role", () => {
    permissionMock.mockReturnValue({
      canManageEmbeddedIntegrations: () => true,
      isCheckingPermissions: false,
    });

    render(<WorkspaceEmbeddedIntegrationsSection workspaceId="ws-1" />);

    expect(
      screen.getByRole("region", { name: "embedded:settings.sectionTitle" }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("embedded-integrations-settings"),
    ).toHaveTextContent("ws-1");
  });
});
