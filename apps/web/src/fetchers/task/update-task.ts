import { client } from "@kaneo/libs";
import type Task from "@/types/task";
import { getExpectedContentRevision } from "@/lib/task-content-revision";
import { normalizeTaskPriority } from "@/types/task";

async function updateTask(taskId: string, task: Task) {
  const response = await client.task[":id"].$put({
    param: { id: taskId },
    json: {
      userId: task.userId || "",
      title: task.title,
      description: task.description || "",
      status: task.status,
      priority: normalizeTaskPriority(task.priority),
      startDate: task.startDate?.toString(),
      dueDate: task.dueDate?.toString(),
      position: task.position ?? 0,
      projectId: task.projectId,
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

export default updateTask;
