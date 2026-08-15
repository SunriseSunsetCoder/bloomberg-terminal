import { useQuery } from "@tanstack/react-query";
import type { BasketCandidate, OpenHolding } from "@/lib/jack/basket";

export interface JackBasketFeed {
  ok: boolean;
  persistenceAvailable: boolean;
  reason?: string;
  candidates?: BasketCandidate[];
  open?: OpenHolding[];
  /** Size of the un-narrowed pending pipeline, for the empty state. */
  pendingTotal?: number;
  /** Size of the board's LIVE display group before the basket's filters. */
  boardLiveTotal?: number;
  /** Per-feed failures — one half can fail while the other still returns data. */
  candidatesError?: string;
  openError?: string;
  error?: string;
}

async function fetchBasketFeed(): Promise<JackBasketFeed> {
  const res = await fetch("/api/jack-basket");
  return (await res.json()) as JackBasketFeed;
}

/**
 * Live feed for the Basket Sizer: the run-scoped pending set + the open book.
 *
 * `enabled` is the page's LIVE toggle — off means manual rows only, and the query is
 * not issued at all. Same 180s cadence as the rest of the board so an EOD change shows
 * up without a reload.
 */
export function useJackBasket(enabled: boolean) {
  return useQuery<JackBasketFeed, Error>({
    queryKey: ["jack-basket"],
    queryFn: fetchBasketFeed,
    enabled,
    staleTime: 60_000,
    refetchInterval: 180_000,
    refetchOnWindowFocus: true,
  });
}
