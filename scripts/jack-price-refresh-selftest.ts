/**
 * JACK price-refresh selftest — PURE functions only (no Tiingo, no Redis, no DB).
 * Run: npx tsx scripts/jack-price-refresh-selftest.ts
 *
 * Covers: market-hours (DST, trading day, session window), the IEX price picker
 * fallback chain, mapIexBatch, and the open-positions route's Redis-store freshness
 * rule (store trusted only when asOf's ET-day === today ET). The I/O paths
 * (runPriceRefresh / the endpoint / the scheduler) are exercised live by
 * scripts/jack-iex-reachability.ts on the VPS + the endpoint itself.
 */
import { etParts, etDateISO, isTradingDay, isMarketOpen, NYSE_HOLIDAYS } from "@/lib/jack/market-hours";
import { pickIexPrice, mapIexBatch } from "@/lib/jack/price-refresh";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── market hours: DST-safe wall-clock ───────────────────────────────────────
// 2026-07-15 14:00 UTC → EDT (UTC-4) → 10:00 ET. Summer, so DST is in effect.
{
  const summer = new Date("2026-07-15T14:00:00Z");
  const p = etParts(summer);
  check("etParts summer EDT hour", p.hour === 10, `got ${p.hour}:${p.minute}`);
  check("etParts summer date", p.dateISO === "2026-07-15", p.dateISO);
  check("etDateISO summer", etDateISO(summer) === "2026-07-15");
}
// 2026-01-15 14:00 UTC → EST (UTC-5) → 09:00 ET. Winter, no DST. Same UTC input,
// different ET hour → proves the offset is not hard-coded.
{
  const winter = new Date("2026-01-15T14:00:00Z");
  const p = etParts(winter);
  check("etParts winter EST hour", p.hour === 9, `got ${p.hour}:${p.minute}`);
}

// ── trading day / holiday / weekend ─────────────────────────────────────────
{
  // 2026-07-15 is a Wednesday, not a holiday.
  check("isTradingDay weekday", isTradingDay(new Date("2026-07-15T14:00:00Z")));
  // 2026-07-18 is a Saturday (ET).
  check("isTradingDay weekend=false", !isTradingDay(new Date("2026-07-18T15:00:00Z")));
  // 2026-07-03 is the Independence Day (observed) holiday.
  check("NYSE_HOLIDAYS has Jul 3", NYSE_HOLIDAYS.has("2026-07-03"));
  check("isTradingDay holiday=false", !isTradingDay(new Date("2026-07-03T15:00:00Z")));
}

// ── session window: 09:30 ≤ ET < 16:00 on a trading day ─────────────────────
{
  // 13:35 UTC = 09:35 EDT → open.
  check("isMarketOpen 09:35 EDT", isMarketOpen(new Date("2026-07-15T13:35:00Z")));
  // 13:25 UTC = 09:25 EDT → closed (pre-open).
  check("isMarketOpen 09:25 EDT=false", !isMarketOpen(new Date("2026-07-15T13:25:00Z")));
  // 20:00 UTC = 16:00 EDT → closed (boundary is exclusive).
  check("isMarketOpen 16:00 EDT=false", !isMarketOpen(new Date("2026-07-15T20:00:00Z")));
  // 14:00 UTC = 10:00 EDT (the intraday slot) → open.
  check("isMarketOpen 10:00 EDT", isMarketOpen(new Date("2026-07-15T14:00:00Z")));
  // 22:00 UTC = 18:00 EDT (the eod slot) → closed.
  check("isMarketOpen 18:00 EDT=false", !isMarketOpen(new Date("2026-07-15T22:00:00Z")));
  // Saturday during session hours → still closed.
  check("isMarketOpen Sat=false", !isMarketOpen(new Date("2026-07-18T14:00:00Z")));
}

// ── pickIexPrice fallback chain: tngoLast → last → prevClose ─────────────────
{
  check("pick tngoLast first", pickIexPrice({ tngoLast: 101, last: 100, prevClose: 99 }) === 101);
  check("pick last when tngoLast null", pickIexPrice({ tngoLast: null, last: 100, prevClose: 99 }) === 100);
  check("pick prevClose when both null", pickIexPrice({ tngoLast: null, last: null, prevClose: 99 }) === 99);
  check("pick null when all null", pickIexPrice({ tngoLast: null, last: null, prevClose: null }) === null);
  check("pick skips NaN", pickIexPrice({ tngoLast: Number.NaN, last: 100 }) === 100);
  check("pick skips undefined", pickIexPrice({ last: 42 }) === 42);
  check("pick zero is skipped-if-not-finite? no, 0 is finite", pickIexPrice({ tngoLast: 0, last: 5 }) === 0);
}

// ── mapIexBatch: array → { TICKER: price }, uppercased, only usable ──────────
{
  const m = mapIexBatch([
    { ticker: "aapl", tngoLast: 150.2, last: 150, prevClose: 149 },
    { ticker: "msft", tngoLast: null, last: null, prevClose: 400 },
    { ticker: "nope", tngoLast: null, last: null, prevClose: null }, // no price → dropped
    { tngoLast: 5 } as { tngoLast: number }, // no ticker → dropped
  ]);
  check("mapIexBatch AAPL uppercased", m.AAPL === 150.2);
  check("mapIexBatch MSFT prevClose fallback", m.MSFT === 400);
  check("mapIexBatch drops priceless", !("NOPE" in m));
  check("mapIexBatch drops tickerless", Object.keys(m).length === 2, JSON.stringify(m));
}

// ── open-positions store freshness: trust only when store ET-day === today ──
// (mirrors the route's `storeFresh` rule without importing the route/DB.)
{
  const storeFresh = (asOf: string, now: Date) => etDateISO(new Date(asOf)) === etDateISO(now);
  const now = new Date("2026-07-15T18:00:00Z"); // 14:00 ET, same ET day as a 10:00 ET write
  check("store fresh same ET day", storeFresh("2026-07-15T14:00:00Z", now));
  check("store stale prior ET day", !storeFresh("2026-07-14T20:00:00Z", now));
  // Cross-midnight-UTC guard: 2026-07-16T02:00Z is still 2026-07-15 22:00 ET.
  check("store fresh across UTC midnight", storeFresh("2026-07-16T02:00:00Z", now));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
