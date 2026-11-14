import { resolveApiBaseUrl } from "@kaneo/libs";

const apiBase = resolveApiBaseUrl(import.meta.env.VITE_API_URL as string | undefined);

export type CommentDeliveryState =
  | "queued"
  | "claimed"
  | "enqueued"
  | "stale"
  | "expired"
  | "failed_before_send"
  | "unknown";

export type CommentDeliveryReceipt = {
  deliveryId: string;
  bindingId: string;
  bindingGeneration: number;
  commentId: string | null;
  clientActionKey: string;
  state: CommentDeliveryState;
  createdAt: string;
  expiresAt: string;
  enqueuedAt: string | null;
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
      const body = JSON.parse(message) as { message?: unknown; error?: unknown };
      if (typeof body.message === "string") message = body.message;
      else if (typeof body.error === "string") message = body.error;
    } catch {
      // Keep the response text as the bounded error message.
    }
    throw new Error(message || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function sendCommentToPi(input: {
  bindingId: string;
  sessionId: string;
  generation: number;
  commentId: string;
  clientActionKey: string;
}) {
  const { bindingId, ...body } = input;
  return request<{ duplicate: boolean; receipt: CommentDeliveryReceipt }>(
    `/agent-session/bindings/${encodeURIComponent(bindingId)}/deliveries`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function getCommentDeliveryStatus(
  bindingId: string,
  deliveryId: string,
) {
  return request<CommentDeliveryReceipt>(
    `/agent-session/bindings/${encodeURIComponent(bindingId)}/deliveries/${encodeURIComponent(deliveryId)}`,
  );
}
