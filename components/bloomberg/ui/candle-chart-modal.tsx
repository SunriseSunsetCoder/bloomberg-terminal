"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { IChartApi, Time, CandlestickData, HistogramData, SeriesMarker } from "lightweight-charts";
import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";
import { useTickerHistory } from "../hooks/useTickerHistory";
import { historyWindow, mapBarsToCandles, buildPriceLines, LEVEL_COLORS } from "@/lib/candle-chart";

interface CandleChartModalProps {
  decision: JackDecisionClient;
  isDarkMode: boolean;
  onClose: () => void;
}

// Theme tokens for the chart canvas (kept local; the terminal palette is CSS-driven).
function theme(isDarkMode: boolean) {
  return isDarkMode
    ? { bg: "#0a0a0a", text: "#d1d5db", grid: "#1f2937", up: "#22c55e", down: "#ef4444", panel: "#0a0a0a", border: "#7c2d12" }
    : { bg: "#ffffff", text: "#111827", grid: "#e5e7eb", up: "#16a34a", down: "#dc2626", panel: "#ffffff", border: "#fed7aa" };
}

export function CandleChartModal({ decision, isDarkMode, onClose }: CandleChartModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const t = theme(isDarkMode);

  const startDate = historyWindow(decision.handleLowDate)?.startDate ?? null;
  const { data, isLoading, error } = useTickerHistory(decision.ticker, startDate);

  // ESC to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Chart lifecycle — created ONLY here (on open, once data arrives) and disposed on
  // close/unmount. lightweight-charts is dynamic-imported INSIDE the effect so it's
  // never evaluated during SSR.
  useEffect(() => {
    const container = containerRef.current;
    const bars = data?.bars;
    if (!container || !bars || bars.length === 0) return;

    let chart: IChartApi | null = null;
    let disposed = false;
    let ro: ResizeObserver | null = null;

    (async () => {
      const LWC = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;

      chart = LWC.createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: 380,
        layout: { background: { type: LWC.ColorType.Solid, color: t.bg }, textColor: t.text, fontSize: 11 },
        grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
        rightPriceScale: { borderColor: t.grid },
        timeScale: { borderColor: t.grid, timeVisible: false },
        crosshair: { mode: LWC.CrosshairMode.Normal },
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: t.up,
        downColor: t.down,
        borderVisible: false,
        wickUpColor: t.up,
        wickDownColor: t.down,
      });
      const { candles, volume } = mapBarsToCandles(bars, t.up, t.down);
      candleSeries.setData(candles as CandlestickData[]);

      // Volume subpanel (overlaid on its own hidden scale, pinned to the bottom 20%).
      const volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "" });
      volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volSeries.setData(volume as HistogramData[]);

      // Setup-level overlays (entry/stop/target/breakout + NOW), null-safe.
      for (const l of buildPriceLines(decision)) {
        candleSeries.createPriceLine({
          price: l.price,
          color: l.color,
          title: l.title,
          lineWidth: 1,
          lineStyle: LWC.LineStyle.Dashed,
          axisLabelVisible: true,
        });
      }

      // Handle-low: no price, so a VERTICAL time marker at handle_low_date instead.
      const hld = (decision.handleLowDate ?? "").slice(0, 10);
      if (hld) {
        const markers: SeriesMarker<Time>[] = [
          { time: hld as Time, position: "belowBar", color: LEVEL_COLORS.breakout, shape: "arrowUp", text: "handle low" },
        ];
        candleSeries.setMarkers(markers);
      }

      chart.timeScale().fitContent();

      const live = chart;
      ro = new ResizeObserver(() => {
        if (containerRef.current) live.applyOptions({ width: containerRef.current.clientWidth });
      });
      ro.observe(containerRef.current);
    })();

    return () => {
      disposed = true;
      if (ro) ro.disconnect();
      if (chart) chart.remove();
    };
  }, [data, decision, t.bg, t.text, t.grid, t.up, t.down]);

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <dialog
      open
      className="fixed inset-0 z-50 w-full h-full p-0 m-0 max-w-none max-h-none border-none bg-transparent overflow-hidden"
      onClick={onClose}
      aria-labelledby="candle-modal-title"
    >
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" />
      <div className="relative w-full h-full flex items-center justify-center p-4">
        <div
          className="w-full max-w-3xl border-2 rounded-sm p-3 shadow-lg"
          style={{ backgroundColor: t.panel, borderColor: t.border, color: t.text }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-2">
            <h2 id="candle-modal-title" className="text-sm font-bold font-mono" style={{ color: t.text }}>
              {decision.ticker} · daily candles{" "}
              <span className="opacity-50 text-[10px] font-normal">
                (handle low {(decision.handleLowDate ?? "").slice(0, 10)} − 20d → today · raw)
              </span>
            </h2>
            <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>

          {isLoading && (
            <div className="h-[380px] flex items-center justify-center text-[11px] font-mono animate-pulse" style={{ color: t.text, opacity: 0.7 }}>
              Loading price history…
            </div>
          )}
          {!isLoading && (error || data?.error || (data && data.bars.length === 0)) && (
            <div className="h-[380px] flex items-center justify-center text-[11px] font-mono" style={{ color: t.down }}>
              Chart unavailable{data?.error ? ` — ${data.error}` : error ? ` — ${error.message}` : ""}.
            </div>
          )}
          {/* The chart mounts into this div; kept in the tree so the ref exists. */}
          <div ref={containerRef} className={isLoading || error || data?.error || (data && data.bars.length === 0) ? "hidden" : ""} />

          {/* Legend */}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-2 text-[10px] font-mono" style={{ color: t.text, opacity: 0.8 }}>
            <span style={{ color: LEVEL_COLORS.breakout }}>■ breakout / handle-low mark</span>
            <span style={{ color: LEVEL_COLORS.entry }}>■ entry</span>
            <span style={{ color: LEVEL_COLORS.stop }}>■ stop</span>
            <span style={{ color: LEVEL_COLORS.target }}>■ target</span>
            <span style={{ color: LEVEL_COLORS.now }}>■ NOW</span>
          </div>
        </div>
      </div>
    </dialog>
  );
}
