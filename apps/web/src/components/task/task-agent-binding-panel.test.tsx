import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  useGetAgentSessionRoster: () => rosterQuery,
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

const liveLaptop = () =>
  session({
    sessionId: "s-laptop-1",
    host: "pi-laptop",
    title: "fix kaneo build",
    cwd: "D:/work/kaneo",
    model: "glm-5.3-flash",
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
  taskQuery.data = { id: "task-1", number: 1, title: "Panel card" };
  rosterQuery.refetch.mockClear();
  bindMutation.mutateAsync.mockClear();
  unbindMutation.mutateAsync.mockClear();
  toast.error.mockClear();
});

afterEach(() => {
  cleanup();
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

  it("S1 renders the ghost picker button with the live-session count and a chevron", () => {
    rosterQuery.data = { sessions: [liveLaptop(), liveDeskBound()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    const button = screen.getByRole("button", {
      name: "Assign agent · 2 running",
    });
    expect(button).toBeVisible();
    // Ghost property-row affordance: chevron, not a static text node.
    expect(button.querySelector("svg")).not.toBeNull();
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
    const search = await screen.findByPlaceholderText("Search sessions…");
    expect(search).toBeVisible();
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
    expect(screen.queryByPlaceholderText("Search sessions…")).toBeNull();
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

  it("rebinding a bound session requires one confirm naming card + session context, then a single POST", async () => {
    rosterQuery.data = { sessions: [liveDeskBound()] };
    render(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    fireEvent.click(screen.getByRole("button", { name: /Assign agent/ }));
    fireEvent.click(await screen.findByText("desk work"));

    // One confirm dialog naming the affected card AND the session context.
    expect(
      await screen.findByText(
        's-desk-1 is currently bound to card #7 "Other card". Move it to this card?',
      ),
    ).toBeVisible();
    expect(screen.getByText("/srv/ops · luna · prodesk-home")).toBeVisible();
    expect(screen.getByText("Affected card: #7 Other card")).toBeVisible();

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

  it("S2 shows dot, title, host badge, model, and the online status", () => {
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
    expect(screen.getAllByText("pi-laptop").length).toBeGreaterThan(0);
    expect(screen.getByText("glm-5.3-flash")).toBeVisible();
    expect(screen.getByText("Pi connected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Unbind" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Change session" }),
    ).toBeVisible();
  });

  it("S2 falls back to the session id as title when the roster lacks the row", () => {
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
    expect(screen.getByText("s-unknown")).toBeVisible();
    expect(screen.getByText("Pi offline")).toBeVisible();
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
      await screen.findByText(
        "Session s-laptop-1 will stop syncing this card and its subtasks.",
      ),
    ).toBeVisible();
    // Acceptance: the confirm names the affected card AND the session context.
    expect(screen.getByText("Affected card: #1 Panel card")).toBeVisible();
    expect(
      screen.getByText("D:/work/kaneo · glm-5.3-flash · pi-laptop"),
    ).toBeVisible();
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

    // The server flipped the binding but the session has not heartbeated yet.
    bindingQuery.data = {
      bound: true,
      online: false,
      hostId: "pi-laptop",
      bindingId: "binding-new",
      sessionId: "s-laptop-1",
      bindingGeneration: 2,
    };
    rerender(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(
      screen.getByText("Assigned · waiting for the session"),
    ).toBeVisible();

    // The adopted session heartbeats the new generation → connected.
    bindingQuery.data = { ...bindingQuery.data, online: true };
    rerender(<TaskAgentBindingPanel taskId="task-1" layout="block" />);
    expect(screen.getByText("Pi connected")).toBeVisible();
    expect(screen.queryByText("Assigned · waiting for the session")).toBeNull();
  });

  it("the pending status ages: waiting until 2x TTL, then disconnected, null once connected", () => {
    const pending = { bindingGeneration: 2, since: 1_000_000 };
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
    // Generation moved elsewhere — server truth wins, no intermediate state.
    expect(
      resolvePendingStatus({
        ...base,
        bindingGeneration: 3,
        clock: 1_000_000 + 5000,
      }),
    ).toBeNull();
    // Not bound at all.
    expect(
      resolvePendingStatus({ ...base, bound: false, clock: 1_000_000 + 5000 }),
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
      "waiting",
      "disconnected",
      "change",
      "unbind",
      "rebindTitle",
      "rebindBody",
      "unbindTitle",
      "unbindBody",
      "sessionContext",
      "affectedCard",
      "bindFailed",
      "unbindFailed",
      "pickerLabel",
    ]) {
      expect(agents[key], `tasks.properties.agents.${key}`).toBeTruthy();
    }
  });
});
