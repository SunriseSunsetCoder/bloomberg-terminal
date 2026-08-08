import { useQuery } from "@tanstack/react-query";

export interface FiredFlagDto {
  firedAt: string;
  fireClose: number | null;
  fireBar: number | null;
  firedStatus: "confirmed" | "late" | "resolved";
}

async function fetchFiredFlags(setupIds: number[]): Promise<Record<string, FiredFlagDto>> {
  if (setupIds.length === 0) return {};
  const res = await fetch(`/api/jack-decisions?setupIds=${setupIds.join(",")}`);
  const json = (await res.json()) as { fired?: Record<string, FiredFlagDto> };
  return json.fired ?? {};
}

/**
 * Close-confirmed FIRE flags for the board, keyed by setup_id.
 *
 * WHY A POLL: the board's rows come from the cached validation response (a Jotai atom
 * frozen at VALIDATE time), so a fire detected by the 18:00 EOD pass would otherwise
 * only appear after a manual reload or a re-VALIDATE. This re-reads the flags on the
 * SAME 180s cadence as useJackOpenPositions, so an evening fire lands on an
 * already-open terminal by itself.
 *
 * Cheap by construction: one GET against an endpoint the board already calls, reading
 * four indexed columns; no Tiingo, no LLM, no writes. Disabled entirely when there are
 * no setup ids (pre-VALIDATE, or persistence off).
 */
export function useJackFiredFlags(setupIds: number[]) {
  // Stable key: sort so a re-render with the same ids in a different order doesn't
  // look like a new query.
  const key = [...setupIds].sort((a, b) => a - b);
  return useQuery<Record<string, FiredFlagDto>, Error>({
    queryKey: ["jack-fired-flags", key.join(",")],
    queryFn: () => fetchFiredFlags(key),
    enabled: key.length > 0,
    staleTime: 60_000,
    refetchInterval: 180_000, // matches the open-positions board refetch
    refetchOnWindowFocus: true,
  });
}
