import { client } from "@kaneo/libs";

export type ShareLink = {
  id: string;
  resourceType: string;
  resourceId: string;
  permission: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type CreatedShareLink = ShareLink & {
  token: string;
  url: string;
};

export async function createShareLink(input: {
  resourceType: "project" | "document" | "goal";
  resourceId: string;
  permission: "view" | "edit";
}) {
  const response = await client["share-manage"].$post({ json: input });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as CreatedShareLink;
}

export async function listShareLinks(input: {
  resourceType: "project" | "document" | "goal";
  resourceId: string;
  includeRevoked?: boolean;
}) {
  const response = await client["share-manage"].$get({
    query: {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(input.includeRevoked ? { includeRevoked: "true" } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as ShareLink[];
}

export async function revokeShareLink(linkId: string) {
  const response = await client["share-manage"][":id"].$delete({
    param: { id: linkId },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as { success: boolean };
}
