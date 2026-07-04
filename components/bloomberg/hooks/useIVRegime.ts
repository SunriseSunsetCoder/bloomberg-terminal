"use client";

import { useQuery } from "@tanstack/react-query";

export type IVRegime = "LOW_CONTANGO" | "NORMAL" | "ELEVATED" | "PANIC";

export interface IVRegimeData {
  schemaVersion: "1.0";
  timestamp: string;
  vix: number;
  vix3m: number | null;
  vix9d: number | null;
  termStructureRatio: number;
  termStructureSource: "VIX3M" | "VIX9D" | "NONE";
  termStructureState: "CONTANGO" | "FLAT" | "BACKWARDATION";
  ivRank: number;
  ivPercentile: number;
  regime: IVRegime;
  confidence: number;
  sampleSize: number;
  degraded: boolean;
  fromCache?: boolean;
}

export interface OptionsSignal {
  strategy: string;
  direction: "SHORT_VOL" | "LONG_VOL" | "NEUTRAL_VOL" | "DIRECTIONAL";
  strikeRule: string;
  dteBand: string;
  sizing: string;
  rationale: string;
  regimeFit: "STRONG" | "MODERATE" | "WEAK";
  warnings?: string[];
}

export interface OptionsSignalResponse {
  ticker: string;
  timestamp: string;
  regime: IVRegimeData;
  signal: OptionsSignal | null;
  ivProxyNote: string | null;
  fromCache?: boolean;
  error?: string;
}

export function useIVRegime() {
  return useQuery<IVRegimeData>({
    queryKey: ["iv-regime"],
    queryFn: async () => {
      const res = await fetch("/api/iv-regime");
      if (!res.ok) throw new Error(`IV regime fetch failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000, // 60s — VIX is daily, no need to poll faster
    staleTime: 30_000,
    retry: 1,
  });
}

export function ivRegimeColor(regime: IVRegime): string {
  switch (regime) {
    case "LOW_CONTANGO":
      return "text-green-400";
    case "NORMAL":
      return "text-amber-400";
    case "ELEVATED":
      return "text-orange-400";
    case "PANIC":
      return "text-red-400";
  }
}

export function ivRegimeBg(regime: IVRegime): string {
  switch (regime) {
    case "LOW_CONTANGO":
      return "bg-green-950 border-green-700";
    case "NORMAL":
      return "bg-amber-950 border-amber-700";
    case "ELEVATED":
      return "bg-orange-950 border-orange-700";
    case "PANIC":
      return "bg-red-950 border-red-700";
  }
}

export function termStructureColor(state: "CONTANGO" | "FLAT" | "BACKWARDATION"): string {
  if (state === "CONTANGO") return "text-green-400";
  if (state === "FLAT") return "text-amber-400";
  return "text-red-400";
}
