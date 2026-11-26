import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type AgentSessionBindingView,
  bindAgentSessionToTask,
} from "@/fetchers/agent-session/agent-session-roster";

export function useBindAgentSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: bindAgentSessionToTask,
    onMutate: async ({ taskId }) => {
      // A pre-bind status fetch can finish after the bind response and replace
      // the new generation with an old online/unbound cache snapshot.
      await queryClient.cancelQueries({
        queryKey: ["task-agent-binding", taskId],
        exact: true,
      });
    },
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
