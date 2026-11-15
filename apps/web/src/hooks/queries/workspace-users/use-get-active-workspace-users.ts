import { useQuery } from "@tanstack/react-query";
import getActiveWorkspaceUsers from "@/fetchers/workspace-user/get-active-workspace-users";
import { getShareFullMembers } from "@/fetchers/share/share-full-api";
import { getShareCapability } from "@/components/share/share-capability";

export function useGetActiveWorkspaceUsers(workspaceId: string) {
  const capability = getShareCapability();
  const hasFullProjectCapability =
    capability?.resourceType === "project" && capability.permission === "full";
  return useQuery({
    // Owner-approved disclosure for capability holders: id, name, avatar only.
    queryKey: capability
      ? capability.resourceType === "task"
        ? ["share-task", capability.token, "members"]
        : ["share-full", capability.token, "members"]
      : ["active-workspace-users", workspaceId],
    queryFn: async (): Promise<Awaited<ReturnType<typeof getActiveWorkspaceUsers>>> => {
      if (capability?.resourceType === "task") {
        // Task capabilities intentionally disclose no assignee identities.
        return { members: [], total: 0 } as Awaited<ReturnType<typeof getActiveWorkspaceUsers>>;
      }
      if (hasFullProjectCapability) {
        // Owner-approved disclosure: id, name, avatar. Mapped onto the owner
        // members shape so shared components render without branching.
        const members = await getShareFullMembers(capability.token);
        return {
          members: members.map((member) => ({
            userId: member.id,
            user: { name: member.name, image: member.avatarUrl },
          })),
        } as Awaited<ReturnType<typeof getActiveWorkspaceUsers>>;
      }
      return getActiveWorkspaceUsers({ workspaceId });
    },
    enabled: hasFullProjectCapability || (!capability && Boolean(workspaceId)),
  });
}
