import { resolveApiBaseUrl } from "@kaneo/libs";

export type ContentAssetOwnerType =
  | "task_description"
  | "task_comment"
  | "document"
  | "document_comment"
  | "goal_checkin";

export type ContentAsset = {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: "image" | "attachment";
};

type UploadTicket = {
  uploadUrl: string;
  headers: Record<string, string>;
  key: string;
};

const apiBase = resolveApiBaseUrl(import.meta.env.VITE_API_URL);

async function requestJson<T>(path: string, body: unknown, method: string) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

export async function createImageUpload(input: {
  ownerType: ContentAssetOwnerType;
  ownerId: string;
  filename: string;
  contentType: string;
  size: number;
}) {
  return requestJson<UploadTicket>("/content-asset/upload", input, "PUT");
}

export async function finalizeImageUpload(input: {
  ownerType: ContentAssetOwnerType;
  ownerId: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
}) {
  return requestJson<ContentAsset>("/content-asset/finalize", input, "POST");
}
