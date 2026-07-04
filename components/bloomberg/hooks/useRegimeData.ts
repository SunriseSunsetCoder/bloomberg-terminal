"use client";

import { useQuery } from "@tanstack/react-query";

export interface RegimeState {
  schemaVersion: string;
  timestamp: string;
  instrument: string;
  proxy: string;
  regime: "TRENDING_UP" | "TRENDING_DOWN" | "CHOPPY" | "BREAKOUT";
  confidence: number;
  atrPct: number;
  adx: number;
  realizedVolRatio: number;
}

export interface RegimeData {
  timestamp: string;
  regimes: {
    ES: RegimeState;
    NQ: RegimeState;
  };
  fromCache?: boolean;
}

async function fetchRegime(): Promise<RegimeData> {
  const res = await fetch("/api/regime", { cache: "no-store" });
  if (!res.ok) throw new Error("Regime data unavailable");
  return res.json();
}

export function useRegimeData() {
  return useQuery({
    queryKey: ["regime-data"],
    queryFn: fetchRegime,
    refetchInterval: 300000,
    staleTime: 290000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function regimeColor(regime: string): string {
  switch (regime) {
    case "TRENDING_UP": return "text-green-400";
    case "TRENDING_DOWN": return "text-red-400";
    case "BREAKOUT": return "text-yellow-400";
    case "CHOPPY": return "text-gray-400";
    default: return "text-gray-500";
  }
}

export function regimeBg(regime: string): string {
  switch (regime) {
    case "TRENDING_UP": return "bg-green-900/40 border-green-700";
    case "TRENDING_DOWN": return "bg-red-900/40 border-red-700";
    case "BREAKOUT": return "bg-yellow-900/40 border-yellow-700";
    case "CHOPPY": return "bg-gray-800/40 border-gray-600";
    default: return "bg-gray-800/40 border-gray-700";
  }
}