import { useQuery } from "@tanstack/react-query";
import getLabelsByWorkspace from "@/fetchers/label/get-label-by-workspace";
import { getShareFullProject } from "@/fetchers/share/share-full-api";
import { getShareCapability } from "@/components/share/share-capability";

function useGetLabelsByWorkspace(workspaceId: string) {
  const capability = getShareCapability();
  return useQuery({
    enabled: Boolean(capability || workspaceId),
    queryKey: capability
      ? ["share-full", capability.token, "labels"]
      : ["labels", workspaceId],
    queryFn: async (): Promise<Awaited<ReturnType<typeof getLabelsByWorkspace>>> => {
      if (capability) {
        // Task-scoped labels aggregated from the capability payload; the
        // workspace label list itself is never exposed to a holder.
        return getShareFullProject(capability.token).then((payload) => {
          const allTasks = [
            ...payload.columns.flatMap((column) => column.tasks),
            ...payload.archivedTasks,
            ...payload.plannedTasks,
          ];
          const seen = new Map<string, { id: string; name: string; color: string | null }>();
          for (const task of allTasks) {
            for (const label of task.labels ?? []) {
              if (!seen.has(label.id)) {
                seen.set(label.id, {
                  id: label.id,
                  name: label.name,
                  color: label.color ?? "",
                });
              }
            }
          }
          return [...seen.values()] as Awaited<ReturnType<typeof getLabelsByWorkspace>>;
        });
      }
      return getLabelsByWorkspace({ workspaceId });
    },
  });
}

export default useGetLabelsByWorkspace;
