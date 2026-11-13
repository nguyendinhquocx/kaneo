import { resolveApiBaseUrl } from "@kaneo/libs";

const apiBase = resolveApiBaseUrl(import.meta.env.VITE_API_URL as string | undefined);

export type TaskAgentBindingStatus = {
  bound: boolean;
  online: boolean;
  hostId?: string;
};

export async function getTaskAgentBindingStatus(
  taskId: string,
): Promise<TaskAgentBindingStatus> {
  const response = await fetch(
    `${apiBase}/agent-session/tasks/${encodeURIComponent(taskId)}/binding-status`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as TaskAgentBindingStatus;
}
