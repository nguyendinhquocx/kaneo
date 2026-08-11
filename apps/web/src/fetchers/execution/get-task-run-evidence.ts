import { client } from "@kaneo/libs";
import type { InferResponseType } from "hono";

export type ExecutionTaskRunEvidence = InferResponseType<
  (typeof client)["execution"]["task"][":taskId"]["runs"][":runId"]["evidence"]["$get"],
  200
>[number];

async function getTaskRunEvidence(
  taskId: string,
  runId: string,
): Promise<ExecutionTaskRunEvidence[]> {
  const response = await client.execution.task[":taskId"].runs[
    ":runId"
  ].evidence.$get({
    param: { taskId, runId },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to load task execution evidence");
  }

  return response.json();
}

export default getTaskRunEvidence;
