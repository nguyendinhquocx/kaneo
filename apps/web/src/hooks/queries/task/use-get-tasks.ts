import { useQuery } from "@tanstack/react-query";
import getTasks from "@/fetchers/task/get-tasks";
import {
  getShareFullProject,
  type ShareFullTask,
} from "@/fetchers/share/share-full-api";
import { getShareCapability } from "@/components/share/share-capability";
import type Task from "@/types/task";
import type { ProjectWithTasks } from "@/types/project";

function mapShareTask(task: ShareFullTask): Task {
  return {
    id: task.id,
    title: task.title,
    number: task.number,
    description: task.description,
    status: task.status,
    priority: task.priority,
    startDate: task.startDate ? task.startDate.toString() : null,
    dueDate: task.dueDate ? task.dueDate.toString() : null,
    position: task.position,
    createdAt: task.createdAt.toString(),
    userId: task.assigneeId,
    assigneeId: task.assigneeId,
    assigneeName: null,
    projectId: task.projectId,
    labels: (task.labels ?? []).map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color ?? "",
    })),
  };
}

export function useGetTasks(projectId: string) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? ["share-full", capability.token]
      : ["tasks", projectId],
    queryFn: async () => {
      if (capability) {
        const payload = await getShareFullProject(capability.token);
        // Same shape as the owner tasks payload so board/list components
        // render identically for capability holders.
        return {
          id: payload.id,
          name: payload.name,
          slug: payload.slug,
          icon: payload.icon,
          description: payload.description,
          workspaceId: "",
          isPublic: true,
          columns: payload.columns.map((column) => ({
            ...column,
            tasks: column.tasks.map(mapShareTask),
          })),
          archivedTasks: payload.archivedTasks.map(mapShareTask),
          plannedTasks: payload.plannedTasks.map(mapShareTask),
        } as unknown as ProjectWithTasks;
      }
      return getTasks(projectId);
    },
    refetchInterval: capability ? 10_000 : 30_000,
    enabled: !!projectId || Boolean(capability),
  });
}
