// SPEC-2026-11-10-kaneo-card-agent-collaboration T3: every task-field write
// must send the content CAS token the client last read. Cached Task objects
// carry `contentRevision` from the API; legacy caches without it fall back to
// 1, which can only ever produce a recoverable 409 (never a silent
// overwrite).

export function getExpectedContentRevision(
  task?: { contentRevision?: number | null } | null,
): number {
  return typeof task?.contentRevision === "number" && task.contentRevision >= 1
    ? task.contentRevision
    : 1;
}

// Bulk writes CAS every touched card. Resolve each revision from the task
// cache; unknown ids fall back to 1 so the server answers with a typed 409
// instead of a blind write.
export function collectExpectedContentRevisions(
  readTask: (taskId: string) => { contentRevision?: number | null } | undefined,
  taskIds: string[],
): Record<string, number> {
  const revisions: Record<string, number> = {};
  for (const taskId of taskIds) {
    revisions[taskId] = getExpectedContentRevision(readTask(taskId));
  }
  return revisions;
}
