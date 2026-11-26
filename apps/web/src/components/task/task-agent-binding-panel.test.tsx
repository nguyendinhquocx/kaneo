import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRosterEntry } from "@/fetchers/agent-session/agent-session-roster";
import TaskAgentBindingPanel, {
  PENDING_DISCONNECT_MS,
  resolvePendingStatus,
} from "./task-agent-binding-panel";

// SPEC-2026-11-25-kaneo-ui-agent-binding T3: the 3-state Agents panel.
// i18n is resolved against the real en-US reference so the assertions read
// the same strings the UI ships.

const bindingQuery = vi.hoisted(() => ({
  data: null as null | {
    bound: boolean;
    online: boolean;
    hostId?: string;
    bindingId?: string;
    sessionId?: string;
    bindingGeneration?: number;
  },
  isLoading: false,
  isError: false,
}));

const rosterQuery = vi.hoisted(() => ({
  data: null as null | { sessions: AgentSessionRosterEntry[] },
  isLoading: false,
  isError: false,
  isStale: true,
  enabled: undefined as boolean | undefined,
  refetch: vi.fn(async () => ({}) as never),
}));

const taskQuery = vi.hoisted(() => ({
  data: { id: "task-1", number: 1, title: "Panel card" } as
    | { id: string; number: number; title: string }
    | undefined,
}));

const bindMutation = vi.hoisted(() => ({
  mutateAsync: vi.fn(async () => ({
    bindingId: "binding-new",
    bindingGeneration: 2,
    taskId: "task-1",
    projectId: "project-1",
    sessionId: "s-laptop-1",
    hostId: "pi-laptop",
    status: "active",
    revision: 1,
  })),
  isPending: false,
}));

const unbindMutation = vi.hoisted(() => ({
  mutateAsync: vi.fn(async () => ({ unbound: true })),
  isPending: false,
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), message: vi.fn() }));

vi.mock("@/hooks/queries/agent-session/use-get-task-binding-status", () => ({
  useGetTaskBindingStatus: () => bindingQuery,
}));
vi.mock("@/hooks/queries/task/use-get-task", () => ({
  default: () => ({ data: taskQuery.data }),
}));
vi.mock("@/hooks/queries/agent-session/use-get-agent-session-roster", () => ({
  useGetAgentSessionRoster: (options?: { enabled?: boolean }) => {
    rosterQuery.enabled = options?.enabled;
    return rosterQuery;
  },
}));
vi.mock("@/hooks/mutations/agent-session/use-bind-agent-session", () => ({
  useBindAgentSession: () => bindMutation,
}));
vi.mock("@/hooks/mutations/agent-session/use-unbind-agent-session", () => ({
  useUnbindAgentSession: () => unbindMutation,
}));
vi.mock("@/lib/toast", () => ({ toast }));

vi.mock("react-i18next", async () => {
  const enUS = (await import("@i18n/en-US.json")).default as Record<
    string,
    unknown
  >;
  const dict: Record<string, string> = {};
  const flatten = (node: unknown, prefix: string) => {
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(
        node as Record<string, unknown>,
      )) {
        flatten(value, `${prefix}${key}.`);
      }
    } else {
      dict[prefix.slice(0, -1)] = String(node);
    }
  };
  for (const namespace of ["tasks", "common"] as const) {
    flatten(enUS[namespace], `${namespace}:`);
  }
  return {
    useTranslation: () => ({
      t: (key: string, vars?: Record<string, unknown>) => {
        let out = dict[key] ?? key;
        if (vars) {
          for (const [name, value] of Object.entries(vars)) {
            out = out.replaceAll(`{{${name}}}`, String(value));
          }
        }
        return out;
      },
    }),
  };
});

function session(
  overrides: Partial<AgentSessionRosterEntry>,
): AgentSessionRosterEntry {
  const now = Date.now();
  return {
    sessionId: "s-x",
    host: "pi-laptop",
    title: "a session",
    cwd: "D:/work/app",
    model: "glm-5.3-flash",
    lastSeenAt: new Date(now - 30_000).toISOString(),
    agentPrincipalId: "principal-1",
    binding: null,
    ...overrides,
  };
}

const liveLaptop = (overrides: Partial<AgentSessionRosterEntry> = {}) =>
  session({
    sessionId: "s-laptop-1",
    host: "pi-laptop",
    title: "fix kaneo build",
    cwd: "D:/work/kaneo",
    model: "glm-5.3-flash",
    ...overrides,
  });

const liveDeskBound = () =>
  session({
    sessionId: "s-desk-1",
    host: "prodesk-home",
    title: "desk work",
    cwd: "/srv/ops",
    model: "luna",
    binding: {
      taskId: "task-other",
      taskTitle: "Other card",
      taskNumber: 7,
    },
  });

beforeEach(() => {
  bindingQuery.data = { bound: false, online: false };
  rosterQuery.data = { sessions: [] };
  rosterQuery.isLoading = false;
  rosterQuery.isError = false;
  rosterQuery.isStale = true;
  rosterQuery.enabled = undefined;
  taskQuery.data = { id: "task-1", number: 1, title: "Panel card" };
  rosterQuery.refetch.mockClear();
  bindMutation.mutateAsync.mockClear();
  unbindMutation.mutateAsync.mockClear();
  toast.error.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("TaskAgentBindingPanel (SPEC-2026-11-25 T3)", () => {
  it("S0 renders no node in either layout when unbound and the roster is empty", () => {
    for (const layout of ["block", "row"] as const) {
      const { container } = render(
        <TaskAgentBindingPanel taskId="task-1" layout={layout} />,
      );
      expect(container).toBeEmptyDOMElement();
      cleanup();
    }
  });

  it("S0 also holds while the roster is still loading (no flash, no poll)", () => {
    rosterQuery.isLoading = true;
    const { container } = render(
      <TaskAgentBindingPanel taskId="task-1" layout="block" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("S1 renders the quiet Agents trigger with the live-session count in its accessible name", () => {
    rosterQuery.data = { sessions: [liveLaptop(), liveDeskBound()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    const button = screen.getByRole("button", {
      name: "Assign agent · 2 running",
    });
    expect(button).toBeVisible();
    // No chevron, no count text on-screen — the visible label is just Agents.
    expect(button.querySelector("svg")).toBeNull();
    expect(screen.queryByText("2 running")).toBeNull();
    expect(screen.getByText("Agents")).toBeVisible();
  });

  it("opening the picker refetches only when the roster cache is stale", async () => {
    rosterQuery.data = { sessions: [liveLaptop()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    await screen.findByText("fix kaneo build");
    expect(rosterQuery.refetch).toHaveBeenCalledTimes(1);

    rosterQuery.isStale = false;
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ })); // close
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ })); // reopen
    await vi.waitFor(() => {
      expect(rosterQuery.refetch).toHaveBeenCalledTimes(1);
    });
  });

  it("S1 popover groups sessions by host and offers both", async () => {
    rosterQuery.data = { sessions: [liveLaptop(), liveDeskBound()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    // Host group headers (getAllByText: the badge may repeat the host).
    expect((await screen.findAllByText("pi-laptop")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("prodesk-home").length).toBeGreaterThan(0);
    expect(screen.getByText("fix kaneo build")).toBeVisible();
    expect(screen.getByText("desk work")).toBeVisible();
  });

  it("re-filters an open picker at the nearest local TTL expiry without polling", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-11-25T12:00:00.000Z").getTime();
    vi.setSystemTime(now);
    rosterQuery.isStale = false;
    rosterQuery.data = {
      sessions: [
        liveLaptop({
          title: "expires soon",
          lastSeenAt: new Date(now - 5 * 60_000 + 1_000).toISOString(),
        }),
      ],
    };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    expect(screen.getByText("expires soon")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText("expires soon")).toBeNull();
    expect(rosterQuery.refetch).not.toHaveBeenCalled();
  });

  it("S1 never offers an offline session for binding", async () => {
    rosterQuery.data = {
      sessions: [
        liveLaptop(),
        session({
          sessionId: "s-dead",
          title: "sleepy session",
          lastSeenAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        }),
      ],
    };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    expect(await screen.findByText("fix kaneo build")).toBeVisible();
    expect(screen.queryByText("sleepy session")).toBeNull();
  });

  it("initial roster errors show an accessible retry, then preserve S0 on successful empty response", async () => {
    rosterQuery.data = { sessions: [] };
    rosterQuery.isError = true;
    const { container, rerender } = render(
      <TaskAgentBindingPanel taskId="task-1" layout="block" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't load live sessions",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(rosterQuery.refetch).toHaveBeenCalledTimes(1);

    rosterQuery.isError = false;
    rerender(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("S1 popover shows a spinner row while loading and an error row with retry", async () => {
    rosterQuery.data = { sessions: [liveLaptop()] };
    rosterQuery.isLoading = true;
    const { rerender } = render(
      <TaskAgentBindingPanel taskId="task-1" layout="block" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    expect(await screen.findByText("Loading…")).toBeVisible();

    // The popover stays open across the refetch; the error row replaces the
    // spinner without a second trigger click (that would close the popover).
    rosterQuery.isLoading = false;
    rosterQuery.isError = true;
    rerender(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(
      await screen.findByText("Couldn't load live sessions"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(rosterQuery.refetch).toHaveBeenCalled();
  });

  it("S1 search box appears at 8+ sessions and filters by title, host, and cwd", async () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      session({
        sessionId: `s-${index}`,
        title: `session ${index}`,
        host: index === 8 ? "prodesk-home" : "pi-laptop",
        cwd: `D:/work/proj-${index}`,
      }),
    );
    rosterQuery.data = { sessions: many };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    const search = await screen.findByRole("textbox", {
      name: "Search sessions…",
    });
    expect(search).toBeVisible();
    // Search sits outside the scroll container: scrolled rows can never
    // bleed under it, and it renders no visible placeholder hint.
    expect(search.closest(".overflow-y-auto")).toBeNull();
    expect(search).not.toHaveAttribute("placeholder");
    fireEvent.change(search, { target: { value: "proj-3" } });
    expect(screen.getByText("session 3")).toBeVisible();
    expect(screen.queryByText("session 4")).toBeNull();
    // Host names are searchable too.
    fireEvent.change(search, { target: { value: "prodesk-home" } });
    expect(screen.getByText("session 8")).toBeVisible();
    expect(screen.queryByText("session 3")).toBeNull();
  });

  it("search box is hidden below 8 sessions", async () => {
    rosterQuery.data = { sessions: [liveLaptop(), liveDeskBound()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    await screen.findByText("fix kaneo build");
    expect(
      screen.queryByRole("textbox", { name: "Search sessions…" }),
    ).toBeNull();
  });

  it("S1 binding an unbound session is a single POST with the roster principal", async () => {
    rosterQuery.data = { sessions: [liveLaptop()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    fireEvent.click(await screen.findByText("fix kaneo build"));
    expect(bindMutation.mutateAsync).toHaveBeenCalledTimes(1);
    expect(bindMutation.mutateAsync).toHaveBeenCalledWith({
      taskId: "task-1",
      agentPrincipalId: "principal-1",
      sessionId: "s-laptop-1",
    });
  });

  it("rebinding a bound session requires one confirm naming the target session, then a single POST", async () => {
    rosterQuery.data = { sessions: [liveDeskBound()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    fireEvent.click(await screen.findByText("desk work"));

    // One confirm dialog; the target session name is the only context.
    expect(await screen.findByText("Rebind this session?")).toBeVisible();
    // The session name appears in the row AND as the dialog's sole context.
    expect(screen.getAllByText("desk work").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("/srv/ops · luna · prodesk-home")).toBeNull();
    expect(screen.queryByText("Affected card: #7 Other card")).toBeNull();

    expect(bindMutation.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change session" }));
    await vi.waitFor(() => {
      expect(bindMutation.mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(bindMutation.mutateAsync).toHaveBeenCalledWith({
      taskId: "task-1",
      agentPrincipalId: "principal-1",
      sessionId: "s-desk-1",
    });
    // Exactly one write: no DELETE-then-POST dance.
    expect(unbindMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("bound session title is a plain span with a full-text title attribute", () => {
    const title = "a long bound session title that can be truncated";
    bindingQuery.data = {
      bound: true,
      online: true,
      hostId: "pi-laptop",
      bindingId: "binding-1",
      sessionId: "s-laptop-1",
      bindingGeneration: 1,
    };
    rosterQuery.data = { sessions: [liveLaptop({ title })] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    const titleNode = screen.getByText(title);
    // No interactive role: the title has no action, so it must not trap Tab.
    expect(titleNode.tagName).toBe("SPAN");
    expect(titleNode).toHaveAttribute("title", title);
    expect(titleNode.closest("button, a, input")).toBeNull();
  });

  it("S2 shows one quiet row: dot, title, host hint, actions (no status text)", () => {
    bindingQuery.data = {
      bound: true,
      online: true,
      hostId: "pi-laptop",
      bindingId: "binding-1",
      sessionId: "s-laptop-1",
      bindingGeneration: 1,
    };
    rosterQuery.data = { sessions: [liveLaptop()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(screen.getByText("fix kaneo build")).toBeVisible();
    // Host is a plain right-aligned hint in the SAME row; no status text.
    expect(screen.getByText("pi-laptop")).toBeVisible();
    // Connectivity lives in the dot + an sr-only state label, never a row.
    const sr = document.querySelector(".sr-only");
    expect(sr?.textContent).toBe("Pi connected");
    expect(document.querySelector("[role='status']")).toBeNull();
    expect(screen.getByRole("button", { name: "Unbind" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Change session" }),
    ).toBeVisible();
  });

  it("a bound card loads matching roster metadata on mount and uses it in the unbind confirm", async () => {
    bindingQuery.data = {
      bound: true,
      online: false,
      hostId: "pi-laptop",
      bindingId: "binding-cold",
      sessionId: "s-laptop-1",
      bindingGeneration: 4,
    };
    rosterQuery.data = {
      sessions: [
        liveLaptop({ sessionId: "s-other", title: "wrong session" }),
        liveLaptop(),
      ],
    };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(rosterQuery.enabled).not.toBe(false);
    expect(screen.getByText("fix kaneo build")).toBeVisible();
    // Model names are not part of the panel anymore; identity is title + host.
    expect(screen.queryByText("glm-5.3-flash")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Unbind" }));
    // Trimmed confirm: no cwd/model/host re-description block.
    expect(
      screen.queryByText("D:/work/kaneo · glm-5.3-flash · pi-laptop"),
    ).toBeNull();
  });

  it("S2 falls back explicitly when the bound session is absent from the live roster", () => {
    bindingQuery.data = {
      bound: true,
      online: false,
      hostId: "prodesk-home",
      bindingId: "binding-2",
      sessionId: "s-unknown",
      bindingGeneration: 3,
    };
    rosterQuery.data = { sessions: [] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    // No cache entry: the raw id is the honest fallback.
    expect(screen.getByText("s-unknown")).toBeVisible();
    expect(screen.getByText("prodesk-home")).toBeVisible();
    expect(screen.queryByText("Session details unavailable")).toBeNull();
  });

  it("an offline bound session keeps its remembered name instead of the raw id", () => {
    window.localStorage.setItem(
      "kaneo:session-titles",
      JSON.stringify({ "s-offline-1": "remembered session" }),
    );
    bindingQuery.data = {
      bound: true,
      online: false,
      hostId: "pi-laptop",
      bindingId: "binding-off",
      sessionId: "s-offline-1",
      bindingGeneration: 7,
    };
    rosterQuery.data = { sessions: [] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(screen.getByText("remembered session")).toBeVisible();
    expect(screen.queryByText("s-offline-1")).toBeNull();
    window.localStorage.clear();
  });

  it("S2 unbind requires a confirm, then deletes with the exact binding identity", async () => {
    bindingQuery.data = {
      bound: true,
      online: true,
      hostId: "pi-laptop",
      bindingId: "binding-1",
      sessionId: "s-laptop-1",
      bindingGeneration: 1,
    };
    rosterQuery.data = { sessions: [liveLaptop()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: "Unbind" }));
    expect(
      await screen.findByText("Unbind the agent from this card?"),
    ).toBeVisible();
    // Trimmed confirm: no re-description block, no affected-card line.
    expect(
      screen.queryByText(
        "Session s-laptop-1 will stop syncing this card and its subtasks.",
      ),
    ).toBeNull();
    expect(screen.queryByText("Affected card: #1 Panel card")).toBeNull();
    expect(unbindMutation.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unbind" }));
    await vi.waitFor(() => {
      expect(unbindMutation.mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(unbindMutation.mutateAsync).toHaveBeenCalledWith({
      bindingId: "binding-1",
      sessionId: "s-laptop-1",
      generation: 1,
    });
  });

  it("a UI bind shows the waiting state, flips to connected on the new generation's heartbeat", async () => {
    rosterQuery.data = { sessions: [liveLaptop()] };
    const { rerender } = render(
      <TaskAgentBindingPanel taskId="task-1" layout="block" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    fireEvent.click(await screen.findByText("fix kaneo build"));
    await vi.waitFor(() => expect(bindMutation.mutateAsync).toHaveBeenCalled());

    // A stale, online pre-bind generation must not clear pending or claim the
    // new session connected while the status query is catching up.
    bindingQuery.data = {
      bound: true,
      online: true,
      hostId: "pi-laptop",
      bindingId: "binding-old",
      sessionId: "s-laptop-1",
      bindingGeneration: 1,
    };
    rerender(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(document.querySelector("span.bg-success")).toBeNull();

    // The server flipped to the mutation's generation, but it has not yet
    // heartbeated. This observation arms pending-state resolution.
    bindingQuery.data = {
      ...bindingQuery.data,
      online: false,
      bindingId: "binding-new",
      bindingGeneration: 2,
    };
    rerender(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(document.querySelector("span.bg-success")).toBeNull();

    // A late stale response for the older online generation must not clear
    // pending or make the prior session appear connected.
    bindingQuery.data = {
      ...bindingQuery.data,
      online: true,
      bindingId: "binding-old",
      bindingGeneration: 1,
    };
    rerender(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(document.querySelector("span.bg-success")).toBeNull();
    // The connectivity dot must not paint the stale generation green either.
    expect(document.querySelector("span.bg-success")).toBeNull();

    // The adopted session heartbeats the new generation → connected.
    bindingQuery.data = {
      ...bindingQuery.data,
      online: true,
      bindingId: "binding-new",
      bindingGeneration: 2,
    };
    rerender(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(document.querySelector("span.bg-success")).not.toBeNull();
  });

  it("the pending status ages: waiting until 2x TTL, then disconnected, null once connected", () => {
    const pending = { bindingGeneration: 2, since: 1_000_000, observed: false };
    const base = {
      pending,
      bound: true,
      bindingGeneration: 2,
      online: false,
    };
    expect(resolvePendingStatus({ ...base, clock: 1_000_000 + 1000 })).toBe(
      "waiting",
    );
    expect(
      resolvePendingStatus({
        ...base,
        clock: 1_000_000 + PENDING_DISCONNECT_MS + 1,
      }),
    ).toBe("disconnected");
    expect(
      resolvePendingStatus({
        ...base,
        clock: 1_000_000 + PENDING_DISCONNECT_MS,
      }),
    ).toBe("waiting");
    expect(
      resolvePendingStatus({ ...base, online: true, clock: 1_000_000 + 5000 }),
    ).toBeNull();
    // A lower, stale online generation can never resolve the newer bind.
    expect(
      resolvePendingStatus({
        ...base,
        pending: { ...pending, observed: true },
        bindingGeneration: 1,
        online: true,
        clock: 1_000_000 + 5000,
      }),
    ).toBe("waiting");
    // A newer generation proves the server superseded this bind.
    expect(
      resolvePendingStatus({
        ...base,
        bindingGeneration: 3,
        online: true,
        clock: 1_000_000 + 5000,
      }),
    ).toBeNull();
    // An unbound cache before observing the target generation stays pending;
    // an unbound status after observing it is authoritative.
    expect(
      resolvePendingStatus({ ...base, bound: false, clock: 1_000_000 + 5000 }),
    ).toBe("waiting");
    expect(
      resolvePendingStatus({
        ...base,
        pending: { ...pending, observed: true },
        bound: false,
        bindingGeneration: undefined,
        clock: 1_000_000 + 5000,
      }),
    ).toBeNull();
  });

  it("bind failure toasts and leaves the state untouched (S1 stays)", async () => {
    bindMutation.mutateAsync.mockRejectedValueOnce(new Error("boom"));
    rosterQuery.data = { sessions: [liveLaptop()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    fireEvent.click(await screen.findByText("fix kaneo build"));
    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    // Still unbound: the picker row is still offered, no S2 block popped in.
    expect(screen.getByRole("button", { name: /Assign agent/ })).toBeVisible();
  });

  it("a live bound session's title is remembered for later offline display", async () => {
    bindingQuery.data = {
      bound: true,
      online: true,
      hostId: "pi-laptop",
      bindingId: "binding-1",
      sessionId: "s-laptop-1",
      bindingGeneration: 1,
    };
    rosterQuery.data = { sessions: [liveLaptop()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(screen.getByText("fix kaneo build")).toBeVisible();
    // Write-through: the live session pins its title into the local memory.
    await vi.waitFor(() => {
      const raw = window.localStorage.getItem("kaneo:session-titles");
      expect(JSON.parse(raw ?? "{}")).toMatchObject({
        "s-laptop-1": "fix kaneo build",
      });
    });
    window.localStorage.clear();
  });

  it("i18n keys used by the panel exist in the en-US reference", async () => {
    const enUS = (await import("@i18n/en-US.json")).default as {
      tasks: { properties: { agents: Record<string, string> } };
    };
    const agents = enUS.tasks.properties.agents;
    for (const key of [
      "heading",
      "assign",
      "runningCount",
      "empty",
      "searchPlaceholder",
      "loading",
      "loadError",
      "retry",
      "change",
      "unbind",
      "rebindTitle",
      "unbindTitle",
      "bindFailed",
      "unbindFailed",
      "pickerLabel",
    ]) {
      expect(agents[key], `tasks.properties.agents.${key}`).toBeTruthy();
    }
  });
});
