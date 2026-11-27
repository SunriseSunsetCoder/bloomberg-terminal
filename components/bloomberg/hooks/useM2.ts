"use client";

import { useQuery } from "@tanstack/react-query";
import type { M2Payload } from "@/lib/m2/server";

/** M2 panel data — polled every 60s (the route caches the IEX quote for 30s). */
export function useM2() {
  return useQuery<M2Payload>({
    queryKey: ["m2"],
    queryFn: async () => {
      const res = await fetch("/api/m2", { cache: "no-store" });
      const data = (await res.json()) as M2Payload;
      if (!res.ok && !data.ledger) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
