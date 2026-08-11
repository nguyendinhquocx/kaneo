import { client } from "@kaneo/libs";
import type { InferResponseType } from "hono";

export type ExecutionTaskRun = InferResponseType<
  (typeof client)["execution"]["task"][":taskId"]["runs"]["$get"],
  200
>[number];

async function getTaskRuns(taskId: string): Promise<ExecutionTaskRun[]> {
  const response = await client.execution.task[":taskId"].runs.$get({
    param: { taskId },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to load task execution runs");
  }

  return response.json();
}

export default getTaskRuns;
