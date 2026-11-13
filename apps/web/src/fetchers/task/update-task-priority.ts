import { client } from "@kaneo/libs";
import type Task from "@/types/task";
import { getExpectedContentRevision } from "@/lib/task-content-revision";
import { normalizeTaskPriority } from "@/types/task";

async function updateTaskPriority(taskId: string, task: Task) {
  const response = await client.task.priority[":id"].$put({
    param: { id: taskId },
    json: {
      priority: normalizeTaskPriority(task.priority),
      expectedContentRevision: getExpectedContentRevision(task),
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = await response.json();

  return data;
}

export default updateTaskPriority;
