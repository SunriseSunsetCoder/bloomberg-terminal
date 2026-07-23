"use client";

import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";
import { useTickerHistory } from "../hooks/useTickerHistory";
import { historyWindow, closesFromBars } from "@/lib/candle-chart";

interface CandleThumbnailProps {
  decision: JackDecisionClient;
  isDarkMode: boolean;
  onOpen: () => void;
}

// Cheap, SSR-safe preview: an inline-SVG sparkline of recent closes (no canvas, no
// lightweight-charts). Only mounts inside the expand (one row at a time), so its
// useTickerHistory fetch is inherently lazy AND warms the modal's shared cache.
export function CandleThumbnail({ decision, isDarkMode, onOpen }: CandleThumbnailProps) {
  const startDate = historyWindow(decision.handleLowDate)?.startDate ?? null;
  const { data, isLoading } = useTickerHistory(decision.ticker, startDate);

  const closes = data?.bars ? closesFromBars(data.bars) : [];
  const W = 120;
  const H = 32;

  let poly = "";
  let up = true;
  if (closes.length >= 2) {
    const lo = Math.min(...closes);
    const hi = Math.max(...closes);
    const range = hi - lo || 1;
    const stepX = W / (closes.length - 1);
    poly = closes
      .map((c, i) => `${(i * stepX).toFixed(1)},${(H - 2 - ((c - lo) / range) * (H - 4)).toFixed(1)}`)
      .join(" ");
    up = closes[closes.length - 1] >= closes[0];
  }

  const stroke = up ? (isDarkMode ? "#22c55e" : "#16a34a") : isDarkMode ? "#ef4444" : "#dc2626";
  const sub = isDarkMode ? "text-gray-400" : "text-gray-600";
  const border = isDarkMode ? "border-orange-900/60" : "border-orange-200";

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={closes.length < 2}
      className={`inline-flex items-center gap-1.5 rounded border ${border} px-1.5 py-1 hover:opacity-80 disabled:opacity-40`}
      title={`Open ${decision.ticker} candle chart (handle low − 20d → today) with the setup levels overlaid`}
    >
      {closes.length >= 2 ? (
        <svg width={W} height={H} className="block" aria-hidden="true">
          <polyline points={poly} fill="none" stroke={stroke} strokeWidth={1} />
        </svg>
      ) : (
        <span className={`text-[10px] font-mono ${sub} text-center`} style={{ width: W }}>
          {isLoading ? "loading chart…" : "chart"}
        </span>
      )}
      <span className={`text-[9px] uppercase tracking-widest ${sub}`}>chart ↗</span>
    </button>
  );
}
