import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";

type DeleteWorkspaceRoleRequest = {
  workspaceId: string;
  roleName: string;
};

function useDeleteWorkspaceRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      workspaceId,
      roleName,
    }: DeleteWorkspaceRoleRequest) => {
      const result = await authClient.$fetch<{ success: boolean }>(
        "/organization/delete-role",
        {
          method: "POST",
          body: { organizationId: workspaceId, roleName },
        },
      );
      if (result.error) {
        throw new Error(result.error.message || "Failed to delete role");
      }
      return result.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["workspace-roles", variables.workspaceId],
      });
    },
  });
}

export default useDeleteWorkspaceRole;
