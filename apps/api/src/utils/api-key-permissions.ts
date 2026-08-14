import { statement } from "@kaneo/permissions";

/**
 * Explicit compatibility envelope for user API keys created by the UI.
 * Workspace membership and role permissions remain an independent gate.
 */
export const API_KEY_DEFAULT_PERMISSIONS = {
  // These are the only resources enforced by Kaneo's workspace middleware.
  // Better Auth organization-management statements are intentionally not
  // copied into this compatibility scope.
  project: [...statement.project],
  task: [...statement.task],
  execution: [...statement.execution],
  label: [...statement.label],
  workspace: [...statement.workspace],
} as const;

export const API_KEY_DEFAULT_PERMISSIONS_JSON = JSON.stringify(
  API_KEY_DEFAULT_PERMISSIONS,
);
