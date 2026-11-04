import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CalendarView from "./calendar-view";

const refetch = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => `embedded:${key}` }),
}));

const configMock = vi.hoisted(() => vi.fn());

vi.mock(
  "@/hooks/queries/embedded-integration/use-embedded-services-config",
  () => ({
    default: (...args: unknown[]) => configMock(...args),
  }),
);

function mockConfig(payload: {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
}) {
  configMock.mockReturnValue({
    data: payload.data ?? null,
    isLoading: payload.isLoading ?? false,
    isError: payload.isError ?? false,
    refetch,
  });
}

afterEach(() => {
  cleanup();
  configMock.mockReset();
});

describe("CalendarView", () => {
  it("does not render a frame when the service is not configured", () => {
    mockConfig({ data: { mitra: null, wisemapping: null } });

    render(<CalendarView workspaceId="ws-1" />);

    expect(screen.getByText("embedded:calendarDisabled")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-embedded-frame")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders the embedded frame with an accessible title and login escape hatch", () => {
    mockConfig({
      data: {
        mitra: {
          baseUrl: "https://calendar.internal.example",
          viewMode: "embedded",
        },
        wisemapping: null,
      },
    });

    render(<CalendarView workspaceId="ws-1" />);

    const frame = screen.getByTestId("calendar-embedded-frame");
    expect(frame).toHaveAttribute("title", "embedded:calendarFrameTitle");
    expect(frame).toHaveAttribute("src", "https://calendar.internal.example");

    const openLink = screen.getByRole("link", {
      name: "embedded:openExternallyForLogin",
    });
    expect(openLink).toHaveAttribute(
      "href",
      "https://calendar.internal.example",
    );
    expect(openLink).toHaveAttribute("target", "_blank");
    expect(openLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does not render a frame in open-only mode and links out instead", () => {
    mockConfig({
      data: {
        mitra: {
          baseUrl: "https://calendar.internal.example",
          viewMode: "open-only",
        },
        wisemapping: null,
      },
    });

    render(<CalendarView workspaceId="ws-1" />);

    expect(
      screen.getByText("embedded:calendarOpenOnlyNotice"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-embedded-frame")).toBeNull();
    const openLink = screen.getByRole("link", {
      name: "embedded:openExternally",
    });
    expect(openLink).toHaveAttribute("target", "_blank");
  });
});
