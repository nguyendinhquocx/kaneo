import { resolveApiBaseUrl } from "@kaneo/libs";

export type ShareResourceType =
  | "project"
  | "document"
  | "goal"
  | "task_description"
  | "activity_comment";

export type ShareLink = {
  id: string;
  resourceType: ShareResourceType;
  resourceId: string;
  permission: "view" | "edit";
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  url: string | null;
};

export type CreatedShareLink = ShareLink & {
  token: string;
  url: string;
};

const apiBase = resolveApiBaseUrl(import.meta.env.VITE_API_URL);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

export async function createShareLink(input: {
  resourceType: ShareResourceType;
  resourceId: string;
  permission: "view" | "edit";
}) {
  return request<CreatedShareLink>("/share-manage", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listShareLinks(input: {
  resourceType: ShareResourceType;
  resourceId: string;
  includeRevoked?: boolean;
}) {
  const query = new URLSearchParams({
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    ...(input.includeRevoked ? { includeRevoked: "true" } : {}),
  });
  return request<ShareLink[]>(`/share-manage?${query.toString()}`);
}

export async function revokeShareLink(linkId: string) {
  return request<{ success: boolean }>(
    `/share-manage/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
}
