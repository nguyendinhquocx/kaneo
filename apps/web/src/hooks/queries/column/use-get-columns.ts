import { useQuery } from "@tanstack/react-query";
import getColumns from "@/fetchers/column/get-columns";
import { getShareFullProject } from "@/fetchers/share/share-full-api";
import { getTaskShareRoot } from "@/fetchers/share/share-task-api";
import { getShareCapability } from "@/components/share/share-capability";

export function useGetColumns(projectId: string) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? capability.resourceType === "task"
        ? ["share-task", capability.token, "columns"]
        : ["share-full", capability.token, "columns"]
      : ["columns", projectId],
    queryFn: () => {
      if (capability?.resourceType === "task") {
        return getTaskShareRoot(capability.token).then((share) =>
          share.statusOptions.map((column) => ({
            id: column.slug,
            projectId: capability.projectId,
            slug: column.slug,
            name: column.name,
            icon: null,
            isFinal: column.isFinal,
          })),
        );
      }
      if (capability?.resourceType === "project") {
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
