import { client } from "@kaneo/libs";
import type Task from "@/types/task";
import { getExpectedContentRevision } from "@/lib/task-content-revision";

async function updateTaskTitle(taskId: string, task: Task) {
  const response = await client.task.title[":id"].$put({
    param: { id: taskId },
    json: {
      title: task.title || "",
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

export default updateTaskTitle;
