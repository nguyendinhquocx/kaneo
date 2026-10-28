import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { invalidateShareQueries } from "@/components/share/share-capability";
import updateWorkMarkers from "@/fetchers/task/update-work-markers";
import type { TaskMarkerCounts } from "@/types/task";

// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: marker writes refresh
// every cached surface that renders markers (task detail, board/list
// projection and relation rows inside open parent sheets) in the current
// tab. Other tabs catch up via their existing refetch intervals.
export function useUpdateWorkMarkers(taskId: string, projectId: string) {
  const queryClient = useQueryClient();
  const mutationKey = ["task", "work-markers", taskId] as const;
  const isUpdatingThisTask =
    useIsMutating({ mutationKey }) > 0;
  const mutation = useMutation({
    mutationKey,
    mutationFn: (workMarkerCounts: TaskMarkerCounts) =>
      updateWorkMarkers(taskId, workMarkerCounts),
    onSuccess: async (_data, _variables) => {
      // Keep the write pending until every visible projection has refetched.
      // The endpoint replaces a complete count map, so enabling the next
      // click before these caches update would let it submit stale counts.
      await Promise.all([
        invalidateShareQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
        queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["task-relations"] }),
      ]);
    },
  });

  return {
    ...mutation,
    // TaskPropertiesSidebar has desktop and mobile editor instances; this
    // task-scoped key makes both controls share one in-flight lock.
    isPending: mutation.isPending || isUpdatingThisTask,
  };
}

export default useUpdateWorkMarkers;
