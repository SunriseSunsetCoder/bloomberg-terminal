import { useQuery } from "@tanstack/react-query";
import type { OhlcBar } from "@/lib/candle-chart";

export interface TickerHistoryResponse {
  ticker: string;
  bars: OhlcBar[];
  latestClose?: number;
  latestDate?: string;
  source?: string;
  error?: string;
}

async function fetchHistory(ticker: string, startDate: string): Promise<TickerHistoryResponse> {
  // raw=1 → UNADJUSTED OHLC so the candles line up with the nominal breakout/stop/
  // target levels (the same reason the outcome replay uses raw). endDate defaults to
  // today server-side.
  const res = await fetch(`/api/tiingo/eod/${encodeURIComponent(ticker)}?startDate=${startDate}&raw=1`);
  return (await res.json()) as TickerHistoryResponse;
}

/**
 * Daily OHLC for a setup's chart window (handle_low − 20d → today). Keyed by
 * ticker + startDate so the thumbnail (in the expand) and the modal share ONE
 * cached fetch — the modal opens instantly off the warm cache. Long staleTime
 * since EOD data changes once a day. Disabled until both inputs are present.
 */
export function useTickerHistory(ticker: string | null, startDate: string | null) {
  return useQuery<TickerHistoryResponse, Error>({
    queryKey: ["ticker-history", ticker, startDate],
    queryFn: () => fetchHistory(ticker as string, startDate as string),
    enabled: !!ticker && !!startDate,
    staleTime: 12 * 60 * 60 * 1000, // 12 hours
    gcTime: 12 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
