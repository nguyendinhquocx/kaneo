import { client } from "@kaneo/libs";
import type { InferRequestType, InferResponseType } from "hono";

type ReviewTaskRunRoute =
  (typeof client)["execution"]["task"][":taskId"]["runs"][":runId"]["review"]["$post"];

export type ReviewTaskRunRequest = {
  taskId: string;
  runId: string;
  json: InferRequestType<ReviewTaskRunRoute>["json"];
};

export type ReviewTaskRunResponse = InferResponseType<ReviewTaskRunRoute, 200>;

async function reviewTaskRun({
  taskId,
  runId,
  json,
}: ReviewTaskRunRequest): Promise<ReviewTaskRunResponse> {
  const response = await client.execution.task[":taskId"].runs[
    ":runId"
  ].review.$post(
    {
      param: { taskId, runId },
      json,
    },
    {
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to review task execution run");
  }

  return response.json();
}

export default reviewTaskRun;
