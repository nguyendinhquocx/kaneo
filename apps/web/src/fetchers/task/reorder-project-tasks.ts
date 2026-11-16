import { client } from "@kaneo/libs";


export type ReorderTaskDelta = {
  id: string;
  status: string;
  position: number;
};

export type ReorderProjectTasksResult = {
  updated: Array<{
    id: string;
    status: string;
    position: number;
    contentRevision: number;
  }>;
};

/**
 * Batch lane reorder (SPEC-2026-11-10 R4): one request per drag instead of
 * one PATCH per changed card, so a populated lane no longer bursts the
 * Postgres connection pool or serializes the next drag behind pending writes.
 */
export default async function reorderProjectTasksBatch(
  projectId: string,
  tasks: ReorderTaskDelta[],
): Promise<ReorderProjectTasksResult> {
  const response = await client.task.reorder[":projectId"].$put({
    param: { projectId },
    json: { tasks },
  });

  if (!response.ok) {
    let message: string;
    try {
      const json = await response.json();
      message =
        (json as { message?: string; error?: string }).message ||
        (json as { error?: string }).error ||
        JSON.stringify(json);
    } catch {
      message =
        (await response.text().catch(() => "")) ||
        `API error ${response.status}`;
    }
    throw new Error(message);
  }

  return response.json();
}
