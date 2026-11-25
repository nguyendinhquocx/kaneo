import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import {
  type AgentSessionRoster,
  getAgentSessionRoster,
} from "@/fetchers/agent-session/agent-session-roster";

// SPEC-2026-11-25 D4: the roster is fetched eagerly once so S0/S1 (render a
// picker or nothing) is decidable without any background polling. staleTime
// keeps repeat mounts cheap; a stale cache is refreshed when the popover
// opens. Never add a refetchInterval — presence updates ride user actions.
export function useGetAgentSessionRoster() {
  const shareCapability = getShareCapability();
  return useQuery({
    queryKey: ["agent-session-roster"],
    queryFn: getAgentSessionRoster,
    enabled: !shareCapability,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
