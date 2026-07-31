import { useQuery } from "@tanstack/react-query";
import type { JackScorecard } from "@/lib/jack/scorecard";

export interface JackScorecardResponse {
  ok: boolean;
  persistenceAvailable: boolean;
  reason?: string;
  scorecard?: JackScorecard;
  error?: string;
}

async function fetchScorecard(riskPerTrade: number): Promise<JackScorecardResponse> {
  const res = await fetch(`/api/jack-scorecard?risk=${encodeURIComponent(riskPerTrade)}`);
  return (await res.json()) as JackScorecardResponse;
}

/**
 * Read-only JACK performance scorecard. Manual refetch only — the underlying data
 * changes on validation runs / fill saves / outcome-tracker passes, not continuously.
 * riskPerTrade only rescales the $ axis (R math is risk-independent), so it is part
 * of the query key and re-fetches when the user rescales.
 */
export function useJackScorecard(riskPerTrade: number) {
  return useQuery<JackScorecardResponse, Error>({
    queryKey: ["jack-scorecard", riskPerTrade],
    queryFn: () => fetchScorecard(riskPerTrade),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
