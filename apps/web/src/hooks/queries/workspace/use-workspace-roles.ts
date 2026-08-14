import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";

export type WorkspaceRole = {
  id: string;
  workspaceId: string;
  role: string;
  permission: Record<string, string[]>;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
};

function parsePermission(raw: unknown): Record<string, string[]> {
  if (raw && typeof raw === "object") {
    return raw as Record<string, string[]>;
  }
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, string[]>;
    }
    return {};
  } catch {
    return {};
  }
}

function useWorkspaceRoles(workspaceId: string | undefined) {
  return useQuery<WorkspaceRole[]>({
    queryKey: ["workspace-roles", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      if (!workspaceId) return [];
      // Better Auth 1.6 exposes the dynamic-role endpoints on the server
      // plugin, but not as typed organization client actions. Keep the raw
      // endpoint call in this hook rather than pretending those actions exist.
      const result = await authClient.$fetch<
        Array<{
          id: string;
          organizationId: string;
          role: string;
          permission: Record<string, string[]>;
          createdAt: Date | string;
          updatedAt?: Date | string | null;
        }>
      >("/organization/list-roles", {
        method: "GET",
        query: { organizationId: workspaceId },
      });
      if (result.error) throw new Error(result.error.message);
      const roles = result.data ?? [];

      return roles.map((r) => ({
        id: r.id,
        workspaceId: r.organizationId,
        role: r.role,
        permission: parsePermission(r.permission),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    },
  });
}

export default useWorkspaceRoles;
