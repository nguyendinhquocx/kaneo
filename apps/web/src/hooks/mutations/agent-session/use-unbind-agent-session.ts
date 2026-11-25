import { useMutation, useQueryClient } from "@tanstack/react-query";
import { unbindAgentSessionFromTask } from "@/fetchers/agent-session/agent-session-roster";

export function useUnbindAgentSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: unbindAgentSessionFromTask,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task-agent-binding"] });
      void queryClient.invalidateQueries({
        queryKey: ["agent-session-roster"],
      });
    },
  });
}
