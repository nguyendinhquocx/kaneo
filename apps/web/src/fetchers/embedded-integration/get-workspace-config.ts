import { client } from "@kaneo/libs";

async function getEmbeddedServicesConfig(workspaceId: string) {
  const response = await client["embedded-integration"][
    "workspace-config"
  ].$get({
    query: { workspaceId },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = await response.json();
  return data;
}

export default getEmbeddedServicesConfig;
