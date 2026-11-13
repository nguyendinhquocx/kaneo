import { client } from "@kaneo/libs";

async function deleteTaskRelation(
  id: string,
  expectedParentContentRevision?: number,
) {
  const response = await client["task-relation"][":id"].$delete({
    param: { id },
    // Only send the query when a token exists — an undefined value would
    // serialize as the literal string "undefined" and fail the CAS parse.
    ...(expectedParentContentRevision !== undefined
      ? { query: { expectedParentContentRevision: String(expectedParentContentRevision) } }
      : {}),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = await response.json();

  return data;
}

export default deleteTaskRelation;
