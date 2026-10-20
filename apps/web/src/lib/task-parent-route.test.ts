import { describe, expect, it } from "vitest";
import { getParentTaskRouteParams } from "./task-parent-route";

describe("getParentTaskRouteParams", () => {
  it("uses the parent task project when it belongs to another project", () => {
    expect(
      getParentTaskRouteParams({
        workspaceId: "workspace-a",
        currentProjectId: "child-project",
        parentTaskId: "parent-task",
        parentProjectId: "parent-project",
      }),
    ).toEqual({
      workspaceId: "workspace-a",
      projectId: "parent-project",
      taskId: "parent-task",
    });
  });
});
