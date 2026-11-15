import { describe, expect, it } from "vitest";
import type { ShareFullProjectPayload } from "@/fetchers/share/share-full-api";
import { mapShareFullProjectPayload } from "./use-get-tasks";

describe("mapShareFullProjectPayload", () => {
  it("preserves labels and safe subtask preview for board cards", () => {
    const payload: ShareFullProjectPayload = {
      id: "project-1",
      name: "Project",
      slug: "project",
      icon: null,
      description: null,
      scope: "full",
      columns: [
        {
          id: "implement",
          slug: "implement",
          name: "Implement",
          icon: null,
          isFinal: false,
          tasks: [
            {
              id: "parent-1",
              projectId: "project-1",
              number: 1,
              title: "Parent card",
              description: null,
              status: "implement",
              priority: null,
              startDate: null,
              dueDate: null,
              position: 0,
              createdAt: "2026-11-15T00:00:00.000Z",
              assigneeId: null,
              contentRevision: 1,
              labels: [{ id: "label-1", name: "UAT", color: "#123456" }],
              isSubtask: false,
              nextSubtaskPreview: {
                id: "child-1",
                title: "Next child",
                workMarkerCounts: {
                  redCross: 0,
                  boxedRedCross: 0,
                  redCircle: 0,
                  greenCheck: 0,
                },
              },
            },
          ],
        },
      ],
      archivedTasks: [],
      plannedTasks: [],
    };

    const project = mapShareFullProjectPayload(payload);
    const [task] = project.columns[0].tasks;

    expect(task.labels).toEqual([
      { id: "label-1", name: "UAT", color: "#123456" },
    ]);
    expect(task.isSubtask).toBe(false);
    expect(task.nextSubtaskPreview).toEqual({
      id: "child-1",
      title: "Next child",
      workMarkerCounts: {
        redCross: 0,
        boxedRedCross: 0,
        redCircle: 0,
        greenCheck: 0,
      },
    });
  });
});
