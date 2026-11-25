import { useQuery } from "@tanstack/react-query";
import { getShareCapability } from "@/components/share/share-capability";
import { getAgentSessionRoster } from "@/fetchers/agent-session/agent-session-roster";

// SPEC-2026-11-25 D4: fetch eagerly once so S0/S1 (render a picker or nothing)
// is decidable and bound cards can resolve exact session metadata. staleTime
// keeps repeat mounts cheap; a stale cache is refreshed when the popover opens.
// Never add a refetchInterval — presence updates ride user actions (the
// piggybacked heartbeat keeps server truth fresh).
export function useGetAgentSessionRoster(options: { enabled?: boolean } = {}) {
  const shareCapability = getShareCapability();
  return useQuery({
    queryKey: ["agent-session-roster"],
    queryFn: getAgentSessionRoster,
    enabled: !shareCapability && (options.enabled ?? true),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}
