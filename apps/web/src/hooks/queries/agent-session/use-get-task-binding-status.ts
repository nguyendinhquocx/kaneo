import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import { getTaskAgentBindingStatus } from "@/fetchers/agent-session/get-task-binding-status";

export function useGetTaskBindingStatus(taskId: string) {
  const shareCapability = getShareCapability();
  return useQuery({
    queryKey: ["task-agent-binding", taskId],
    queryFn: () => getTaskAgentBindingStatus(taskId),
    enabled: Boolean(taskId && !shareCapability),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}
