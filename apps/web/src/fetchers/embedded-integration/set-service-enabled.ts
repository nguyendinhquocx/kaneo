import { client } from "@kaneo/libs";

async function setEmbeddedServiceEnabled({
  workspaceId,
  service,
  enabled,
}: {
  workspaceId: string;
  service: "mitra" | "wisemapping";
  enabled: boolean;
}) {
  const response = await client["embedded-integration"]["workspace-config"][
    ":service"
  ].$put({
    param: { service },
    query: { workspaceId },
    json: { enabled },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

export default setEmbeddedServiceEnabled;
