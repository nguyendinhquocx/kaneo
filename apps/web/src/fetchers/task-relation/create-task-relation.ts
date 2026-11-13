import { client } from "@kaneo/libs";

async function createTaskRelation({
  sourceTaskId,
  targetTaskId,
  relationType,
  expectedParentContentRevision,
}: {
  sourceTaskId: string;
  targetTaskId: string;
  relationType: "subtask" | "blocks" | "related";
  expectedParentContentRevision?: number;
}) {
  const response = await client["task-relation"].$post({
    json: {
      sourceTaskId,
      targetTaskId,
      relationType,
      expectedParentContentRevision,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = await response.json();

  return data;
}

export default createTaskRelation;
