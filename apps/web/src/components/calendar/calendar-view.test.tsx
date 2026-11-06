import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CalendarView, { CalendarHeaderActions } from "./calendar-view";

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

    expect(
      screen.getByText("embedded:settings.serviceNotConfigured"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-embedded-frame")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders the embedded frame without a redundant notice or toolbar", () => {
    mockConfig({
      data: {
        mitra: {
          enabled: true,
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

    expect(screen.queryByText("embedded:embeddedNotice")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "embedded:reload" }),
    ).toBeNull();
  });

  it("hides the calendar when the workspace toggle is off", () => {
    mockConfig({
      data: {
        mitra: { enabled: false },
        wisemapping: null,
      },
    });

    render(<CalendarView workspaceId="ws-1" />);

    expect(
      screen.getByText("embedded:calendarDisabledByWorkspace"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-embedded-frame")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("does not render a frame in open-only mode and links out instead", () => {
    mockConfig({
      data: {
        mitra: {
          enabled: true,
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
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("CalendarHeaderActions", () => {
  it("provides text-only open and reload actions in the header", () => {
    const onReload = vi.fn();
    const { container } = render(
      <CalendarHeaderActions
        baseUrl="https://calendar.internal.example"
        showReload
        onReload={onReload}
      />,
    );

    const openLink = screen.getByRole("link", {
      name: "embedded:openCalendar",
    });
    expect(openLink).toHaveAttribute(
      "href",
      "https://calendar.internal.example",
    );
    expect(openLink).toHaveAttribute("target", "_blank");
    expect(openLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      screen.getByRole("button", { name: "embedded:reload" }),
    ).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "embedded:reload" }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("keeps reload hidden in open-only mode", () => {
    render(
      <CalendarHeaderActions
        baseUrl="https://calendar.internal.example"
        showReload={false}
        onReload={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("link", { name: "embedded:openCalendar" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "embedded:reload" }),
    ).toBeNull();
  });
});
