import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useUserPreferencesStore } from "@/store/user-preferences";

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

const STORAGE_KEY = "user-preferences";

function readPersistedState(): Record<string, unknown> | undefined {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return undefined;
  return (JSON.parse(raw) as { state: Record<string, unknown> }).state;
}

function OpenStateProbe() {
  const { open } = useSidebar();
  return <div data-testid="sidebar-open">{String(open)}</div>;
}

// Bridges the store into the provider exactly like the app layout does.
function ControlledSidebarBridge() {
  const sidebarOpen = useUserPreferencesStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUserPreferencesStore((s) => s.setSidebarOpen);
  return (
    <SidebarProvider onOpenChange={setSidebarOpen} open={sidebarOpen}>
      <SidebarTrigger />
      <OpenStateProbe />
    </SidebarProvider>
  );
}

afterEach(cleanup);

describe("sidebar persistence (user-preferences store)", () => {
  beforeEach(() => {
    localStorage.clear();
    useUserPreferencesStore.setState({ sidebarOpen: true });
  });

  it("persists a closed sidebar and restores it after a reload", async () => {
    useUserPreferencesStore.getState().setSidebarOpen(false);
    expect(useUserPreferencesStore.getState().sidebarOpen).toBe(false);
    expect(readPersistedState()?.sidebarOpen).toBe(false);

    // rehydrate() is the same code path a page load uses: storage wins over
    // the in-memory default.
    await useUserPreferencesStore.persist.rehydrate();
    expect(useUserPreferencesStore.getState().sidebarOpen).toBe(false);
  });

  it("persists an open sidebar and restores it after a reload", async () => {
    useUserPreferencesStore.getState().setSidebarOpen(true);
    expect(readPersistedState()?.sidebarOpen).toBe(true);

    await useUserPreferencesStore.persist.rehydrate();
    expect(useUserPreferencesStore.getState().sidebarOpen).toBe(true);
  });

  it("keeps the state across provider remounts via the store", () => {
    useUserPreferencesStore.setState({ sidebarOpen: false });

    const { unmount } = render(<ControlledSidebarBridge />);
    expect(screen.getByTestId("sidebar-open")).toHaveTextContent("false");
    unmount();

    render(<ControlledSidebarBridge />);
    expect(screen.getByTestId("sidebar-open")).toHaveTextContent("false");
  });

  it("toggle updates the shared store state immediately", () => {
    render(<ControlledSidebarBridge />);
    expect(screen.getByTestId("sidebar-open")).toHaveTextContent("true");

    fireEvent.click(screen.getByRole("button", { name: /toggle sidebar/i }));

    expect(useUserPreferencesStore.getState().sidebarOpen).toBe(false);
    expect(screen.getByTestId("sidebar-open")).toHaveTextContent("false");
    expect(readPersistedState()?.sidebarOpen).toBe(false);
  });

  it("settings store writes are visible to the sidebar immediately", () => {
    useUserPreferencesStore.setState({ sidebarOpen: false });
    render(<ControlledSidebarBridge />);
    expect(screen.getByTestId("sidebar-open")).toHaveTextContent("false");

    // The account preferences switch calls the same store setter.
    act(() => {
      useUserPreferencesStore.getState().setSidebarOpen(true);
    });

    expect(screen.getByTestId("sidebar-open")).toHaveTextContent("true");
    expect(readPersistedState()?.sidebarOpen).toBe(true);
  });

  it("migrates the legacy sidebarDefaultOpen preference into the current state", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { sidebarDefaultOpen: false },
        version: 0,
      }),
    );

    await useUserPreferencesStore.persist.rehydrate();

    expect(useUserPreferencesStore.getState().sidebarOpen).toBe(false);
  });
});

describe("mobile drawer state", () => {
  beforeEach(() => {
    localStorage.clear();
    useUserPreferencesStore.setState({ sidebarOpen: true });
  });

  it("is not persisted: opening the drawer never writes the sidebar key", async () => {
    const { useIsMobile } = await import("@/hooks/use-mobile");
    vi.mocked(useIsMobile).mockReturnValue(true);

    // The drawer state lives in the provider, not in the persisted store, so
    // probe the provider context directly.
    function MobileProbe() {
      const { openMobile, setOpenMobile } = useSidebar();
      return (
        <>
          <div data-testid="mobile-open">{String(openMobile)}</div>
          <button
            data-testid="open-drawer"
            onClick={() => setOpenMobile(true)}
            type="button"
          >
            open
          </button>
        </>
      );
    }

    render(
      <SidebarProvider>
        <MobileProbe />
      </SidebarProvider>,
    );
    expect(screen.getByTestId("mobile-open")).toHaveTextContent("false");

    fireEvent.click(screen.getByTestId("open-drawer"));
    expect(screen.getByTestId("mobile-open")).toHaveTextContent("true");

    // The desktop open state stays untouched by the mobile drawer.
    expect(readPersistedState()?.sidebarOpen ?? true).toBe(true);
  });
});
