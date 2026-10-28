// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  projectDisplayStorageKey,
  resolveProjectDisplayPreferences,
  resetProjectDisplayCacheForTests,
  useProjectDisplayPreferences,
} from "./project-display-preferences";

describe("project display preferences storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetProjectDisplayCacheForTests();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetProjectDisplayCacheForTests();
  });

  it("namespaces stored state by userId AND projectId", () => {
    expect(projectDisplayStorageKey("user-a", "project-x")).toBe(
      "kaneo:project-display:user-a:project-x",
    );
    expect(projectDisplayStorageKey("user-b", "project-x")).not.toBe(
      projectDisplayStorageKey("user-a", "project-x"),
    );
    expect(projectDisplayStorageKey("user-a", "project-y")).not.toBe(
      projectDisplayStorageKey("user-a", "project-x"),
    );
  });

  it("keeps two accounts on the same browser independent", () => {
    const userA = renderHook(() =>
      useProjectDisplayPreferences("user-a", "project-x"),
    );
    const userB = renderHook(() =>
      useProjectDisplayPreferences("user-b", "project-x"),
    );

    act(() => {
      userA.result.current.setShowSubtaskCards(false);
    });

    expect(userA.result.current.preferences.showSubtaskCards).toBe(false);
    // User B never inherits User A's override on the same browser.
    expect(userB.result.current.preferences.showSubtaskCards).toBeNull();

    act(() => {
      userB.result.current.setShowNextSubtaskPreview(false);
    });
    expect(userA.result.current.preferences.showNextSubtaskPreview).toBeNull();
    expect(userB.result.current.preferences.showNextSubtaskPreview).toBe(false);

    act(() => {
      userA.result.current.setShowAssignees(false);
      userA.result.current.setShowPriority(true);
    });
    expect(userA.result.current.preferences.showAssignees).toBe(false);
    expect(userA.result.current.preferences.showPriority).toBe(true);
    expect(userB.result.current.preferences.showAssignees).toBeNull();
    expect(userB.result.current.preferences.showPriority).toBeNull();
  });

  it("swaps to the new account's stored state synchronously on account change", () => {
    window.localStorage.setItem(
      projectDisplayStorageKey("user-a", "project-x"),
      JSON.stringify({ showSubtaskCards: false, showNextSubtaskPreview: null }),
    );

    const hook = renderHook(({ userId }) =>
      useProjectDisplayPreferences(userId, "project-x"),
      { initialProps: { userId: "user-a" } },
    );

    expect(hook.result.current.preferences.showSubtaskCards).toBe(false);

    // Re-render with another account: state must reflect B before render
    // effects run — no stale A state, no hydration flash.
    act(() => {
      hook.rerender({ userId: "user-b" });
    });
    expect(hook.result.current.preferences.showSubtaskCards).toBeNull();
  });

  it("applies project defaults only when the local override is null", () => {
    const prefs = {
      showSubtaskCards: null,
      showNextSubtaskPreview: null,
      showAssignees: null,
      showPriority: null,
    };
    expect(
      resolveProjectDisplayPreferences(prefs, {
        showSubtaskCardsByDefault: false,
        showAssigneesByDefault: false,
        showPriorityByDefault: false,
      }),
    ).toEqual({
      showSubtaskCards: false,
      showNextSubtaskPreview: true,
      showAssignees: false,
      showPriority: false,
    });
    expect(
      resolveProjectDisplayPreferences(prefs, {
        showSubtaskCardsByDefault: true,
        showAssigneesByDefault: true,
        showPriorityByDefault: true,
      }),
    ).toEqual({
      showSubtaskCards: true,
      showNextSubtaskPreview: true,
      showAssignees: true,
      showPriority: true,
    });
    expect(
      resolveProjectDisplayPreferences(
        {
          showSubtaskCards: true,
          showNextSubtaskPreview: false,
          showAssignees: false,
          showPriority: true,
        },
        {
          showSubtaskCardsByDefault: false,
          showAssigneesByDefault: true,
          showPriorityByDefault: false,
        },
      ),
    ).toEqual({
      showSubtaskCards: true,
      showNextSubtaskPreview: false,
      showAssignees: false,
      showPriority: true,
    });
  });
});
