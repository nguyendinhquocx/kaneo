import { client } from "@kaneo/libs";
import type { InferRequestType, InferResponseType } from "hono";

type CreateExecutionAgentRoute =
  (typeof client)["execution"]["project"][":projectId"]["agents"]["$post"];

export type CreateExecutionAgentRequest = {
  projectId: InferRequestType<CreateExecutionAgentRoute>["param"]["projectId"];
  json: InferRequestType<CreateExecutionAgentRoute>["json"];
};

export type CreateExecutionAgentResponse = InferResponseType<
  CreateExecutionAgentRoute,
  201
>;

async function createExecutionAgent({
  projectId,
  json,
}: CreateExecutionAgentRequest): Promise<CreateExecutionAgentResponse> {
  const response = await client.execution.project[":projectId"].agents.$post({
    param: { projectId },
    json,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to register execution agent");
  }

  return response.json();
}

export default createExecutionAgent;
