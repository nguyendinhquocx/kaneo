import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EmbeddedIntegrationsSettings from "./embedded-integrations-settings";

const configMock = vi.hoisted(() => vi.fn());
const mutateAsync = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock(
  "@/hooks/queries/embedded-integration/use-embedded-services-config",
  () => ({
    default: (...args: unknown[]) => configMock(...args),
  }),
);

vi.mock(
  "@/hooks/queries/embedded-integration/use-set-embedded-service-enabled",
  () => ({
    default: () => ({ mutateAsync, isPending: false }),
  }),
);

afterEach(() => {
  cleanup();
  configMock.mockReset();
  mutateAsync.mockReset();
});

describe("EmbeddedIntegrationsSettings", () => {
  it("shows configured service switches and persists the requested state", async () => {
    configMock.mockReturnValue({
      data: {
        mitra: {
          enabled: true,
          baseUrl: "https://calendar.internal.example",
          viewMode: "embedded",
        },
        wisemapping: { enabled: false },
      },
      isLoading: false,
      isError: false,
    });
    mutateAsync.mockResolvedValue(undefined);

    render(<EmbeddedIntegrationsSettings workspaceId="ws-1" />);

    const calendarSwitch = screen.getByRole("switch", {
      name: /settings\.mitraLabel/,
    });
    const mapSwitch = screen.getByRole("switch", {
      name: /settings\.wisemappingLabel/,
    });
    expect(calendarSwitch).toHaveAttribute("aria-checked", "true");
    expect(mapSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(mapSwitch);
    expect(mutateAsync).toHaveBeenCalledWith({
      service: "wisemapping",
      enabled: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "settings.saveSuccess",
      ),
    );
  });

  it("explains when neither service is configured and renders no toggle", () => {
    configMock.mockReturnValue({
      data: { mitra: null, wisemapping: null },
      isLoading: false,
      isError: false,
    });

    render(<EmbeddedIntegrationsSettings workspaceId="ws-1" />);

    expect(
      screen.getByText("settings.serviceNotConfigured"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
