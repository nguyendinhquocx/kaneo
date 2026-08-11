import { render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "user-1" } } }),
  },
}));

vi.mock("@kaneo/libs", () => ({
  windowId: "test-window-id",
}));

import { getWsUrl, useProjectWebSocket } from "./use-project-websocket";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {}
}

function WebSocketHarness() {
  useProjectWebSocket("project-1");
  return null;
}

describe("getWsUrl", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_API_URL", "http://localhost:1337");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.instances = [];
    mocks.invalidateQueries.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("builds a ws:// URL from an http API base", () => {
    expect(getWsUrl("project-123")).toBe(
      "ws://localhost:1337/api/ws/project-123?windowId=test-window-id",
    );
  });

  it("builds a wss:// URL from an https API base", () => {
    vi.stubEnv("VITE_API_URL", "https://example.com");
    expect(getWsUrl("project-123")).toBe(
      "wss://example.com/api/ws/project-123?windowId=test-window-id",
    );
  });

  it("does not append /api when the base already ends with /api", () => {
    vi.stubEnv("VITE_API_URL", "https://example.com/api");
    expect(getWsUrl("p1")).toBe(
      "wss://example.com/api/ws/p1?windowId=test-window-id",
    );
  });

  it("trims trailing slashes from the API base", () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:1337///");
    expect(getWsUrl("p1")).toBe(
      "ws://localhost:1337/api/ws/p1?windowId=test-window-id",
    );
  });

  it("URL-encodes the projectId", () => {
    expect(getWsUrl("a b/c?d")).toBe(
      "ws://localhost:1337/api/ws/a%20b%2Fc%3Fd?windowId=test-window-id",
    );
  });

  it("invalidates task runs and evidence when a run update arrives", () => {
    const { unmount } = render(createElement(WebSocketHarness));
    const ws = FakeWebSocket.instances[0];

    ws.onmessage?.({
      data: JSON.stringify({
        type: "TASK_RUN_UPDATED",
        taskId: "task-1",
        runId: "run-1",
      }),
    });

    expect(mocks.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ["execution-runs", "task-1"],
    });
    expect(mocks.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ["execution-run-evidence", "task-1", "run-1"],
    });

    unmount();
  });
});
