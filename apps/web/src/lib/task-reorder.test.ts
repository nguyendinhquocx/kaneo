import { describe, expect, it } from "vitest";
import type { ProjectBoardTask, ProjectWithTasks } from "@/types/project";
import {
  reorderProjectTasks,
  resolveTaskReorderIntent,
} from "./task-reorder";

function task(id: string, status: string, position: number): ProjectBoardTask {
  return {
    id,
    projectId: "project-1",
    title: id,
    number: position + 1,
    description: null,
    status,
    priority: "no-priority",
    startDate: null,
    dueDate: null,
    position,
    createdAt: "2026-10-28T00:00:00.000Z",
    userId: null,
    assigneeId: null,
    assigneeName: null,
    workMarkerCounts: {
      redCross: 0,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    },
    isSubtask: false,
    nextSubtaskPreview: null,
  };
}

function project(): ProjectWithTasks {
  return {
    id: "project-1",
    name: "Project",
    slug: "PRJ",
    icon: null,
    description: null,
    workspaceId: "workspace-1",
    isPublic: false,
    showSubtaskCardsByDefault: true,
    showAssigneesByDefault: true,
    showPriorityByDefault: true,
    columns: [
      {
        id: "todo",
        slug: "todo",
        name: "To Do",
        icon: null,
        isFinal: false,
        tasks: [task("a", "todo", 0), task("b", "todo", 1), task("c", "todo", 2)],
      },
      {
        id: "doing",
        slug: "doing",
        name: "Doing",
        icon: null,
        isFinal: false,
        tasks: [task("d", "doing", 0), task("e", "doing", 1)],
      },
    ],
    plannedTasks: [],
    archivedTasks: [],
  } as ProjectWithTasks;
}

function ids(items: ProjectBoardTask[]) {
  return items.map((item) => item.id);
}

describe("optimistic board task reorder", () => {
  it("preserves the existing same-lane before/after semantics and reindexes", () => {
    const current = project();
    const intent = resolveTaskReorderIntent(current, "b", "c");
    expect(intent).toEqual({
      taskId: "b",
      destinationStatus: "todo",
      targetTaskId: "c",
      placement: "after",
    });

    const result = reorderProjectTasks(current, intent!);
    expect(ids(result.project.columns[0]!.tasks)).toEqual(["a", "c", "b"]);
    expect(result.project.columns[0]!.tasks.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(result.changedTasks.map((item) => item.id)).toEqual(["c", "b"]);
  });

  it("moves a task across lanes before the network response and updates both lane positions", () => {
    const current = project();
    const intent = resolveTaskReorderIntent(current, "b", "d");
    expect(intent).toEqual({
      taskId: "b",
      destinationStatus: "doing",
      targetTaskId: "d",
      placement: "after",
    });

    const result = reorderProjectTasks(current, intent!);
    expect(ids(result.project.columns[0]!.tasks)).toEqual(["a", "c"]);
    expect(ids(result.project.columns[1]!.tasks)).toEqual(["d", "b", "e"]);
    expect(result.project.columns[0]!.tasks.map((item) => item.position)).toEqual([0, 1]);
    expect(result.project.columns[1]!.tasks.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(result.project.columns[1]!.tasks[1]?.status).toBe("doing");
  });

  it("drops onto an empty column at the end and leaves unrelated columns intact", () => {
    const current = project();
    const emptyColumn = {
      id: "review",
      slug: "review",
      name: "Review",
      icon: null,
      isFinal: false,
      tasks: [],
    };
    const withEmptyColumn = {
      ...current,
      columns: [...current.columns, emptyColumn],
    } as ProjectWithTasks;
    const intent = resolveTaskReorderIntent(withEmptyColumn, "b", "review");
    expect(intent?.placement).toBe("end");

    const result = reorderProjectTasks(withEmptyColumn, intent!);
    expect(ids(result.project.columns[0]!.tasks)).toEqual(["a", "c"]);
    expect(ids(result.project.columns[2]!.tasks)).toEqual(["b"]);
    expect(result.project.columns[1]).toEqual(current.columns[1]);
  });

  it("does not reorder when the drop target is the active task or unknown", () => {
    const current = project();
    expect(resolveTaskReorderIntent(current, "b", "b")).toBeNull();
    expect(resolveTaskReorderIntent(current, "b", "unknown")).toBeNull();
  });
});
