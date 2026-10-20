import { describe, expect, it } from "vitest";
import {
  moveTaskId,
  reorderSubtaskRelations,
  reorderTaskCardsBySiblingLane,
} from "./subtask-order";

const relation = (
  relationType: string,
  sourceTaskId: string,
  targetTaskId: string,
  position: number,
) => ({ relationType, sourceTaskId, targetTaskId, position });

describe("subtask order", () => {
  it("moves a sibling without crossing either end of the list", () => {
    expect(moveTaskId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveTaskId(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveTaskId(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });

  it("reorders only subtask relations for the selected parent", () => {
    const unrelated = relation("blocks", "parent", "a", 9);
    const relations = [
      relation("subtask", "parent", "a", 0),
      unrelated,
      relation("subtask", "parent", "b", 1),
      relation("subtask", "other-parent", "a", 2),
    ];

    const result = reorderSubtaskRelations(relations, "parent", ["b", "a"]);

    expect(result[0]).toMatchObject({ targetTaskId: "b", position: 0 });
    expect(result[1]).toBe(unrelated);
    expect(result[2]).toMatchObject({ targetTaskId: "a", position: 1 });
    expect(result[3]).toBe(relations[3]);
  });

  it("reorders sibling cards within each lane and keeps other cards in relative order", () => {
    const tasks = [
      { id: "other-1", status: "todo", position: 0 },
      { id: "sibling-a", status: "todo", position: 1 },
      { id: "other-2", status: "todo", position: 2 },
      { id: "sibling-b", status: "todo", position: 3 },
      { id: "sibling-c", status: "done", position: 0 },
      { id: "other-3", status: "done", position: 1 },
    ];

    const result = reorderTaskCardsBySiblingLane(tasks, [
      "sibling-b",
      "sibling-c",
      "sibling-a",
    ]);

    expect(
      result
        .filter((task) => task.status === "todo")
        .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
        .map((task) => task.id),
    ).toEqual(["other-1", "sibling-b", "other-2", "sibling-a"]);
    expect(
      result
        .filter((task) => task.status === "done")
        .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
        .map((task) => task.id),
    ).toEqual(["sibling-c", "other-3"]);
  });
});
