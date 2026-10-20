export function getParentTaskRouteParams(input: {
  workspaceId: string;
  currentProjectId: string;
  parentTaskId: string;
  parentProjectId?: string | null;
}) {
  return {
    workspaceId: input.workspaceId,
    projectId: input.parentProjectId || input.currentProjectId,
    taskId: input.parentTaskId,
  };
}
