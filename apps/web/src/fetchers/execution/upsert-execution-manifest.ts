import { client } from "@kaneo/libs";
import type { InferRequestType, InferResponseType } from "hono";

type UpsertExecutionManifestRoute =
  (typeof client)["execution"]["project"][":projectId"]["manifest"]["$put"];

export type UpsertExecutionManifestRequest = {
  projectId: InferRequestType<UpsertExecutionManifestRoute>["param"]["projectId"];
  json: InferRequestType<UpsertExecutionManifestRoute>["json"];
};

export type UpsertExecutionManifestResponse = InferResponseType<
  UpsertExecutionManifestRoute,
  200
>;

async function upsertExecutionManifest({
  projectId,
  json,
}: UpsertExecutionManifestRequest): Promise<UpsertExecutionManifestResponse> {
  const response = await client.execution.project[":projectId"].manifest.$put({
    param: { projectId },
    json,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Failed to save execution manifest");
  }

  return response.json();
}

export default upsertExecutionManifest;
