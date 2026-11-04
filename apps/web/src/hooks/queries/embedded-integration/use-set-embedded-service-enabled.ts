import { useMutation, useQueryClient } from "@tanstack/react-query";
import setEmbeddedServiceEnabled from "@/fetchers/embedded-integration/set-service-enabled";

function useSetEmbeddedServiceEnabled(workspaceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      service,
      enabled,
    }: {
      service: "mitra" | "wisemapping";
      enabled: boolean;
    }) => setEmbeddedServiceEnabled({ workspaceId, service, enabled }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["embedded-services-config", workspaceId],
      }),
  });
}

export default useSetEmbeddedServiceEnabled;
