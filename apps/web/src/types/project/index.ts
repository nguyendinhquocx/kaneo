import type { client } from "@kaneo/libs";
import type { InferResponseType } from "hono/client";
import type Task from "@/types/task";

export type Project = Extract<
  InferResponseType<(typeof client)["project"][":id"]["$get"], 200>,
  { id: string }
>;

// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: board/list tasks carry
// the same-project subtask projection computed by the API.
export type ProjectBoardTask = Task & {
  isSubtask: boolean;
  nextSubtaskPreview: Pick<Task, "id" | "title" | "workMarkerCounts"> | null;
};

type TasksApiResponse = InferResponseType<
  (typeof client)["task"]["tasks"][":projectId"]["$get"],
  200
>;

type ProjectWithTasksRaw = TasksApiResponse["data"];

export type ProjectWithTasks = Omit<
  ProjectWithTasksRaw,
  "archivedTasks" | "columns" | "plannedTasks"
> & {
  archivedTasks: ProjectBoardTask[];
  columns: Array<
    Omit<ProjectWithTasksRaw["columns"][number], "tasks"> & {
      tasks: ProjectBoardTask[];
    }
  >;
  plannedTasks: ProjectBoardTask[];
};
