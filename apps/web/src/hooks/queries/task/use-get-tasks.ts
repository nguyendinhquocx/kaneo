import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import {
  getShareFullProject,
  type ShareFullProjectPayload,
  type ShareFullTask,
} from "@/fetchers/share/share-full-api";
import getTasks from "@/fetchers/task/get-tasks";
import type { ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";

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

export function mapShareFullProjectPayload(
  payload: ShareFullProjectPayload,
): ProjectWithTasks {
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

export function useGetTasks(
  projectId: string,
  initialShareProject?: ProjectWithTasks,
) {
  const capability = getShareCapability();
  return useQuery({
    queryKey: capability
      ? ["share-full", capability.token]
      : ["tasks", projectId],
    queryFn: async () => {
      if (capability) {
        const payload = await getShareFullProject(capability.token);
        return mapShareFullProjectPayload(payload);
      }
      return getTasks(projectId);
    },
    initialData: capability ? initialShareProject : undefined,
    staleTime: capability ? 10_000 : 0,
    refetchInterval: capability ? 10_000 : 30_000,
    enabled: !!projectId || Boolean(capability),
  });
}
