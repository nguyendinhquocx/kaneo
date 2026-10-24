import { useParams } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { getShareCapability } from "@/components/share/share-capability";

function useActiveWorkspace() {
  // SPEC-2026-10-22: a capability holder has no workspace context. Surface a
  // synthetic active workspace (real project id, empty id) so shared toolbar
  // components keep working without ever reading workspace membership data.
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
    ? ({ id: capability.projectId, name: "" } as never)
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
