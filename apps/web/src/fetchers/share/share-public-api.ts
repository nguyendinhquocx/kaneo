import { resolveApiBaseUrl } from "@kaneo/libs";

const apiBase = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL as string | undefined,
);

// R4-T4: authenticated mutation shapes are not part of the generated hono
// client types for share-scoped public writes, so the reader calls them via
// small typed wrappers around plain fetch. No credentials are attached —
// the capability token in the URL is the authorization.

export type SharedDocumentPayload = {
  id: string;
  title: string;
  content: string;
  revision: number;
  updatedAt?: string;
  scope?: "view" | "edit";
};

export class ShareConflictError extends Error {
  constructor(message = "conflict") {
    super(message);
    this.name = "ShareConflictError";
  }
}

async function parseError(response: Response) {
  try {
    const body = (await response.json()) as { message?: string };
    return body?.message ? new Error(body.message) : new Error("error");
  } catch {
    return new Error("error");
  }
}

export async function updateSharedDocument({
  token,
  title,
  content,
  revision,
}: {
  token: string;
  title: string;
  content: string;
  revision: number;
}): Promise<{ id: string; title: string; content: string; revision: number }> {
  const response = await fetch(`${apiBase}/share/document/${token}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content, revision }),
  });
  if (response.status === 409) {
    throw new ShareConflictError();
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as {
    id: string;
    title: string;
    content: string;
    revision: number;
  };
}

export type SharedTaskWrite = {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  startDate?: string | null;
  dueDate?: string | null;
};

export type SharedTaskResult = {
  id: string;
  title: string;
  number: number | null;
  status: string;
  priority: string | null;
};

export async function createSharedProjectTask({
  token,
  task,
}: {
  token: string;
  task: SharedTaskWrite & { title: string };
}): Promise<SharedTaskResult> {
  const response = await fetch(`${apiBase}/share/project/${token}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(task),
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as SharedTaskResult;
}

export async function updateSharedProjectTask({
  token,
  taskId,
  task,
}: {
  token: string;
  taskId: string;
  task: SharedTaskWrite;
}): Promise<SharedTaskResult> {
  const response = await fetch(
    `${apiBase}/share/project/${token}/task/${taskId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    },
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as SharedTaskResult;
}

export type SharedCheckinRow = {
  checkInDate: string;
  completed: boolean;
  note: string;
  noteRevision: number;
};

export async function updateSharedGoalNote({
  token,
  checkinId,
  note,
  noteRevision,
}: {
  token: string;
  checkinId: string;
  note: string;
  noteRevision: number;
}): Promise<SharedCheckinRow> {
  const response = await fetch(
    `${apiBase}/share/goal/${token}/checkin/${checkinId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note, noteRevision }),
    },
  );
  if (response.status === 409) {
    throw new ShareConflictError();
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as SharedCheckinRow;
}
