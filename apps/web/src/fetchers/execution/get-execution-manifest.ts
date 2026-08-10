import { client } from "@kaneo/libs";
import type { InferResponseType } from "hono";

export type ExecutionManifestResponse = InferResponseType<
  (typeof client)["execution"]["project"][":projectId"]["manifest"]["$get"],
  200
>;

async function getExecutionManifest(
  projectId: string,
): Promise<ExecutionManifestResponse | null> {
  const response = await client.execution.project[":projectId"].manifest.$get({
    param: { projectId },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to load execution manifest");
  }

  return response.json();
}

export default getExecutionManifest;
