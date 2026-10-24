import { resolveApiBaseUrl } from "@kaneo/libs";

const apiBase = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL as string | undefined,
);

// SPEC-2026-10-22 full-project-share-link: capability-aware client for the
// guest project surface. Same shapes as the owner API, transported by the
// bearer token in the URL — no credentials, no cookies, no fake identity.

export type ShareFullTask = {
  id: string;
  projectId: string;
  number: number | null;
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  startDate: string | Date | null;
  dueDate: string | Date | null;
  position: number | null;
  createdAt: string;
  assigneeId: string | null;
  labels: Array<{ id: string; name: string; color: string | null }>;
};

export type ShareFullProjectPayload = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  description: string | null;
  scope: "full";
  columns: Array<{
    id: string;
    slug: string;
    name: string;
    icon: string | null;
    isFinal: boolean;
    tasks: ShareFullTask[];
  }>;
  archivedTasks: ShareFullTask[];
  plannedTasks: ShareFullTask[];
};

export type ShareFullMember = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

export type ShareFullTaskDetail = ShareFullTask & {
  relations: Array<{
    id: string;
    sourceTaskId: string;
    targetTaskId: string;
    relationType: string;
    position: number | null;
    sourceTask: {
      id: string;
      title: string;
      status: string;
      priority: string | null;
      number: number | null;
      projectId: string;
      position: number | null;
      userId: string | null;
      assigneeName: string | null;
    } | null;
    targetTask: {
      id: string;
      title: string;
      status: string;
      priority: string | null;
      number: number | null;
      projectId: string;
      position: number | null;
      userId: string | null;
      assigneeName: string | null;
    } | null;
  }>;
  comments: Array<{
    id: string;
    content: string | null;
    createdAt: string;
    authorName: string;
    authorImage: string | null;
    isGuest: boolean;
  }>;
};

export class ShareFullConflictError extends Error {
  constructor(message = "conflict") {
    super(message);
    this.name = "ShareFullConflictError";
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
  const response = await fetch(`${apiBase}/share/project/${token}${path}`, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (response.status === 409) {
    throw new ShareFullConflictError();
  }
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function getShareFullProject(token: string) {
  return request<ShareFullProjectPayload>(token, "");
}

export function getShareFullMembers(token: string) {
  return request<ShareFullMember[]>(token, "/members");
}

export function getShareFullTaskDetail(token: string, taskId: string) {
  return request<ShareFullTaskDetail>(token, `/task/${taskId}`);
}

export function createShareFullTask(
  token: string,
  task: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    startDate?: string | null;
    dueDate?: string | null;
    assigneeId?: string | null;
    labels?: Array<{ name: string; color: string }>;
  },
) {
  return request<ShareFullTask>(token, "/task", {
    method: "POST",
    json: task,
  });
}

export function updateShareFullTask(
  token: string,
  taskId: string,
  task: {
    title?: string;
    description?: string | null;
    status?: string;
    priority?: string;
    startDate?: string | null;
    dueDate?: string | null;
    assigneeId?: string | null;
    position?: number;
  },
) {
  return request<ShareFullTask>(token, `/task/${taskId}`, {
    method: "PUT",
    json: task,
  });
}

export function deleteShareFullTask(token: string, taskId: string) {
  return request<{ success: boolean }>(token, `/task/${taskId}`, {
    method: "DELETE",
  });
}

export function createShareFullComment(
  token: string,
  taskId: string,
  content: string,
) {
  return request<ShareFullTaskDetail["comments"][number]>(
    token,
    `/task/${taskId}/comments`,
    { method: "POST", json: { content } },
  );
}

export function updateShareFullComment(
  token: string,
  commentId: string,
  content: string,
) {
  return request<{ id: string }>(token, `/comment/${commentId}`, {
    method: "PATCH",
    json: { content },
  });
}

export function deleteShareFullComment(token: string, commentId: string) {
  return request<{ success: boolean }>(token, `/comment/${commentId}`, {
    method: "DELETE",
  });
}

export function listShareFullDocuments(token: string) {
  return request<
    Array<{
      id: string;
      title: string;
      revision: number;
      archivedAt: string | null;
      createdAt: string;
      updatedAt: string;
    }>
  >(token, "/documents");
}

export function getShareFullDocument(token: string, documentId: string) {
  return request<{
    id: string;
    title: string;
    content: string;
    revision: number;
    updatedAt: string;
  }>(token, `/document/${documentId}`);
}

export function createShareFullDocument(
  token: string,
  body: { title: string; content: string },
) {
  return request<{ id: string; revision: number }>(token, "/documents", {
    method: "POST",
    json: body,
  });
}

export function updateShareFullDocument(
  token: string,
  documentId: string,
  body: { title: string; content: string; revision: number },
) {
  return request<{ id: string; title: string; content: string; revision: number }>(
    token,
    `/document/${documentId}`,
    { method: "PUT", json: body },
  );
}

export function setShareFullDocumentArchived(
  token: string,
  documentId: string,
  archived: boolean,
) {
  return request<{ id: string }>(
    token,
    `/document/${documentId}/${archived ? "archive" : "unarchive"}`,
    { method: "POST" },
  );
}

export function deleteShareFullDocument(token: string, documentId: string) {
  return request<{ success: boolean }>(token, `/document/${documentId}`, {
    method: "DELETE",
  });
}

export function createShareFullRelation(
  token: string,
  taskId: string,
  body: { targetTaskId: string; relationType: "subtask" | "blocks" | "related" },
) {
  return request<{ id: string }>(token, `/task/${taskId}/relations`, {
    method: "POST",
    json: body,
  });
}

export function deleteShareFullRelation(token: string, relationId: string) {
  return request<{ success: boolean }>(token, `/relation/${relationId}`, {
    method: "DELETE",
  });
}

export function reorderShareFullSubtasks(
  token: string,
  taskId: string,
  orderedTargetTaskIds: string[],
) {
  return request<{ success: boolean }>(
    token,
    `/task/${taskId}/subtasks/reorder`,
    { method: "PUT", json: { orderedTargetTaskIds } },
  );
}

export function createShareFullLabel(
  token: string,
  taskId: string,
  body: { name: string; color: string },
) {
  return request<{ id: string }>(token, `/task/${taskId}/labels`, {
    method: "POST",
    json: body,
  });
}

export function deleteShareFullLabel(token: string, labelId: string) {
  return request<{ success: boolean }>(token, `/label/${labelId}`, {
    method: "DELETE",
  });
}

export type ShareFullUploadOwnerType =
  | "task_description"
  | "task_comment"
  | "document";

export function createShareFullUploadTicket(
  token: string,
  body: {
    ownerType: ShareFullUploadOwnerType;
    ownerId: string;
    filename: string;
    contentType: string;
    size: number;
  },
) {
  return request<{ key: string; uploadUrl: string; headers: Record<string, string> }>(
    token,
    "/asset/upload-ticket",
    { method: "POST", json: body },
  );
}

export function finalizeShareFullUpload(
  token: string,
  body: {
    ownerType: ShareFullUploadOwnerType;
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

// Two-step upload following the owner pipeline: presigned PUT to storage,
// then capability finalize that verifies the actual object and commits the
// asset row + audit atomically.
export async function uploadShareFullAsset({
  token,
  ownerType,
  ownerId,
  file,
}: {
  token: string;
  ownerType: ShareFullUploadOwnerType;
  ownerId: string;
  file: File;
}) {
  const ticket = await createShareFullUploadTicket(token, {
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
  const asset = await finalizeShareFullUpload(token, {
    ownerType,
    ownerId,
    key: ticket.key,
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
  });
  // The editor uses a one-asset short-lived ticket for immediate preview.
  // API mutation handlers normalize it back to `/asset/:id` before storage.
  return asset;
}
