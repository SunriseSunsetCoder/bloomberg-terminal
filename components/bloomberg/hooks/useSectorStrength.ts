import { useQuery } from "@tanstack/react-query";
import type { SectorBoard } from "@/lib/sector-strength";

export interface SectorStrengthResponse extends SectorBoard {
  ok: boolean;
  generatedAt?: string;
  source?: "cache" | "tiingo";
  error?: string;
}

async function fetchSectorStrength(): Promise<SectorStrengthResponse> {
  const res = await fetch("/api/sector-strength");
  return (await res.json()) as SectorStrengthResponse;
}

/**
 * The 11 SPDR sector ETFs ranked by 3-month relative strength vs SPY. Result is
 * cached server-side in Redis (1-hr TTL); the client holds it ~1 hr too since EOD
 * data changes once a day.
 */
export function useSectorStrength() {
  return useQuery<SectorStrengthResponse, Error>({
    queryKey: ["sector-strength"],
    queryFn: fetchSectorStrength,
    staleTime: 3_600_000, // 1 hour
    gcTime: 3_600_000,
    refetchOnWindowFocus: false,
  });
}
