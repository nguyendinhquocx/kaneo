import { resolveApiBaseUrl } from "@kaneo/libs";

const apiBase = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL as string | undefined,
);

// SPEC-2026-11-25-kaneo-ui-agent-binding: live agent-session roster
// (TTL-filtered server-side) + the shared bind/unbind endpoints that
// /kaneo-card uses — one write path for both entry points.
export type AgentSessionRosterBinding = {
  taskId: string;
  taskTitle: string | null;
  taskNumber: number | null;
};

export type AgentSessionRosterEntry = {
  sessionId: string;
  host: string;
  title: string;
  cwd: string;
  model: string;
  lastSeenAt: string;
  agentPrincipalId: string;
  binding: AgentSessionRosterBinding | null;
};

export type AgentSessionRoster = {
  sessions: AgentSessionRosterEntry[];
};

export type AgentSessionBindingView = {
  bindingId: string;
  bindingGeneration: number;
  taskId: string;
  projectId: string;
  sessionId: string;
  hostId: string;
  status: string;
  revision: number;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = await response.text();
    try {
      const body = JSON.parse(message) as {
        message?: unknown;
        error?: unknown;
      };
      if (typeof body.message === "string") message = body.message;
      else if (typeof body.error === "string") message = body.error;
    } catch {
      // Keep the response text as the bounded error message.
    }
    throw new Error(message || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getAgentSessionRoster(): Promise<AgentSessionRoster> {
  return request<AgentSessionRoster>("/agent-session/sessions/roster", {
    credentials: "include",
  });
}

export async function bindAgentSessionToTask(input: {
  taskId: string;
  agentPrincipalId: string;
  sessionId: string;
}): Promise<AgentSessionBindingView> {
  const { taskId, ...body } = input;
  return request<AgentSessionBindingView>("/agent-session/bindings", {
    method: "POST",
    body: JSON.stringify({ taskId, ...body }),
  });
}

export async function unbindAgentSessionFromTask(input: {
  bindingId: string;
  sessionId: string;
  generation: number;
}): Promise<{ unbound: boolean }> {
  const { bindingId, sessionId, generation } = input;
  return request<{ unbound: boolean }>(
    `/agent-session/bindings/${encodeURIComponent(bindingId)}?sessionId=${encodeURIComponent(sessionId)}&generation=${generation}`,
    { method: "DELETE" },
  );
}
