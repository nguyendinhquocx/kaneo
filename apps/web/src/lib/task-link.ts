export function getTaskLinkPath(options: {
  taskId: string;
  workspaceId: string;
  projectId: string;
  shareToken?: string;
}): string {
  if (options.shareToken) {
    return `/share/project/${options.shareToken}/task/${options.taskId}`;
  }
  return `/dashboard/workspace/${options.workspaceId}/project/${options.projectId}/task/${options.taskId}`;
}
