import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MobileProjectNav from "./mobile-project-nav";

vi.mock("@/hooks/queries/project/use-get-projects", () => ({
  default: () => ({
    data: [
      { id: "p-1", name: "Alpha", icon: "Folder" },
      { id: "p-2", name: "Beta", icon: "Folder" },
    ],
  }),
}));

afterEach(cleanup);

describe("MobileProjectNav view picker", () => {
  it("shows all five views on a two-column grid including Mind Map", () => {
    render(
      <MobileProjectNav
        workspaceId="ws-1"
        projectId="p-1"
        activeView="board"
        onSelectBoard={vi.fn()}
        onSelectBacklog={vi.fn()}
        onSelectGantt={vi.fn()}
        onSelectDocs={vi.fn()}
        onSelectMindMap={vi.fn()}
        onSelectProject={vi.fn()}
        onAddProject={vi.fn()}
      />,
    );

    // The trigger is an icon-only button; open the popover.
    fireEvent.click(screen.getByRole("button"));

    const mindMap = screen.getByRole("button", { name: "Mind Map" });
    expect(mindMap).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Backlog" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Board" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gantt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Docs" })).toBeInTheDocument();

    // Two-column grid for 5 views.
    expect(mindMap.parentElement).toHaveClass("grid-cols-2");

    // 44px coarse-pointer hit area is encoded on every view item.
    for (const name of ["Backlog", "Board", "Gantt", "Mind Map", "Docs"]) {
      expect(screen.getByRole("button", { name })).toHaveClass(
        "pointer-coarse:min-h-[44px]",
      );
    }
  });

  it("routes Mind Map selection through the callback", () => {
    const onSelectMindMap = vi.fn();
    render(
      <MobileProjectNav
        workspaceId="ws-1"
        projectId="p-1"
        activeView="mindmap"
        onSelectBoard={vi.fn()}
        onSelectBacklog={vi.fn()}
        onSelectGantt={vi.fn()}
        onSelectDocs={vi.fn()}
        onSelectMindMap={onSelectMindMap}
        onSelectProject={vi.fn()}
        onAddProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: "Mind Map" }));

    expect(onSelectMindMap).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Mind Map" })).toHaveClass(
      "border-border",
      "bg-secondary",
    );
  });
});
