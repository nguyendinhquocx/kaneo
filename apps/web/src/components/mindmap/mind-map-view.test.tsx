import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWiseMappingMapId } from "./map-url";
import MindMapView from "./mind-map-view";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => `embedded:${key}` }),
}));

const configMock = vi.hoisted(() => vi.fn());
const bindingMock = vi.hoisted(() => vi.fn());
const canManageMock = vi.hoisted(() => vi.fn());
const linkMutate = vi.hoisted(() => vi.fn());
const unlinkMutate = vi.hoisted(() => vi.fn());

vi.mock(
  "@/hooks/queries/embedded-integration/use-embedded-services-config",
  () => ({
    default: (...args: unknown[]) => configMock(...args),
  }),
);

vi.mock("@/hooks/queries/embedded-integration/use-mind-map-binding", () => ({
  default: (...args: unknown[]) => bindingMock(...args),
}));

vi.mock("@/hooks/queries/embedded-integration/use-mind-map-mutations", () => ({
  useLinkMindMap: () => ({
    mutate: linkMutate,
    isPending: false,
    isError: false,
  }),
  useUnlinkMindMap: () => ({
    mutate: unlinkMutate,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageEmbeddedIntegrations: canManageMock,
    isCheckingPermissions: false,
  }),
}));

function mockConfig(wisemapping: unknown) {
  configMock.mockReturnValue({
    data: { mitra: null, wisemapping },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

function mockBinding(mapId: string | null) {
  bindingMock.mockReturnValue({
    data: mapId === null ? null : { mapId },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
}

afterEach(() => {
  cleanup();
  configMock.mockReset();
  bindingMock.mockReset();
  canManageMock.mockReset();
  linkMutate.mockReset();
  unlinkMutate.mockReset();
});

describe("parseWiseMappingMapId", () => {
  const baseUrl = "https://maps.internal.example/team/maps";

  it("accepts a raw map ID", () => {
    expect(parseWiseMappingMapId("map-42", baseUrl)).toBe("map-42");
  });

  it("extracts the ID from the configured editor route", () => {
    expect(
      parseWiseMappingMapId(
        "https://maps.internal.example/team/maps/c/maps/map-42/edit",
        baseUrl,
      ),
    ).toBe("map-42");
  });

  it("decodes an encoded map ID from the editor route", () => {
    expect(
      parseWiseMappingMapId(
        "https://maps.internal.example/team/maps/c/maps/b%C3%A0n-%C4%91%E1%BB%93-1/edit",
        baseUrl,
      ),
    ).toBe("bàn-đồ-1");
  });

  it.each([
    ["another origin", "https://foreign.example/team/maps/c/maps/map-42/edit"],
    [
      "an unrelated route",
      "https://maps.internal.example/team/maps/c/maps/map-42/view",
    ],
    [
      "a route outside the configured base path",
      "https://maps.internal.example/c/maps/map-42/edit",
    ],
    [
      "an extra path segment",
      "https://maps.internal.example/team/maps/c/maps/map-42/edit/extra",
    ],
    [
      "an invalid encoded ID",
      "https://maps.internal.example/team/maps/c/maps/%E0%A4%A/edit",
    ],
  ])("rejects %s", (_description, input) => {
    expect(parseWiseMappingMapId(input, baseUrl)).toBeNull();
  });

  it.each(["", "   ", "map/id", "https://maps.internal.example/"])(
    "rejects empty or invalid input %j",
    (input) => {
      expect(parseWiseMappingMapId(input, baseUrl)).toBeNull();
    },
  );
});

describe("MindMapView", () => {
  it("shows a disabled notice without any frame when the service is not configured", () => {
    mockConfig(null);
    mockBinding(null);
    canManageMock.mockReturnValue(false);

    render(<MindMapView projectId="p-1" workspaceId="ws-1" />);

    expect(
      screen.getByText("embedded:settings.serviceNotConfigured"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mindmap-embedded-frame")).toBeNull();
  });

  it("hides Mind Map when the workspace toggle is off", () => {
    mockConfig({ enabled: false });
    mockBinding(null);
    canManageMock.mockReturnValue(true);

    render(<MindMapView projectId="p-1" workspaceId="ws-1" />);

    expect(
      screen.getByText("embedded:mindMapDisabledByWorkspace"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mindmap-link-form")).toBeNull();
    expect(screen.queryByTestId("mindmap-embedded-frame")).toBeNull();
  });

  it("shows only a plain notice for members when the map is unlinked", () => {
    mockConfig({
      enabled: true,
      baseUrl: "https://maps.internal.example",
      viewMode: "embedded",
    });
    mockBinding(null);
    canManageMock.mockReturnValue(false);

    render(<MindMapView projectId="p-1" workspaceId="ws-1" />);

    expect(screen.getByTestId("mindmap-unlinked")).toBeInTheDocument();
    expect(screen.queryByTestId("mindmap-link-form")).toBeNull();
    expect(screen.queryByTestId("mindmap-embedded-frame")).toBeNull();
  });

  it("offers the link form to managers when the map is unlinked", () => {
    mockConfig({
      enabled: true,
      baseUrl: "https://maps.internal.example/team/maps",
      viewMode: "embedded",
    });
    mockBinding(null);
    canManageMock.mockReturnValue(true);

    render(<MindMapView projectId="p-1" workspaceId="ws-1" />);

    expect(screen.getByTestId("mindmap-link-form")).toBeInTheDocument();
    expect(screen.queryByTestId("mindmap-embedded-frame")).toBeNull();

    const openLink = screen.getByRole("link", {
      name: "embedded:openWiseMapping",
    });
    expect(openLink).toHaveAttribute(
      "href",
      "https://maps.internal.example/team/maps",
    );
    expect(openLink).toHaveAttribute("target", "_blank");
    expect(openLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      screen.getByText("embedded:mindMapCreateThenLink"),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("embedded:mapIdLabel"), {
      target: { value: "map-42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "embedded:linkMap" }));

    expect(linkMutate).toHaveBeenCalledWith("map-42", expect.anything());
  });

  it("accepts a same-origin editor URL and links the extracted raw ID", () => {
    mockConfig({
      enabled: true,
      baseUrl: "https://maps.internal.example",
      viewMode: "embedded",
    });
    mockBinding(null);
    canManageMock.mockReturnValue(true);

    render(<MindMapView projectId="p-1" workspaceId="ws-1" />);

    fireEvent.change(screen.getByLabelText("embedded:mapIdLabel"), {
      target: {
        value: "https://maps.internal.example/c/maps/map-42/edit",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "embedded:linkMap" }));

    expect(linkMutate).toHaveBeenCalledWith("map-42", expect.anything());
  });

  it("does not link a map URL from another origin", () => {
    mockConfig({
      enabled: true,
      baseUrl: "https://maps.internal.example",
      viewMode: "embedded",
    });
    mockBinding(null);
    canManageMock.mockReturnValue(true);

    render(<MindMapView projectId="p-1" workspaceId="ws-1" />);

    fireEvent.change(screen.getByLabelText("embedded:mapIdLabel"), {
      target: {
        value: "https://foreign.example/c/maps/map-42/edit",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "embedded:linkMap" }));

    expect(linkMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "embedded:mapIdInvalid",
    );
  });

  it("embeds the linked map with the id encoded exactly once", () => {
    mockConfig({
      enabled: true,
      baseUrl: "https://maps.internal.example",
      viewMode: "embedded",
    });
    mockBinding("bàn-đồ-1");
    canManageMock.mockReturnValue(false);

    render(<MindMapView projectId="p-1" workspaceId="ws-1" />);

    const frame = screen.getByTestId("mindmap-embedded-frame");
    expect(frame).toHaveAttribute(
      "src",
      "https://maps.internal.example/c/maps/b%C3%A0n-%C4%91%E1%BB%93-1/edit",
    );
    expect(frame).toHaveAttribute("title", "embedded:mindMapFrameTitle");
  });

  it("does not render a frame in open-only mode and links to the editor instead", () => {
    mockConfig({
      enabled: true,
      baseUrl: "https://maps.internal.example",
      viewMode: "open-only",
    });
    mockBinding("map-9");
    canManageMock.mockReturnValue(false);

    render(<MindMapView projectId="p-1" workspaceId="ws-1" />);

    expect(
      screen.getByText("embedded:mindMapOpenOnlyNotice"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mindmap-embedded-frame")).toBeNull();

    const openLink = screen.getByRole("link", {
      name: "embedded:openExternally",
    });
    expect(openLink).toHaveAttribute(
      "href",
      "https://maps.internal.example/c/maps/map-9/edit",
    );
    expect(openLink).toHaveAttribute("target", "_blank");
  });
});
