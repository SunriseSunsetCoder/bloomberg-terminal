/*
 * Candle-chart PURE helper self-test — the transforms the modal depends on
 * (no canvas / no lightweight-charts). The chart instance itself is verified by
 * typecheck + build.
 *
 * Run:  npx tsx scripts/jack-candle-chart-selftest.ts
 */
import {
  historyWindow,
  mapBarsToCandles,
  closesFromBars,
  buildPriceLines,
  LEVEL_COLORS,
  type OhlcBar,
} from "../lib/candle-chart";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- 1. historyWindow: handle_low_date − 20 calendar days ----
console.log("\n[1] historyWindow (handle_low − 20d)");
check("2026-05-08 → startDate 2026-04-18", historyWindow("2026-05-08")?.startDate === "2026-04-18", String(historyWindow("2026-05-08")?.startDate));
check("month/year rollover 2026-01-10 → 2025-12-21", historyWindow("2026-01-10")?.startDate === "2025-12-21", String(historyWindow("2026-01-10")?.startDate));
check("datetime form 2026-05-08T00:00:00 accepted", historyWindow("2026-05-08T00:00:00.000Z")?.startDate === "2026-04-18");
check("null → null", historyWindow(null) === null);
check("garbage → null", historyWindow("not-a-date") === null);

// ---- 2. mapBarsToCandles: field map, ascending sort, volume up/down tint ----
console.log("\n[2] mapBarsToCandles");
{
  // Deliberately out-of-order to prove the defensive sort.
  const bars: OhlcBar[] = [
    { date: "2026-05-02", open: 10, high: 12, low: 9, close: 11, volume: 100 }, // up (close>open)
    { date: "2026-05-01", open: 10, high: 11, low: 8, close: 9, volume: 200 }, // down (close<open)
    { date: "2026-05-03", open: 11, high: 11, low: 10, close: 11, volume: 150 }, // up (close===open → up)
  ];
  const { candles, volume } = mapBarsToCandles(bars, "#UP", "#DOWN");
  check("candles sorted ascending by time", candles.map((c) => c.time).join(",") === "2026-05-01,2026-05-02,2026-05-03", candles.map((c) => c.time).join(","));
  check("candle OHLC mapped (2026-05-02 open=10 high=12 low=9 close=11)", candles[1].open === 10 && candles[1].high === 12 && candles[1].low === 9 && candles[1].close === 11);
  check("volume aligned + values", volume.map((v) => v.value).join(",") === "200,100,150", volume.map((v) => v.value).join(","));
  check("down bar (2026-05-01 close<open) → downColor", volume[0].color === "#DOWN", volume[0].color);
  check("up bar (2026-05-02 close>open) → upColor", volume[1].color === "#UP", volume[1].color);
  check("flat bar (close===open) → upColor (>=)", volume[2].color === "#UP", volume[2].color);
}

// ---- 3. closesFromBars: ascending closes for the thumbnail ----
console.log("\n[3] closesFromBars");
{
  const bars: OhlcBar[] = [
    { date: "2026-05-03", open: 0, high: 0, low: 0, close: 11, volume: 0 },
    { date: "2026-05-01", open: 0, high: 0, low: 0, close: 9, volume: 0 },
    { date: "2026-05-02", open: 0, high: 0, low: 0, close: 10, volume: 0 },
  ];
  check("closes ascending by date → [9,10,11]", closesFromBars(bars).join(",") === "9,10,11", closesFromBars(bars).join(","));
}

// ---- 4. buildPriceLines: level → line, nulls dropped, correct colors ----
console.log("\n[4] buildPriceLines");
{
  const full = buildPriceLines({ entry: 40, stop: 38, target: 48, breakout: 40.1, currentPrice: 41 });
  const byTitle = Object.fromEntries(full.map((l) => [l.title, l]));
  check("5 lines when all present", full.length === 5, String(full.length));
  check("breakout line price+color", byTitle.breakout.price === 40.1 && byTitle.breakout.color === LEVEL_COLORS.breakout);
  check("entry line price+color", byTitle.entry.price === 40 && byTitle.entry.color === LEVEL_COLORS.entry);
  check("stop line price+color", byTitle.stop.price === 38 && byTitle.stop.color === LEVEL_COLORS.stop);
  check("target line price+color", byTitle.target.price === 48 && byTitle.target.color === LEVEL_COLORS.target);
  check("NOW line price+color", byTitle.NOW.price === 41 && byTitle.NOW.color === LEVEL_COLORS.now);

  const partial = buildPriceLines({ entry: 40, stop: null, target: null, breakout: null, currentPrice: null });
  check("nulls dropped → only entry", partial.length === 1 && partial[0].title === "entry", String(partial.length));
  check("no handle-low line (no price, drawn as time marker instead)", full.every((l) => l.title !== "handle low"));
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
