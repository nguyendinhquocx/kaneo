import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({
  detailMatch: true,
  queryCalls: 0,
  queryEnabled: true as boolean | undefined,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { enabled?: boolean }) => {
    routeState.queryCalls += 1;
    routeState.queryEnabled = options.enabled;
    return { isPending: true, isError: false, data: undefined };
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useParams: () => ({ token: "test-token" }),
  }),
  Outlet: () => <div data-testid="task-detail-outlet" />,
  useMatchRoute: () => () =>
    routeState.detailMatch ? { token: "test-token", taskId: "task-1" } : false,
}));
vi.mock("@/components/share/task-share-board", () => ({
  default: () => <div data-testid="task-share-board" />,
}));
vi.mock("@/components/share/share-capability", () => ({
  ShareCapabilityProvider: ({ children }: { children: React.ReactNode }) => children,
  setShareCapabilityProjectId: vi.fn(),
}));
vi.mock("@/components/share/share-link-state", () => ({
  default: () => <div data-testid="share-link-state" />,
}));

afterEach(() => {
  cleanup();
  routeState.detailMatch = true;
  routeState.queryCalls = 0;
  routeState.queryEnabled = true;
});

describe("task share detail route outlet", () => {
  it("renders the child detail route instead of leaving the landing board mounted", async () => {
    const { Route } = await import("./$token");
    const Component = Route.options.component as ComponentType;

    render(<Component />);

    expect(screen.getByTestId("task-detail-outlet")).toBeVisible();
    expect(screen.queryByTestId("task-share-board")).toBeNull();
    // Parent keeps hook order stable but does not fetch its landing payload
    // while the nested detail route is active.
    expect(routeState.queryCalls).toBe(1);
    expect(routeState.queryEnabled).toBe(false);
  });
});
