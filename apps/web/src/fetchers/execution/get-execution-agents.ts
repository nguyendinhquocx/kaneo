import { client } from "@kaneo/libs";
import type { InferResponseType } from "hono";

export type ExecutionAgent = InferResponseType<
  (typeof client)["execution"]["agents"]["$get"],
  200
>[number];

async function getExecutionAgents(): Promise<ExecutionAgent[]> {
  const response = await client.execution.agents.$get();

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to load execution agents");
  }

  return response.json();
}

export default getExecutionAgents;
