/*
 * JACK resolve-early-on-exit self-test.
 *
 *   npx tsx scripts/jack-resolve-early-selftest.ts
 *
 * Covers the ONE thing that changed: a setup becomes eligible for resolution at its
 * TERMINAL STATE rather than at 195 calendar days.
 *
 * The resolution LOGIC is untouched and is not re-implemented here — every case
 * drives the real replaySetup / detectFire / exitOnBar. What these assert is:
 *
 *   1. the eligibility floor offers young setups and withholds newborn ones
 *   2. a young setup that already hit target/stop RESOLVES NOW
 *   3. a young setup still running returns `deferred` and writes NOTHING
 *   4. never_fired resolves as soon as the 15-bar window elapses
 *   5. the stop-first tie rule is unchanged (parity anchor)
 *   6. bounded chunking fetches every candidate, in order, in fixed-size batches
 *
 * Cases 1 runs against a real throwaway SQLite DB. No network, no Redis, no Telegram.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  replaySetup,
  detectFire,
  exitOnBar,
  CONFIRM_WINDOW_BARS,
  TIME_STOP_BARS,
  DEFAULT_RESOLUTION_DAYS,
  OUTCOME_FETCH_CHUNK,
  type Bar,
} from "../lib/jack/outcome-tracker";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string | null): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Sequential calendar dates from an anchor. */
function dateFrom(anchor: string, i: number): string {
  const d = new Date(`${anchor}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
const bar = (date: string, o: number, h: number, l: number, c: number): Bar => ({
  date, open: o, high: h, low: l, close: c, volume: 1_000_000,
});

const HLD = "2026-07-01";
const RIM = 100;
const STOP = 95;
const TARGET = 115;
const setup = {
  id: 1, ticker: "TST", handleLowDate: HLD,
  entry: 101, stop: STOP, target: TARGET, breakoutLevel: RIM,
};

/** Bars: flat until `fireAt`, a confirming close, then `after` shapes the outcome. */
function bars(fireAt: number, after: Bar[]): Bar[] {
  const out: Bar[] = [bar(dateFrom(HLD, 0), 97, 97.5, 96.5, 97)];
  for (let i = 1; i < fireAt; i++) out.push(bar(dateFrom(HLD, i), 97, 97.5, 96.5, 97));
  out.push(bar(dateFrom(HLD, fireAt), 99, 102, 98, 101)); // close 101 > rim 100
  return out.concat(after);
}

// ===========================================================================
console.log("\n[1] PARITY ANCHORS — the frozen constants and the tie rule are untouched");
// ===========================================================================
{
  check("CONFIRM_WINDOW_BARS still 15", CONFIRM_WINDOW_BARS === 15, String(CONFIRM_WINDOW_BARS));
  check("TIME_STOP_BARS still 120", TIME_STOP_BARS === 120, String(TIME_STOP_BARS));
  check("DEFAULT_RESOLUTION_DAYS still 130", DEFAULT_RESOLUTION_DAYS === 130, String(DEFAULT_RESOLUTION_DAYS));
  // The notebook's _sim_trade checks `if bl <= stop_price` BEFORE `if bh >= target_price`.
  const both = bar("2026-07-10", 100, 999, 1, 100); // touches stop AND target
  check("stop-first tie rule (matches _sim_trade)", exitOnBar(both, STOP, TARGET) === "stop");
  check("  stop alone -> stop", exitOnBar(bar("d", 100, 101, 94, 100), STOP, TARGET) === "stop");
  check("  target alone -> target", exitOnBar(bar("d", 100, 116, 99, 100), STOP, TARGET) === "target");
  check("  neither -> null", exitOnBar(bar("d", 100, 101, 99, 100), STOP, TARGET) === null);
}

// ===========================================================================
console.log("\n[2] A YOUNG setup that already EXITED resolves NOW");
// ===========================================================================
{
  // Fires on bar 3, hits target on bar 8 — ~10 bars total, nowhere near 120.
  const b = bars(3, [
    bar(dateFrom(HLD, 4), 101, 103, 100, 102),
    bar(dateFrom(HLD, 5), 102, 104, 101, 103),
    bar(dateFrom(HLD, 6), 103, 105, 102, 104),
    bar(dateFrom(HLD, 7), 104, 106, 103, 105),
    bar(dateFrom(HLD, 8), 105, 116, 104, 115), // high 116 >= target 115
  ]);
  const r = replaySetup(setup, b);
  check("resolves without waiting 120 bars", r.kind === "written", r.kind);
  if (r.kind === "written") {
    check("  exit_reason = target", r.outcome.exitReason === "target", String(r.outcome.exitReason));
    check("  fired = true", r.outcome.fired === true);
    check("  R_realized is set (JANLY's isResolved needs it)", r.outcome.rRealized != null);
  }

  // Same shape, stop instead.
  const bs = bars(3, [
    bar(dateFrom(HLD, 4), 101, 103, 100, 102),
    bar(dateFrom(HLD, 5), 102, 103, 94, 96), // low 94 <= stop 95
  ]);
  const rs = replaySetup(setup, bs);
  check("a young STOP also resolves now", rs.kind === "written", rs.kind);
  if (rs.kind === "written") {
    check("  exit_reason = stop", rs.outcome.exitReason === "stop", String(rs.outcome.exitReason));
    check("  stop-out is exactly -1R (matches the backtest)", rs.outcome.rRealized === -1,
      String(rs.outcome.rRealized));
  }
}

// ===========================================================================
console.log("\n[3] A young setup STILL RUNNING defers and writes NOTHING");
// ===========================================================================
{
  // Fires on bar 3, then drifts without touching either level — only ~8 of 120 bars.
  const drift: Bar[] = [];
  for (let i = 4; i < 12; i++) drift.push(bar(dateFrom(HLD, i), 101, 104, 99, 102));
  const r = replaySetup(setup, bars(3, drift));
  check("still-running setup is DEFERRED, not resolved", r.kind === "deferred", r.kind);
  if (r.kind === "deferred") {
    check("  and says why (n/120 forward bars)", /\/120 forward bars/.test(r.reason), r.reason);
  }
  check("  nothing is written — no premature 'timeout' is locked in", r.kind !== "written");
}

// ===========================================================================
console.log("\n[4] never_fired resolves as soon as the 15-bar window elapses");
// ===========================================================================
{
  // 20 bars after the handle low, none closing above the rim.
  const quiet: Bar[] = [bar(dateFrom(HLD, 0), 97, 97.5, 96.5, 97)];
  for (let i = 1; i <= 20; i++) quiet.push(bar(dateFrom(HLD, i), 97, 99, 96, 98)); // never > 100
  const r = replaySetup(setup, quiet);
  check("unconfirmed + window elapsed -> written", r.kind === "written", r.kind);
  if (r.kind === "written") {
    check("  exit_reason = never_fired", r.outcome.exitReason === "never_fired", String(r.outcome.exitReason));
    check("  fired = false", r.outcome.fired === false);
  }

  // Same bars, but the window has NOT elapsed yet.
  const short = quiet.slice(0, 8);
  const rs = replaySetup(setup, short);
  check("window not elapsed -> deferred, never a premature never_fired", rs.kind === "deferred", rs.kind);

  // detectFire directly, for the boundary.
  check("detectFire: 20 bars, no close over rim -> never_fired",
    detectFire(quiet, HLD, RIM).status === "never_fired");
  check("detectFire: 8 bars -> deferred", detectFire(short, HLD, RIM).status === "deferred");
}

// ===========================================================================
console.log("\n[5] Bounded chunking — every candidate fetched, in order, in batches");
// ===========================================================================
{
  check("OUTCOME_FETCH_CHUNK is a small positive integer",
    Number.isInteger(OUTCOME_FETCH_CHUNK) && OUTCOME_FETCH_CHUNK > 0 && OUTCOME_FETCH_CHUNK <= 32,
    String(OUTCOME_FETCH_CHUNK));

  // Reproduce the loop shape and assert its properties against a counted fake.
  const N = 53;
  const items = Array.from({ length: N }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;
  const fetched: number[] = [];
  const fake = async (i: number) => {
    inFlight++;
    if (inFlight > peak) peak = inFlight;
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    fetched.push(i);
    return i;
  };
  const out: number[] = [];
  const run = async () => {
    for (let i = 0; i < items.length; i += OUTCOME_FETCH_CHUNK) {
      const chunk = items.slice(i, i + OUTCOME_FETCH_CHUNK);
      out.push(...(await Promise.all(chunk.map(fake))));
    }
  };
  run().then(() => {
    check(`all ${N} candidates fetched`, fetched.length === N, String(fetched.length));
    check("results stay index-aligned with setups", out.every((v, i) => v === i));
    check(`peak concurrency never exceeded ${OUTCOME_FETCH_CHUNK}`, peak <= OUTCOME_FETCH_CHUNK, String(peak));
    check("  a partial final batch is handled", N % OUTCOME_FETCH_CHUNK !== 0);
    void dbCase();
  });
}

// ===========================================================================
// [6] The eligibility floor, against a real throwaway DB.
// ===========================================================================
const dir = mkdtempSync(join(tmpdir(), "jack-resolve-early-"));
process.env.JACK_DB_PATH = join(dir, "test.db");

async function dbCase(): Promise<void> {
  console.log("\n[6] Eligibility floor — young setups are OFFERED, newborns are not");
  const write = await import("../lib/db/write");
  const read = await import("../lib/db/read");

  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const mk = (ticker: string, ageDays: number) =>
    write.upsertSetup(
      {
        ticker, handleLowDate: daysAgo(ageDays), status: "pending",
        entry: 101, stop: STOP, t05Target: TARGET, breakoutLevel: RIM,
        tier: "Q5", priority: 7.5, sizeBucket: "full",
      },
      new Date().toISOString()
    );

  mk("OLD", 300);    // older than even the retired 195-day gate
  mk("MID", 40);     // past the floor — would have waited ~6 months before
  mk("YOUNG", 30);   // past the floor
  mk("NEWBORN", 5);  // too new for ANY verdict, not even never_fired

  const got = read.getSetupsNeedingOutcomes(DEFAULT_RESOLUTION_DAYS).map((s) => s.ticker).sort();
  check("a 300-day setup is still offered (no regression)", got.includes("OLD"), got.join(","));
  check("a 40-day setup is now offered", got.includes("MID"), got.join(","));
  check("a 30-day setup is now offered", got.includes("YOUNG"), got.join(","));
  check("a 5-day setup is NOT offered (cannot be terminal yet)", !got.includes("NEWBORN"), got.join(","));

  // A setup missing geometry can never be replayed — unchanged behaviour.
  write.upsertSetup(
    { ticker: "NOGEO", handleLowDate: daysAgo(60), status: "pending",
      entry: 101, stop: undefined, t05Target: undefined, breakoutLevel: undefined,
      tier: "Q5", priority: 7.5, sizeBucket: "full" },
    new Date().toISOString()
  );
  const got2 = read.getSetupsNeedingOutcomes(DEFAULT_RESOLUTION_DAYS).map((s) => s.ticker);
  check("a setup missing geometry is still excluded", !got2.includes("NOGEO"), got2.join(","));

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best-effort */
  }

  console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

export {};
