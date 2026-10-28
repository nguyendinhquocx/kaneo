export const TASK_PRIORITIES = [
  "no-priority",
  "low",
  "medium",
  "high",
  "urgent",
] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export function normalizeTaskPriority(
  priority: string | null | undefined,
): TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(priority ?? "")
    ? (priority as TaskPriority)
    : "no-priority";
}

type TaskLabel = {
  id: string;
  name: string;
  color: string;
};

type TaskExternalLink = {
  id: string;
  taskId: string;
  integrationId: string;
  resourceType: string;
  externalId: string;
  url: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
};

export type TaskMarkerCounts = {
  redCross: number;
  boxedRedCross: number;
  redCircle: number;
  greenCheck: number;
};

type Task = {
  id: string;
  title: string;
  number: number | null;
  description: string | null;
  status: string;
  priority: string | null;
  startDate: string | null;
  dueDate: string | null;
  position: number | null;
  createdAt: string;
  updatedAt?: string;
  userId: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeImage?: string | null;
  projectId: string;
  // SPEC-2026-10-27-kaneo-subtask-board-focus-markers: always present —
  // the API normalizes the full map and share mappings supply zero counts.
  workMarkerCounts: TaskMarkerCounts;
  columnId?: string | null;
  labels?: TaskLabel[];
  externalLinks?: TaskExternalLink[];
};

export default Task;
