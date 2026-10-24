import { useQuery } from "@tanstack/react-query";
import getColumns from "@/fetchers/column/get-columns";
import { getShareFullProject } from "@/fetchers/share/share-full-api";
import { getShareCapability } from "@/components/share/share-capability";

export function useGetColumns(projectId: string) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? ["share-full", capability.token, "columns"]
      : ["columns", projectId],
    queryFn: () => {
      if (capability) {
        return getShareFullProject(capability.token).then((project) =>
          project.columns.map((column) => ({
            id: column.id,
            projectId: project.id,
            slug: column.slug,
            name: column.name,
            icon: column.icon,
            isFinal: column.isFinal,
          })),
        );
      }
      return getColumns(projectId);
    },
    enabled: Boolean(projectId || capability),
  });
}
