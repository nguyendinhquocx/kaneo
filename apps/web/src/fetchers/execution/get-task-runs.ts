import { client } from "@kaneo/libs";
import type { InferResponseType } from "hono";

export type ExecutionTaskRun = InferResponseType<
  (typeof client)["execution"]["task"][":taskId"]["runs"]["$get"],
  200
>[number];

// The runs endpoint answers 409 when the project has no execution manifest.
// That is a normal state for regular projects, so the panel can hide instead
// of nagging with an error+retry block.
export class ExecutionNotConfiguredError extends Error {
  constructor(message = "execution not configured") {
    super(message);
    this.name = "ExecutionNotConfiguredError";
  }
}

async function getTaskRuns(taskId: string): Promise<ExecutionTaskRun[]> {
  const response = await client.execution.task[":taskId"].runs.$get({
    param: { taskId },
  });

  if (response.status === 409) {
    throw new ExecutionNotConfiguredError();
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to load task execution runs");
  }

  return response.json();
}

export default getTaskRuns;
