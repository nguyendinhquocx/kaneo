import { describe, expect, it } from "vitest";
import { getTaskLinkPath } from "./task-link";

describe("task link path", () => {
  it("keeps full-share task links inside the bearer capability route", () => {
    expect(
      getTaskLinkPath({
        taskId: "task-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
        shareToken: "full-token",
      }),
    ).toBe("/share/project/full-token/task/task-1");
  });

  it("preserves the authenticated dashboard route for owner sessions", () => {
    expect(
      getTaskLinkPath({
        taskId: "task-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
      }),
    ).toBe("/dashboard/workspace/workspace-1/project/project-1/task/task-1");
  });
});
