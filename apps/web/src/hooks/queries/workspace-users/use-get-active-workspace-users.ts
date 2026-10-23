import { useQuery } from "@tanstack/react-query";
import getActiveWorkspaceUsers from "@/fetchers/workspace-user/get-active-workspace-users";
import { getShareFullMembers } from "@/fetchers/share/share-full-api";
import { getShareCapability } from "@/components/share/share-capability";

export function useGetActiveWorkspaceUsers(workspaceId: string) {
  const capability = getShareCapability();
  return useQuery({
    // Owner-approved disclosure for capability holders: id, name, avatar only.
    queryKey: capability
      ? ["share-full", capability.token, "members"]
      : ["active-workspace-users", workspaceId],
    queryFn: async (): Promise<Awaited<ReturnType<typeof getActiveWorkspaceUsers>>> => {
      if (capability) {
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
    enabled: Boolean(capability || workspaceId),
  });
}
