import { resolveApiBaseUrl } from "@kaneo/libs";

const apiBase = resolveApiBaseUrl(import.meta.env.VITE_API_URL);

export async function reorderSubtasks(input: {
  taskId: string;
  orderedTargetTaskIds: string[];
  expectedParentContentRevision: number;
}) {
  const response = await fetch(
    `${apiBase}/task-relation/subtasks/${encodeURIComponent(input.taskId)}/order`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderedTargetTaskIds: input.orderedTargetTaskIds,
        expectedParentContentRevision: input.expectedParentContentRevision,
      }),
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as Array<{
    id: string;
    relationType: string;
    sourceTaskId: string;
    targetTaskId: string;
    position: number;
  }>;
}
