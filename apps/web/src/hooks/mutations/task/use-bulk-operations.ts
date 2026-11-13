import { useMutation, useQueryClient } from "@tanstack/react-query";
import bulkOperation from "@/fetchers/task/bulk-operation";
import deleteTask from "@/fetchers/task/delete-task";
import {
  createShareFullLabel,
  deleteShareFullTask,
  updateShareFullTask,
} from "@/fetchers/share/share-full-api";
import {
  getShareCapability,
  invalidateShareQueries,
} from "@/components/share/share-capability";
import { collectExpectedContentRevisions } from "@/lib/task-content-revision";
import type Task from "@/types/task";

// SPEC-2026-11-10 T3: task-field bulk writes CAS every touched card. Read
// each card's cached revision before dispatching; unknown ids fall back to 1
// which only ever yields a recoverable 409.
function cachedContentRevisions(
  queryClientRef: ReturnType<typeof useQueryClient>,
  taskIds: string[],
): Record<string, number> {
  return collectExpectedContentRevisions((taskId) => {
    const task = queryClientRef.getQueryData<Task>(["task", taskId]);
    if (task) return task;
    const projects = queryClientRef.getQueriesData<
      { columns?: Array<{ tasks?: Array<Task> }>; plannedTasks?: Task[]; archivedTasks?: Task[] } | Task[]
    >({ queryKey: ["tasks"] });
    for (const [, payload] of projects) {
      if (!payload) continue;
      if (Array.isArray(payload)) {
        const hit = payload.find((candidate) => candidate.id === taskId);
        if (hit) return hit;
        continue;
      }
      const lanes = [
        ...(payload.columns ?? []).flatMap((column) => column.tasks ?? []),
        ...(payload.plannedTasks ?? []),
        ...(payload.archivedTasks ?? []),
      ];
      const hit = lanes.find((candidate) => candidate.id === taskId);
      if (hit) return hit;
    }
    return undefined;
  }, taskIds);
}

type BulkValueInput = { taskIds: string[]; value?: string | null };

// Guest bulk label-add: create the same label on each selected task via the
// per-task capability label route.
function updateShareFullTaskCreateLabel(
  token: string,
  taskId: string,
  template: { name: string; color: string },
) {
  return createShareFullLabel(token, taskId, {
    name: template.name,
    color: template.color,
  }).catch(() => {
    // A duplicate label on one task must not abort the whole bulk add.
  });
}

// SPEC-2026-10-22: bulk operations for capability holders run as sequential
// single-task capability calls — the owner bulk endpoint stays authenticated.
// Status/derived archive operations map onto the extended full-task surface;
// assignee/label/due-date bulk ops stay owner-only (rare paths, and the
// guest UI paths that need them use the single-task mutations).

export function useBulkOperations() {
  const queryClientRef = useQueryClient();

  const invalidateCommon = () => {
    invalidateShareQueries(queryClientRef);
    queryClientRef.invalidateQueries({ queryKey: ["tasks"] });
    queryClientRef.invalidateQueries({ queryKey: ["projects"] });
  };

  const bulkDelete = useMutation({
    mutationFn: async (taskIds: string[]) => {
      const capability = getShareCapability();
      if (capability) {
        await Promise.all(
          taskIds.map((id) => deleteShareFullTask(capability.token, id)),
        );
        return;
      }
      await Promise.all(taskIds.map((id) => deleteTask(id)));
    },
    onSuccess: invalidateCommon,
  });

  const bulkStatusValue = useMutation({
    mutationFn: async ({ taskIds, value }: BulkValueInput) => {
      const capability = getShareCapability();
      if (capability) {
        const revisions = cachedContentRevisions(queryClientRef, taskIds);
        await Promise.all(
          taskIds.map((id) =>
            updateShareFullTask(
              capability.token,
              id,
              { status: value ?? undefined },
              revisions[id],
            ),
          ),
        );
        return;
      }
      await bulkOperation({
        taskIds,
        operation: "updateStatus",
        value,
        expectedContentRevisions: cachedContentRevisions(queryClientRef, taskIds),
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkPriorityValue = useMutation({
    mutationFn: async ({ taskIds, value }: BulkValueInput) => {
      const capability = getShareCapability();
      if (capability) {
        const revisions = cachedContentRevisions(queryClientRef, taskIds);
        await Promise.all(
          taskIds.map((id) =>
            updateShareFullTask(
              capability.token,
              id,
              { priority: value ?? undefined },
              revisions[id],
            ),
          ),
        );
        return;
      }
      await bulkOperation({
        taskIds,
        operation: "updatePriority",
        value,
        expectedContentRevisions: cachedContentRevisions(queryClientRef, taskIds),
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkDueDateValue = useMutation({
    mutationFn: async ({ taskIds, value }: BulkValueInput) => {
      const capability = getShareCapability();
      if (capability) {
        const revisions = cachedContentRevisions(queryClientRef, taskIds);
        await Promise.all(
          taskIds.map((id) =>
            updateShareFullTask(
              capability.token,
              id,
              { dueDate: value ?? null },
              revisions[id],
            ),
          ),
        );
        return;
      }
      await bulkOperation({
        taskIds,
        operation: "updateDueDate",
        value,
        expectedContentRevisions: cachedContentRevisions(queryClientRef, taskIds),
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkAssignOwnerOnly = useMutation({
    mutationFn: async ({ taskIds, value }: BulkValueInput) => {
      const capability = getShareCapability();
      if (capability) {
        const revisions = cachedContentRevisions(queryClientRef, taskIds);
        await Promise.all(
          taskIds.map((id) =>
            updateShareFullTask(
              capability.token,
              id,
              { assigneeId: value || null },
              revisions[id],
            ),
          ),
        );
        return;
      }
      await bulkOperation({
        taskIds,
        operation: "updateAssignee",
        value,
        expectedContentRevisions: cachedContentRevisions(queryClientRef, taskIds),
      });
    },
    onSuccess: invalidateCommon,
  });

  const bulkAddLabel = useMutation({
    mutationFn: async ({ taskIds, labelId }: { taskIds: string[]; labelId: string }) => {
      const capability = getShareCapability();
      if (capability) {
        // Labels are per-task rows; resolve the label template from the
        // capability payload cache, then create it on each task.
        const labels = queryClientRef.getQueryData<
          Array<{ id: string; name: string; color: string }>
        >(["share-full", capability.token, "labels"]);
        const template = labels?.find((label) => label.id === labelId);
        if (!template) {
          throw new Error("Label not found");
        }
        await Promise.all(
          taskIds.map((id) =>
            updateShareFullTaskCreateLabel(
              capability.token,
              id,
              template,
            ),
          ),
        );
        return;
      }
      await bulkOperation({
        taskIds,
        operation: "addLabel",
        value: labelId,
      });
    },
    onSuccess: invalidateCommon,
  });

  return {
    bulkDelete: bulkDelete.mutateAsync,
    bulkArchive: (taskIds: string[]) =>
      bulkStatusValue.mutateAsync({ taskIds, value: "archived" }),
    bulkChangeStatus: ({ taskIds, status }: { taskIds: string[]; status: string }) =>
      bulkStatusValue.mutateAsync({ taskIds, value: status }),
    bulkAssign: ({ taskIds, userId }: { taskIds: string[]; userId: string }) =>
      bulkAssignOwnerOnly.mutateAsync({ taskIds, value: userId }),
    bulkMoveToBacklog: (taskIds: string[]) =>
      bulkStatusValue.mutateAsync({ taskIds, value: "planned" }),
    bulkMoveToBoard: ({ taskIds, status }: { taskIds: string[]; status: string }) =>
      bulkStatusValue.mutateAsync({ taskIds, value: status }),
    bulkPriority: ({ taskIds, priority }: { taskIds: string[]; priority: string }) =>
      bulkPriorityValue.mutateAsync({ taskIds, value: priority }),
    bulkAddLabel: bulkAddLabel.mutateAsync,
    bulkDueDate: ({ taskIds, dueDate }: { taskIds: string[]; dueDate: string | null }) =>
      bulkDueDateValue.mutateAsync({ taskIds, value: dueDate }),
  };

}
