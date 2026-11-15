import { useQuery } from "@tanstack/react-query";
import getProject from "@/fetchers/project/get-project";
import { getShareFullProject } from "@/fetchers/share/share-full-api";
import { getTaskShareRoot } from "@/fetchers/share/share-task-api";
import { getShareCapability } from "@/components/share/share-capability";

function useGetProject({
  id,
  workspaceId,
}: {
  id: string;
  workspaceId: string;
}) {
  const capability = getShareCapability();
  return useQuery({
    queryFn: async (): Promise<Awaited<ReturnType<typeof getProject>>> => {
      if (capability?.resourceType === "task") {
        return getTaskShareRoot(capability.token).then((share) => ({
          id: share.scopeProjectId,
          name: share.root.title,
          slug: "",
          icon: null,
          description: null,
          workspaceId: "",
          isPublic: false,
        }) as unknown as Awaited<ReturnType<typeof getProject>>);
      }
      if (capability?.resourceType === "project") {
        return getShareFullProject(capability.token).then((project) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
          icon: project.icon,
          description: project.description,
          workspaceId: capability.projectId,
          isPublic: false,
        }) as unknown as Awaited<ReturnType<typeof getProject>>);
      }
      return getProject({ id, workspaceId });
    },
    queryKey: capability
      ? capability.resourceType === "task"
        ? ["share-task", capability.token, "project"]
        : ["share-full", capability.token, "project"]
      : ["projects", workspaceId, id],
    enabled: Boolean(id || capability),
  });
}

export default useGetProject;
