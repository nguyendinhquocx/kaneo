import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getShareCapability } from "@/components/share/share-capability";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import { useGetActiveWorkspaceUser } from "@/hooks/queries/workspace-users/use-active-workspace-user";
import { authClient } from "@/lib/auth-client";

export type PermissionLevel = "owner" | "admin" | "member";

// Capabilities are named permission bundles checked against the SERVER via
// better-auth's `/organization/has-permission` endpoint. Going through the
// server is what makes custom workspace roles work in the UI — the local
// `checkRolePermission` only knows about the four static roles compiled
// into the auth client, so it would silently return false for any custom
// role that grants the permission.
const CAPABILITIES = {
  manageProjects: { project: ["create", "update", "delete"] },
  createProjects: { project: ["create"] },
  deleteProjects: { project: ["delete"] },
  manageTasks: { task: ["create", "update", "delete"] },
  reviewExecutions: { execution: ["review"] },
  createTasks: { task: ["create"] },
  assignTasks: { task: ["assign"] },
  // SPEC-2026-10-08-kaneo-workspace-collaboration: documents are project work
  // content (task:update) and share-link management is project:share.
  // R2-T4: hard-deleting a document needs task:delete (admin/owner).
  writeDocuments: { task: ["update"] },
  deleteDocuments: { task: ["delete"] },
  manageShareLinks: { project: ["share"] },
  manageLabels: { label: ["create", "update", "delete"] },
  manageWorkspace: { workspace: ["update", "manage_settings"] },
  deleteWorkspace: { workspace: ["delete"] },
  inviteUsers: { invitation: ["create"] },
  manageTeam: { member: ["update", "delete"] },
  removeMembers: { member: ["delete"] },
} as const satisfies Record<string, Record<string, string[]>>;

type Capability = keyof typeof CAPABILITIES;

type CapabilityMap = Record<Capability, boolean>;

function emptyCapabilityMap(): CapabilityMap {
  const out = {} as CapabilityMap;
  for (const key of Object.keys(CAPABILITIES) as Capability[]) {
    out[key] = false;
  }
  return out;
}

export function useWorkspacePermission() {
  const { data: activeWorkspace } = useActiveWorkspace();
  const { data: activeMember } = useGetActiveWorkspaceUser();
  const workspaceId = activeWorkspace?.id;
  const role = activeMember?.role as string | undefined;

  // SPEC-2026-10-22: a full capability holder gets exactly the T1 matrix
  // capabilities — ordinary project work — and never workspace administration
  // or share-link management.
  const capability = getShareCapability();
  const capabilityMap = useMemo(() => {
    if (!capability) return null;
    const map = emptyCapabilityMap();
    map.createTasks = true;
    map.manageTasks = true;
    map.assignTasks = true;
    map.writeDocuments = true;
    map.deleteDocuments = true;
    map.manageLabels = true;
    return map;
  }, [capability]);

  // One query that fans out to all capability checks in parallel and caches
  // the resulting map by (workspaceId, role). Refetches when either changes
  // — e.g., when the admin edits the role's permissions in the Roles UI and
  // we invalidate this key.
  const {
    data: capabilities,
    isLoading,
    isFetching,
  } = useQuery({
    queryKey: ["workspace-capabilities", workspaceId, role],
    enabled: Boolean(!capabilityMap && workspaceId && role),
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<CapabilityMap> => {
      const entries = Object.entries(CAPABILITIES) as Array<
        [Capability, Record<string, string[]>]
      >;
      const results = await Promise.all(
        entries.map(async ([key, permissions]) => {
          try {
            const res = await authClient.organization.hasPermission({
              organizationId: workspaceId,
              permissions,
            });
            return [key, res.data?.success === true] as const;
          } catch (error) {
            console.error(`hasPermission check failed for ${key}:`, error);
            return [key, false] as const;
          }
        }),
      );
      const map = emptyCapabilityMap();
      for (const [key, value] of results) {
        map[key] = value;
      }
      return map;
    },
  });

  const can: CapabilityMap = capabilityMap ?? capabilities ?? emptyCapabilityMap();

  const helpers = useMemo(() => {
    return {
      canManageProjects: () => can.manageProjects,
      canCreateProjects: () => can.createProjects,
      canDeleteProjects: () => can.deleteProjects,
      canManageTasks: () => can.manageTasks,
      canReviewExecutions: () => can.reviewExecutions,
      canCreateTasks: () => can.createTasks,
      canAssignTasks: () => can.assignTasks,
      canManageLabels: () => can.manageLabels,
      canManageWorkspace: () => can.manageWorkspace,
      canDeleteWorkspace: () => can.deleteWorkspace,
      canInviteUsers: () => can.inviteUsers,
      canManageTeam: () => can.manageTeam,
      canRemoveMembers: () => can.removeMembers,
      canWriteDocuments: () => can.writeDocuments,
      canDeleteDocuments: () => can.deleteDocuments,
      canManageShareLinks: () => can.manageShareLinks,
      // Escape hatch for ad-hoc permission checks (uncached). Prefer adding
      // a capability above.
      hasPermission: async (permissions: Record<string, string[]>) => {
        if (getShareCapability()) {
          // Only the project-work capabilities above are granted to a
          // capability holder; everything else denies.
          return Object.entries(permissions).every(([resource, actions]) => {
            if (resource === "task") {
              return actions.every((action) =>
                ["create", "update", "delete", "assign"].includes(action),
              );
            }
            if (resource === "label") {
              return true;
            }
            return false;
          });
        }
        try {
          const res = await authClient.organization.hasPermission({
            organizationId: workspaceId,
            permissions,
          });
          return res.data?.success === true;
        } catch (error) {
          console.error("hasPermission check failed:", error);
          return false;
        }
      },
    };
  }, [can, workspaceId]);

  return {
    ...helpers,
    workspace: activeWorkspace,
    member: activeMember,
    role: capabilityMap ? "member" : role,
    isOwner: capabilityMap ? false : role === "owner",
    isAdmin: capabilityMap ? false : role === "owner" || role === "admin",
    // True while the first capability fetch is in flight. Useful for hiding
    // action UI during the initial render instead of flashing it on then
    // off when the server check resolves.
    isCheckingPermissions:
      !capabilityMap && Boolean(workspaceId && role) && (isLoading || !capabilities),
    isRefetchingPermissions: capabilityMap ? false : isFetching,
  };
}
