// =============================================================================
// Candle-chart PURE helpers (no canvas, no React, no lightweight-charts import).
// The modal owns the chart instance; everything here is a deterministic transform
// of the Tiingo bars + the setup levels, so it is unit-testable in isolation
// (see scripts/jack-candle-chart-selftest.ts).
// =============================================================================

// Tiingo EOD bar shape (from /api/tiingo/eod/[ticker]).
export interface OhlcBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// lightweight-charts v4 series data shapes.
export interface Candle {
  time: string; // business-day string 'YYYY-MM-DD'
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface VolumePoint {
  time: string;
  value: number;
  color: string; // per-bar up/down tint
}
export interface PriceLineSpec {
  price: number;
  color: string;
  title: string;
}

// Overlay colors — mirror the expand's price-ladder dots for consistency.
export const LEVEL_COLORS = {
  breakout: "#a78bfa", // violet
  entry: "#fb923c", // orange
  stop: "#ef4444", // red
  target: "#22c55e", // green
  now: "#38bdf8", // sky
} as const;

/**
 * Chart window: from handle_low_date − 20 CALENDAR days (so the cup rim / handle
 * are in frame) to today (the route defaults endDate to today). Pure function of
 * the date string. Returns null if the date is unparseable.
 */
export function historyWindow(handleLowDate: string | null | undefined): { startDate: string } | null {
  if (!handleLowDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(handleLowDate);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 20);
  return { startDate: d.toISOString().slice(0, 10) };
}

/**
 * Map Tiingo bars → lightweight-charts candlestick + volume series. Sorts ascending
 * defensively (the series require ascending time). Volume is tinted up/down by the
 * bar's own close-vs-open.
 */
export function mapBarsToCandles(
  bars: OhlcBar[],
  upColor: string,
  downColor: string
): { candles: Candle[]; volume: VolumePoint[] } {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const candles: Candle[] = sorted.map((b) => ({
    time: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
  const volume: VolumePoint[] = sorted.map((b) => ({
    time: b.date,
    value: b.volume,
    color: b.close >= b.open ? upColor : downColor,
  }));
  return { candles, volume };
}

/** Closes ascending — the cheap thumbnail sparkline series. */
export function closesFromBars(bars: OhlcBar[]): number[] {
  return [...bars].sort((a, b) => a.date.localeCompare(b.date)).map((b) => b.close);
}

/**
 * Horizontal overlay lines for the setup levels. Each is included only when its
 * price is present. Handle-low is NOT here — we have no handle-low PRICE, only the
 * date; the modal draws that as a vertical time marker instead.
 */
export function buildPriceLines(d: {
  entry: number | null;
  stop: number | null;
  target: number | null;
  breakout: number | null;
  currentPrice: number | null;
}): PriceLineSpec[] {
  const lines: PriceLineSpec[] = [];
  if (d.breakout != null) lines.push({ price: d.breakout, color: LEVEL_COLORS.breakout, title: "breakout" });
  if (d.entry != null) lines.push({ price: d.entry, color: LEVEL_COLORS.entry, title: "entry" });
  if (d.stop != null) lines.push({ price: d.stop, color: LEVEL_COLORS.stop, title: "stop" });
  if (d.target != null) lines.push({ price: d.target, color: LEVEL_COLORS.target, title: "target" });
  if (d.currentPrice != null) lines.push({ price: d.currentPrice, color: LEVEL_COLORS.now, title: "NOW" });
  return lines;
}
