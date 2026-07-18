import { useQuery } from "@tanstack/react-query";
import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";

export interface JackOpenPositionsResponse {
  ok: boolean;
  persistenceAvailable: boolean;
  positions: JackDecisionClient[];
  reason?: string;
  error?: string;
}

async function fetchOpenPositions(): Promise<JackOpenPositionsResponse> {
  const res = await fetch("/api/jack-open-positions");
  return (await res.json()) as JackOpenPositionsResponse;
}

/**
 * Open TRADED positions (entry logged, no exit yet) across ALL runs — so an open
 * trade stays reachable/closeable even when its ticker isn't in the current run.
 */
export function useJackOpenPositions() {
  return useQuery<JackOpenPositionsResponse, Error>({
    queryKey: ["jack-open-positions"],
    queryFn: fetchOpenPositions,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
