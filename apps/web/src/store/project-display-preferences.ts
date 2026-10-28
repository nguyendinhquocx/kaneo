import { useSyncExternalStore } from "react";

// SPEC-2026-10-27-kaneo-subtask-board-focus-markers: per-user/per-project
// display preferences, stored local-only. Keys are namespaced by BOTH userId
// and projectId so two accounts on the same browser never share state, and
// switching accounts swaps state before the board renders (the hook reads by
// key synchronously — no hydration effect, no flash of the wrong state).
// Values are intentionally not synced across devices.

export type ProjectDisplayPreferences = {
  /** null = follow the project's showSubtaskCardsByDefault value. */
  showSubtaskCards: boolean | null;
  /** null = preview enabled (the sensible default). */
  showNextSubtaskPreview: boolean | null;
  /** null = follow the project's showAssigneesByDefault value. */
  showAssignees: boolean | null;
  /** null = follow the project's showPriorityByDefault value. */
  showPriority: boolean | null;
};

export type ProjectDisplayDefaults = {
  showSubtaskCardsByDefault?: boolean | null;
  showAssigneesByDefault?: boolean | null;
  showPriorityByDefault?: boolean | null;
};

const DEFAULT_PREFERENCES: ProjectDisplayPreferences = {
  showSubtaskCards: null,
  showNextSubtaskPreview: null,
  showAssignees: null,
  showPriority: null,
};

export const PROJECT_DISPLAY_STORAGE_PREFIX = "kaneo:project-display";

export function projectDisplayStorageKey(userId: string, projectId: string) {
  return `${PROJECT_DISPLAY_STORAGE_PREFIX}:${userId}:${projectId}`;
}

const cache = new Map<string, ProjectDisplayPreferences>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function readFromStorage(key: string): ProjectDisplayPreferences {
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  let preferences = { ...DEFAULT_PREFERENCES };
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ProjectDisplayPreferences>;
        preferences = {
          showSubtaskCards:
            typeof parsed.showSubtaskCards === "boolean"
              ? parsed.showSubtaskCards
              : null,
          showNextSubtaskPreview:
            typeof parsed.showNextSubtaskPreview === "boolean"
              ? parsed.showNextSubtaskPreview
              : null,
          showAssignees:
            typeof parsed.showAssignees === "boolean"
              ? parsed.showAssignees
              : null,
          showPriority:
            typeof parsed.showPriority === "boolean"
              ? parsed.showPriority
              : null,
        };
      }
    } catch {
      preferences = { ...DEFAULT_PREFERENCES };
    }
  }
  cache.set(key, preferences);
  return preferences;
}

function writeToStorage(
  key: string,
  update: (current: ProjectDisplayPreferences) => ProjectDisplayPreferences,
) {
  const next = update(readFromStorage(key));
  cache.set(key, next);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Storage can be full/blocked — in-memory state still applies.
    }
  }
  notify();
}

export function useProjectDisplayPreferences(
  userId: string | null | undefined,
  projectId: string,
) {
  const key = projectDisplayStorageKey(userId ?? "", projectId);
  const preferences = useSyncExternalStore(
    subscribe,
    () => readFromStorage(key),
    () => DEFAULT_PREFERENCES,
  );

  return {
    preferences,
    setShowSubtaskCards: (value: boolean | null) =>
      writeToStorage(key, (current) => ({ ...current, showSubtaskCards: value })),
    setShowNextSubtaskPreview: (value: boolean | null) =>
      writeToStorage(key, (current) => ({
        ...current,
        showNextSubtaskPreview: value,
      })),
    setShowAssignees: (value: boolean | null) =>
      writeToStorage(key, (current) => ({ ...current, showAssignees: value })),
    setShowPriority: (value: boolean | null) =>
      writeToStorage(key, (current) => ({ ...current, showPriority: value })),
  };
}

/** Resolve local per-user overrides over the project's release-safe defaults. */
export function resolveProjectDisplayPreferences(
  preferences: ProjectDisplayPreferences,
  projectDefaults: ProjectDisplayDefaults = {},
) {
  return {
    showSubtaskCards:
      preferences.showSubtaskCards ??
      projectDefaults.showSubtaskCardsByDefault ??
      true,
    showNextSubtaskPreview: preferences.showNextSubtaskPreview ?? true,
    showAssignees:
      preferences.showAssignees ??
      projectDefaults.showAssigneesByDefault ??
      true,
    showPriority:
      preferences.showPriority ?? projectDefaults.showPriorityByDefault ?? true,
  };
}

// Test hook: drop all cached state without touching stored values.
export function resetProjectDisplayCacheForTests() {
  cache.clear();
}
