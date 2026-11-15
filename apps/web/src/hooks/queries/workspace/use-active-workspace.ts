import { useParams } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { getShareCapability } from "@/components/share/share-capability";

function useActiveWorkspace() {
  // Capability holders have no authenticated workspace context. Keep only an
  // empty synthetic shell so owner components can render without triggering
  // member-list or organization lookups.
  const capability = getShareCapability();
  const { data: activeOrganization, error } =
    authClient.useActiveOrganization();
  const { data: organizations, isPending: isOrganizationsPending } =
    authClient.useListOrganizations();
  const { workspaceId } = useParams({
    strict: false,
    select: (params) => ({
      workspaceId:
        "workspaceId" in params && typeof params.workspaceId === "string"
          ? params.workspaceId
          : undefined,
    }),
  });

  const workspaceFromRoute = workspaceId
    ? organizations?.find((organization) => organization.id === workspaceId)
    : undefined;
  const workspace = capability
    ? ({ id: "", name: "" } as never)
    : (workspaceFromRoute ?? activeOrganization);
  const isLoading = capability
    ? false
    : (!!workspaceId && isOrganizationsPending && !workspaceFromRoute) ||
      (!workspace && !error);

  return {
    data: workspace,
    error,
    isLoading,
    isError: !!error,
  };
}

export default useActiveWorkspace;
