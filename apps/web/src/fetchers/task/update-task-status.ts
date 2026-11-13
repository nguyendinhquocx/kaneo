import { client } from "@kaneo/libs";
import type Task from "@/types/task";
import { getExpectedContentRevision } from "@/lib/task-content-revision";

type UpdateTaskStatusPayload = Pick<Task, "status" | "contentRevision">;

async function updateTaskStatus(taskId: string, task: UpdateTaskStatusPayload) {
  const response = await client.task.status[":id"].$put({
    param: { id: taskId },
    json: {
      status: task.status || "",
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

export default updateTaskStatus;
