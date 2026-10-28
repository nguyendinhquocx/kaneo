import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectDisplayMenu from "./project-display-menu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("ProjectDisplayMenu", () => {
  it("exposes four independent display switches", () => {
    const setters = {
      setShowSubtaskCards: vi.fn(),
      setShowNextSubtaskPreview: vi.fn(),
      setShowAssignees: vi.fn(),
      setShowPriority: vi.fn(),
    };
    render(
      <ProjectDisplayMenu
        showSubtaskCards={false}
        showNextSubtaskPreview
        showAssignees={false}
        showPriority={false}
        {...setters}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "tasks:display.menu" }));
    const assigneeSwitch = screen.getByRole("menuitemcheckbox", {
      name: "tasks:display.showAssignees",
    });
    const prioritySwitch = screen.getByRole("menuitemcheckbox", {
      name: "tasks:display.showPriority",
    });
    expect(assigneeSwitch).toHaveAttribute("aria-checked", "false");
    expect(prioritySwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(assigneeSwitch);
    expect(setters.setShowAssignees.mock.calls[0]?.[0]).toBe(true);
    expect(setters.setShowPriority).not.toHaveBeenCalled();
  });
});
