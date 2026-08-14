import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";

export type GetProjectRequest = InferRequestType<
  (typeof client)["project"][":id"]["$get"]
>["param"] & {
  // Retained for callers' query-key shape; workspace access is resolved from
  // the project on the API route and is not a request query parameter.
  workspaceId?: string;
};

async function getProject({ id }: GetProjectRequest) {
  const response = await client.project[":id"].$get({
    param: { id },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = await response.json();

  return data;
}

export default getProject;
