import { client } from "@kaneo/libs";

async function linkMindMap({
  projectId,
  mapId,
}: {
  projectId: string;
  mapId: string;
}) {
  const response = await client["embedded-integration"].project[":projectId"][
    "mind-map"
  ].$put({
    param: { projectId },
    json: { mapId },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = await response.json();
  return data;
}

export default linkMindMap;
