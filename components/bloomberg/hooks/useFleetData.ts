"use client";

import { useQuery } from "@tanstack/react-query";

export interface BotState {
  id: string;
  instrument: string;
  direction: string;
  isTradingBlocked: boolean;
  dailyPnL: number;
  dailyTrades: number;
  dailyWins: number;
  ddUsedPct: number;
  lastTradeAt: string | null;
  lastTradeResult: string | null;
}

export interface FleetState {
  schemaVersion: string;
  timestamp: string;
  sessionDate: string;
  bots: BotState[];
  meta: {
    ageSeconds: number;
    isStale: boolean;
    retrievedAt: string;
  };
}

async function fetchFleetState(): Promise<FleetState> {
  const res = await fetch("/api/fleet", { cache: "no-store" });
  if (!res.ok) throw new Error("Fleet data unavailable");
  return res.json();
}

export function useFleetData() {
  return useQuery({
    queryKey: ["fleet-state"],
    queryFn: fetchFleetState,
    refetchInterval: 30000, // poll every 30s
    staleTime: 25000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
