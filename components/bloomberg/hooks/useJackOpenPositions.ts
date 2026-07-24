import { useQuery } from "@tanstack/react-query";
import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";

export interface JackOpenPositionsResponse {
  ok: boolean;
  persistenceAvailable: boolean;
  positions: JackDecisionClient[];
  // Provenance of the NOW prices: which refresh wrote them, when, and whether IEX
  // was unavailable (→ prices are last-close, surfaced as a header notice).
  priceMeta?: { mode: "intraday" | "eod"; asOf: string | null; iexUnavailable: boolean };
  reReadAvailable?: boolean;
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
    // Self-refetch so the 10:00 / 18:00 ET scheduled refreshes reach an already-open
    // terminal without a manual reload. With the Redis-first price read this is cheap
    // — a refetch re-reads jack:prices + recomputes unrealized (no Tiingo, no LLM).
    refetchInterval: 180_000,
    refetchOnWindowFocus: true,
  });
}
