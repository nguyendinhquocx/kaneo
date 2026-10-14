import type { client } from "@kaneo/libs";
import type { InferResponseType } from "hono/client";

// SPEC-2026-10-08-kaneo-workspace-collaboration: the public payload is the
// minimized DTO from the API (no workspaceId, assignee identity, avatars or
// external integration metadata).
export type PublicProjectPayload = InferResponseType<
  (typeof client)["public-project"][":id"]["$get"],
  200
>;

export type PublicProjectColumn = PublicProjectPayload["columns"][number];

export type PublicProjectTask = PublicProjectColumn["tasks"][number];
