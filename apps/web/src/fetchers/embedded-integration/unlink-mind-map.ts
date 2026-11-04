import { client } from "@kaneo/libs";

async function unlinkMindMap(projectId: string) {
  const response = await client["embedded-integration"].project[":projectId"][
    "mind-map"
  ].$delete({
    param: { projectId },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = await response.json();
  return data;
}

export default unlinkMindMap;
