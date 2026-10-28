import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateShareQueries } from "@/components/share/share-capability";
import updateWorkMarkers from "@/fetchers/task/update-work-markers";
import type { TaskMarkerCounts } from "@/types/task";

// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: marker writes refresh
// every cached surface that renders markers (task detail, board/list
// projection and relation rows inside open parent sheets) in the current
// tab. Other tabs catch up via their existing refetch intervals.
export function useUpdateWorkMarkers(taskId: string, projectId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workMarkerCounts: TaskMarkerCounts) =>
      updateWorkMarkers(taskId, workMarkerCounts),
    onSuccess: (_data, _variables) => {
      invalidateShareQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
      queryClient.invalidateQueries({ queryKey: ["task-relations"] });
    },
  });
}

export default useUpdateWorkMarkers;
