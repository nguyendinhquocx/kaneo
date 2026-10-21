import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskDescription from "./task-description";

const { editorDependencies, t } = vi.hoisted(() => ({
  editorDependencies: [] as unknown[][],
  t: (key: string) => key,
}));

vi.mock("@tiptap/react", () => ({
  useEditor: (_options: unknown, dependencies: unknown[]) => {
    editorDependencies.push([...dependencies]);
    return null;
  },
  EditorContent: () => null,
}));
vi.mock("@tiptap/react/menus", () => ({ BubbleMenu: () => null }));
vi.mock("@/hooks/queries/task/use-get-task", () => ({
  default: (taskId: string) => ({
    data: {
      id: taskId,
      title: taskId,
      number: 1,
      description: "",
      status: "to-do",
      priority: "no-priority",
      startDate: null,
      dueDate: null,
      position: 1,
      createdAt: "2026-10-21T00:00:00.000Z",
      userId: null,
      assigneeId: null,
      assigneeName: null,
      projectId: "project-1",
    },
  }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-description", () => ({
  useUpdateTaskDescription: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageTasks: () => true,
    canManageShareLinks: () => false,
  }),
}));
vi.mock("@/lib/shiki-highlighter", () => ({
  getSharedShikiHighlighter: () => new Promise(() => {}),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  editorDependencies.length = 0;
});

describe("TaskDescription editor lifecycle", () => {
  it("keeps the editor instance stable when navigating from a child task to its parent", () => {
    const view = render(<TaskDescription taskId="child-task" />);
    const childDependencies = editorDependencies.at(-1);
    expect(childDependencies).toHaveLength(4);

    view.rerender(<TaskDescription taskId="parent-task" />);
    const parentDependencies = editorDependencies.at(-1);
    expect(parentDependencies).toHaveLength(4);

    parentDependencies?.forEach((dependency, index) => {
      expect(dependency).toBe(childDependencies?.[index]);
    });
  });
});
