import { client } from "@kaneo/libs";
import type { TaskMarkerCounts } from "@/types/task";

// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: replaces the full
// marker count map. Partial payloads are rejected server-side with 400.
async function updateWorkMarkers(taskId: string, workMarkerCounts: TaskMarkerCounts) {
  const response = await client.task["work-markers"][":id"].$put({
    param: { id: taskId },
    json: {
      workMarkerCounts,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = await response.json();

  // The API returns the updated task; the mutation only consumes the marker
  // map, so unwrap it here to keep optimistic cache updates typed as counts.
  return data.workMarkerCounts;
}

export default updateWorkMarkers;
