import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type AgentSessionBindingView,
  bindAgentSessionToTask,
} from "@/fetchers/agent-session/agent-session-roster";

export function useBindAgentSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: bindAgentSessionToTask,
    onSuccess: () => {
      // Server truth flipped immediately; refresh the status + roster views.
      void queryClient.invalidateQueries({ queryKey: ["task-agent-binding"] });
      void queryClient.invalidateQueries({
        queryKey: ["agent-session-roster"],
      });
    },
  });
}

export type BindAgentSessionResult = AgentSessionBindingView;
