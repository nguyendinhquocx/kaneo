import { useMutation, useQueryClient } from "@tanstack/react-query";
import type getEmbeddedServicesConfig from "@/fetchers/embedded-integration/get-workspace-config";
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
    onSuccess: (serviceConfig, variables) => {
      const queryKey = ["embedded-services-config", workspaceId] as const;
      queryClient.setQueryData<
        Awaited<ReturnType<typeof getEmbeddedServicesConfig>>
      >(queryKey, (current) =>
        current ? { ...current, [variables.service]: serviceConfig } : current,
      );
    },
  });
}

export default useSetEmbeddedServiceEnabled;
