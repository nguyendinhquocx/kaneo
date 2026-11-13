import { resolveApiBaseUrl } from "@kaneo/libs";
import { ShareRequestError } from "@/fetchers/share/share-request-error";

const apiBase = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL as string | undefined,
);

// SPEC-2026-11-10-kaneo-card-agent-collaboration T3: capability-aware client
// for the guest TASK surface. Same DTO contract as the server's explicit
// task-share allowlist: one card plus its live subtask tree, no assignee
// identity, no workspace/project enumeration. Authorization is the bearer
// token in the URL — no credentials, no cookies.

export type ShareTaskStatusOption = {
  slug: string;
  name: string;
  isFinal: boolean;
};

export type ShareTaskCard = {
  id: string;
  number: number | null;
  title: string;
  description: string | null;
  status: string;
  statusLabel: string | null;
  priority: string | null;
  startDate: string | null;
  dueDate: string | null;
  contentRevision: number;
  workMarkerCounts: {
    redCross: number;
    boxedRedCross: number;
    redCircle: number;
    greenCheck: number;
  };
  labels: Array<{ id: string; name: string; color: string | null }>;
  assetRefs: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    surface: string;
    taskId: string;
  }>;
};

export type ShareTaskComment = {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string | null;
  authorName: string;
  authorType: "member" | "guest" | "system";
};

export type ShareTaskCommentsPage = {
  items: ShareTaskComment[];
  nextCursor: string | null;
};

export type TaskShareRootPayload = {
  permission: "view" | "edit";
  rootTaskId: string;
  scopeProjectId: string;
  statusOptions?: ShareTaskStatusOption[];
  root: ShareTaskCard;
  subtasks: ShareTaskCard[];
  commentsPage: ShareTaskCommentsPage;
};

export type TaskShareSubtreePayload = TaskShareRootPayload & {
  task: ShareTaskCard;
  parent: { id: string; title: string } | null;
  // Edit links only: relation ids needed to drive the scoped reorder route.
  subtaskRelations?: Array<{
    relationId: string;
    targetTaskId: string;
    position: number | null;
  }>;
};

export class ShareTaskConflictError extends Error {
  constructor(message = "conflict") {
    super(message);
    this.name = "ShareTaskConflictError";
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

async function request<T>(
  token: string,
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const response = await fetch(`${apiBase}/share/task/${token}${path}`, {
    ...rest,
    credentials: "omit",
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (response.status === 409) {
    throw new ShareTaskConflictError();
  }
  if (response.status === 403 || response.status === 404) {
    throw new ShareRequestError("invalid");
  }
  if (response.status === 429) {
    throw new ShareRequestError("rateLimited");
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as T;
}

function serializeDate(value: string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function deserializeCard(task: {
  startDate: string | Date | null;
  dueDate: string | Date | null;
}): ShareTaskCard {
  return {
    ...task,
    startDate: task.startDate ? new Date(task.startDate).toISOString() : null,
    dueDate: task.dueDate ? new Date(task.dueDate).toISOString() : null,
  } as ShareTaskCard;
}

export async function getTaskShareRoot(token: string) {
  const payload = await request<TaskShareRootPayload>(token, "");
  return {
    ...payload,
    root: deserializeCard(payload.root),
    subtasks: payload.subtasks.map(deserializeCard),
  };
}

export async function getTaskShareSubtree(token: string, taskId: string) {
  const payload = await request<TaskShareSubtreePayload>(
    token,
    `/task/${encodeURIComponent(taskId)}`,
  );
  return {
    ...payload,
    task: deserializeCard(payload.task),
    subtasks: payload.subtasks.map(deserializeCard),
  };
}

export async function updateTaskShareTask({
  token,
  taskId,
  patch,
  expectedContentRevision,
}: {
  token: string;
  taskId: string;
  patch: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    startDate?: string | null;
    dueDate?: string | null;
  };
  expectedContentRevision: number;
}) {
  const result = await request<{
    task: { contentRevision: number };
    contentRevision: number;
  }>(token, `/task/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    json: { patch, expectedContentRevision },
  });
  return result;
}

export async function createTaskShareSubtask({
  token,
  parentTaskId,
  expectedParentContentRevision,
  title,
  description,
  status,
  priority,
  startDate,
  dueDate,
}: {
  token: string;
  parentTaskId: string;
  expectedParentContentRevision: number;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  startDate?: string;
  dueDate?: string;
}) {
  return request<{
    task: { id: string; contentRevision: number };
    relation: { id: string; sourceTaskId: string; targetTaskId: string };
    parentContentRevision: number;
  }>(token, `/task/${encodeURIComponent(parentTaskId)}/subtasks`, {
    method: "POST",
    json: {
      title,
      description,
      status,
      priority,
      startDate,
      dueDate,
      expectedParentContentRevision,
    },
  });
}

export async function reorderTaskShareSubtask({
  token,
  relationId,
  position,
  expectedParentContentRevision,
}: {
  token: string;
  relationId: string;
  position: number;
  expectedParentContentRevision: number;
}) {
  return request<{ contentRevision: number }>(
    token,
    `/subtask-relations/${encodeURIComponent(relationId)}/position`,
    {
      method: "PUT",
      json: { position, expectedParentContentRevision },
    },
  );
}

export async function attachTaskShareLabel({
  token,
  taskId,
  labelId,
}: {
  token: string;
  taskId: string;
  labelId: string;
}) {
  return request<{ labels: ShareTaskCard["labels"] }>(
    token,
    `/task/${encodeURIComponent(taskId)}/labels`,
    { method: "POST", json: { labelId } },
  );
}

export async function detachTaskShareLabel({
  token,
  taskId,
  labelId,
}: {
  token: string;
  taskId: string;
  labelId: string;
}) {
  return request<{ labels: ShareTaskCard["labels"] }>(
    token,
    `/task/${encodeURIComponent(taskId)}/labels/${encodeURIComponent(labelId)}`,
    { method: "DELETE" },
  );
}

export async function createTaskShareComment({
  token,
  taskId,
  content,
}: {
  token: string;
  taskId: string;
  content: string;
}) {
  return request<ShareTaskComment>(
    token,
    `/task/${encodeURIComponent(taskId)}/comments`,
    { method: "POST", json: { content } },
  );
}

export async function updateTaskShareWorkMarkers({
  token,
  taskId,
  workMarkerCounts,
  expectedContentRevision,
}: {
  token: string;
  taskId: string;
  workMarkerCounts: {
    redCross: number;
    boxedRedCross: number;
    redCircle: number;
    greenCheck: number;
  };
  expectedContentRevision: number;
}) {
  return request<{
    workMarkerCounts: ShareTaskCard["workMarkerCounts"];
    contentRevision: number;
  }>(token, `/task/${encodeURIComponent(taskId)}/work-markers`, {
    method: "PATCH",
    json: { workMarkerCounts, expectedContentRevision },
  });
}

export async function createTaskShareUploadTicket(
  token: string,
  body: {
    ownerType: "task_description" | "task_comment";
    ownerId: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  return request<{
    key: string;
    uploadUrl: string;
    headers: Record<string, string>;
  }>(token, "/asset/upload-ticket", { method: "POST", json: body });
}

export async function finalizeTaskShareUpload(
  token: string,
  body: {
    ownerType: "task_description" | "task_comment";
    ownerId: string;
    key: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  return request<{ id: string; url?: string }>(token, "/asset/finalize", {
    method: "POST",
    json: body,
  });
}

export async function uploadTaskShareAsset({
  token,
  ownerType,
  ownerId,
  file,
}: {
  token: string;
  ownerType: "task_description" | "task_comment";
  ownerId: string;
  file: File;
}) {
  const ticket = await createTaskShareUploadTicket(token, {
    ownerType,
    ownerId,
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
  });
  const putResponse = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: { ...(ticket.headers ?? {}) },
    body: file,
  });
  if (!putResponse.ok) {
    throw new Error("Upload failed");
  }
  return finalizeTaskShareUpload(token, {
    ownerType,
    ownerId,
    key: ticket.key,
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
  });
}

// Keep the serializer available for callers building comment payloads.
export const shareTaskDateSerializer = { serializeDate };
