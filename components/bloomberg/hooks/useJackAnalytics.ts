import { useQuery } from "@tanstack/react-query";
import type { JackAnalytics } from "@/lib/jack/analytics";

export interface JackAnalyticsResponse {
  ok: boolean;
  persistenceAvailable: boolean;
  reason?: string;
  analytics?: JackAnalytics;
  error?: string;
}

async function fetchAnalytics(): Promise<JackAnalyticsResponse> {
  const res = await fetch("/api/jack-analytics");
  return (await res.json()) as JackAnalyticsResponse;
}

/**
 * Read-only JACK analytics. Manual refetch only (data changes only on validation
 * runs / fill saves / outcome-tracker runs, not continuously).
 */
export function useJackAnalytics() {
  return useQuery<JackAnalyticsResponse, Error>({
    queryKey: ["jack-analytics"],
    queryFn: fetchAnalytics,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
