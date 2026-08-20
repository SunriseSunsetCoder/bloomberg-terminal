/*
 * JACK pending → LIVE promoter self-test — THE ACCEPTANCE TEST, end to end.
 *
 * Real throwaway SQLite DB, real ingest + promoter + board reads, real Basket Sizer
 * math. Bars are injected (no network); Telegram/Redis run on the in-memory transport.
 *
 * The five acceptance steps, in order:
 *   1. The promoter stamps TTE's CURRENT-run decision row (fired_at / fired_status).
 *   2. The JACK tab's feed shows TTE in the LIVE display group with its FIRED flag
 *      (getFiredFlagsForSetups — cross-run — plus applyFiredDisplaySection).
 *   3. The Basket Sizer renders TTE with a NON-ZERO share quantity.
 *   4. RE-PASTE the weekly CSV, then re-check BOTH surfaces — both must still show it.
 *      This is the regression test for the original "shows LIVE, Basket won't size it"
 *      bug: a re-validate inserts a fresh decision row with fired_at NULL, and before
 *      the cross-run read in getCurrentBoard the tab passed while the Sizer silently
 *      dropped the row. NON-SKIPPABLE.
 *   5. Rimless control — a ~36-cohort setup stays PENDING on both surfaces.
 *
 * Run:  npx tsx scripts/jack-promoter-selftest.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string | null): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "jack-promoter-"));
process.env.JACK_DB_PATH = join(dir, "test.db");

// TTE, exactly as reported: rim 89.30, entry 89.39, handle low 2026-08-05, Q3/full.
const HLD = "2026-08-05";
const ET = "2026-08-19";
const TTE = { rim: 89.3, entry: 89.39, stop: 84.5, target: 97.0 };

/** Daily bars from the handle low; the last close is `finalClose`. */
function bars(closes: number[], firstDate = "2026-08-06") {
  const out = [{ date: HLD, open: 88, high: 88.5, low: 87.5, close: 88, volume: 1e6 }];
  const d = new Date(`${firstDate}T00:00:00Z`);
  for (const c of closes) {
    out.push({ date: d.toISOString().slice(0, 10), open: c - 0.2, high: c + 0.3, low: c - 0.5, close: c, volume: 1e6 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
// 14 in-window bars; the last is TTE's real 90.07 close, decisively above the rim.
const TTE_BARS = bars([88.4, 88.6, 88.9, 89.0, 89.1, 88.8, 89.2, 89.0, 89.25, 89.28, 89.29, 89.1, 89.2, 90.07]);
// A rimless control that closes far above its ENTRY — the old close-≥-entry rule
// would have promoted this; the rim rule must not.
const NORIM_BARS = bars([88.4, 90.0, 95.0]);

async function main(): Promise<void> {
  const write = await import("../lib/db/write");
  const read = await import("../lib/db/read");
  const alerts = await import("../lib/jack/alerts");
  const { getDb } = await import("../lib/db/init");
  const { selectBasketCandidates, computeBasket, defaultBasketOptions } = await import("../lib/jack/basket");
  const { isInLiveDisplayGroup, isFiredActionable } = await import("../lib/jack/combine-decisions");
  const db = getDb();

  // In-memory transport so the promoter's alert side is observable and offline.
  const sent: string[] = [];
  const store = new Map<string, string>();
  alerts.setAlertTransport({
    enabled: () => true,
    get: async (k) => store.get(k) ?? null,
    set: async (k) => void store.set(k, "1"),
    del: async (k) => void store.delete(k),
    send: async (text) => {
      sent.push(text);
      return { ok: true };
    },
  });

  const meta = (t: string, n: number) => ({
    timestamp: t, inputRowCount: n, totalFinalCount: n, liveFinalCount: 0, pendingFinalCount: n,
    liveDroppedStale: 0, pendingDroppedStale: 0, liveDroppedOverCap: 0, pendingDroppedOverCap: 0,
    tiingoAttempted: 0, tiingoSucceeded: 0, riskPerTrade: 2000, parseSuccess: true,
  });

  /** One weekly paste: upsert the setups, insert a run, insert PENDING decisions. */
  function ingest(ts: string, rows: Array<{ t: string; rim: number | null; tier: string; bucket: string }>) {
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(
        `${r.t}|${HLD}`,
        write.upsertSetup(
          {
            ticker: r.t, handleLowDate: HLD, status: "pending",
            entry: TTE.entry, stop: TTE.stop, t05Target: TTE.target,
            breakoutLevel: r.rim ?? undefined, tier: r.tier, priority: 7.5, sizeBucket: r.bucket,
          },
          ts
        )
      );
    }
    const runId = write.insertValidationRun(meta(ts, rows.length));
    const { ids } = write.insertDecisions(
      rows.map((r) => ({ ticker: r.t, handleLowDate: HLD, section: "pending" as const, decision: "WATCH" })),
      runId,
      map
    );
    return { runId, ids, map };
  }

  const barsFor = async (ticker: string) => ({ bars: ticker === "NORIM" ? NORIM_BARS : TTE_BARS });

  /** Run the promoter over the CURRENT board's pending set, as the EOD pass does. */
  async function runPromoter() {
    const pending = read.getPendingSetups();
    const scope = new Set(pending.map((p) => p.ticker.toUpperCase()));
    return alerts.promotePendingToLive(
      pending.map((p) => ({
        setupId: p.setupId, decisionId: p.decisionId, ticker: p.ticker, handleLowDate: p.handleLowDate,
        breakout: p.breakout, stop: p.stop, target: p.target, sizeBucket: p.sizeBucket, tier: p.tier,
      })),
      scope,
      ET,
      (t) => barsFor(t),
      write,
      alerts.newEmitStats()
    );
  }

  /** The Basket Sizer's real feed + sizing, as app/api/jack-basket/route.ts runs it. */
  function sizer() {
    const board = read.getCurrentBoard();
    const all = [...board.live, ...board.pending];
    const candidates = selectBasketCandidates(all).map((p) => ({
      setupId: p.setupId, ticker: p.ticker, handleLowDate: p.handleLowDate,
      entry: p.entry, stop: p.stop, target: p.target, tier: p.tier, sector: p.sector,
      priority: p.priority, sizeBucket: p.sizeBucket, handleScore: p.handleScore,
    }));
    const totals = computeBasket(candidates, [], defaultBasketOptions());
    return { candidates, totals };
  }

  const boardRowFor = (ticker: string) => {
    const b = read.getCurrentBoard();
    return [...b.live, ...b.pending].find((r) => r.ticker === ticker);
  };

  // ========================================================================
  console.log("\n1. PROMOTER STAMPS TTE's CURRENT-RUN ROW");
  // ========================================================================
  const run1 = ingest("2026-08-19T12:00:00Z", [
    { t: "TTE", rim: TTE.rim, tier: "Q3", bucket: "full" },
    { t: "NORIM", rim: null, tier: "Q3", bucket: "full" }, // the ~36 cohort
  ]);
  const tteSetupId = run1.map.get(`TTE|${HLD}`)!;

  check("before: TTE is pending with no fire", boardRowFor("TTE")?.firedStatus == null);
  check("before: the Basket Sizer does NOT carry it", !sizer().candidates.some((c) => c.ticker === "TTE"));

  const r1 = await runPromoter();
  check("1. TTE promoted", r1.promoted === 1, JSON.stringify(r1));
  check("1. the rimless control was NOT promoted", r1.rimless === 1);
  const stamped = db
    .prepare(`SELECT fired_at, fire_close, fire_bar, fired_status FROM decisions WHERE id = ?`)
    .get(run1.ids.find((i) => i.ticker === "TTE")!.decisionId) as { fired_at: string; fire_close: number; fire_bar: number; fired_status: string };
  check("1. the CURRENT-run decision row carries fired_at", stamped.fired_at === ET);
  check("1. …with the confirming close 90.07", Math.abs(stamped.fire_close - 90.07) < 1e-9, String(stamped.fire_close));
  check("1. …inside the 15-bar window", stamped.fire_bar === 14, String(stamped.fire_bar));
  check("1. …status confirmed (fired today)", stamped.fired_status === "confirmed", stamped.fired_status);
  check("1. an alert went out naming the rim", sent.length === 1 && sent[0].includes("> rim 89.30"));

  // ========================================================================
  console.log("\n2. JACK TAB — TTE is in the LIVE display group");
  // ========================================================================
  {
    const flags = read.getFiredFlagsForSetups([tteSetupId]).get(tteSetupId);
    check("2. the tab's FIRED-flag poll reports the fire", flags?.firedStatus === "confirmed");
    const row = boardRowFor("TTE")!;
    check("2. the board row carries the fired status", row.firedStatus === "confirmed");
    check("2. isFiredActionable ⇒ actionable", isFiredActionable(row));
    check("2. isInLiveDisplayGroup ⇒ renders under LIVE", isInLiveDisplayGroup({ ...row, section: "pending" }));
    check("2. decisions.section is still 'pending' in the DB (display-only re-section)", row.section === "pending");
  }

  // ========================================================================
  console.log("\n3. BASKET SIZER — TTE renders with a share quantity");
  // ========================================================================
  {
    const { candidates, totals } = sizer();
    check("3. TTE is a Sizer candidate", candidates.some((c) => c.ticker === "TTE"));
    const row = totals.rows.find((r) => r.ticker === "TTE");
    check("3. …and gets a row", !!row);
    check("3. …with a NON-ZERO share quantity", !!row && row.shares > 0, String(row?.shares));
    check("3. …and a position value", !!row && row.positionDollars > 0);
    check("3. the rimless control is absent", !candidates.some((c) => c.ticker === "NORIM"));
  }

  // ========================================================================
  console.log("\n4. RE-PASTE THE WEEKLY CSV — both surfaces must survive it");
  // ========================================================================
  const run2 = ingest("2026-08-20T12:00:00Z", [
    { t: "TTE", rim: TTE.rim, tier: "Q3", bucket: "full" },
    { t: "NORIM", rim: null, tier: "Q3", bucket: "full" },
  ]);
  {
    const freshRow = db
      .prepare(`SELECT fired_at FROM decisions WHERE id = ?`)
      .get(run2.ids.find((i) => i.ticker === "TTE")!.decisionId) as { fired_at: string | null };
    check("4. the re-paste inserted a FRESH row with fired_at NULL (the old failure mode)", freshRow.fired_at === null);

    // THE REGRESSION ASSERTION. Pre-fix, getCurrentBoard read this run's own row →
    // NULL → the Sizer dropped TTE while the tab kept showing it LIVE.
    const row = boardRowFor("TTE")!;
    check("4. the board STILL reports the fire (cross-run read)", row.firedStatus === "confirmed", String(row.firedStatus));
    check("4. TAB: still in the LIVE display group", isInLiveDisplayGroup({ ...row, section: "pending" }));
    const { candidates, totals } = sizer();
    check("4. SIZER: still a candidate", candidates.some((c) => c.ticker === "TTE"));
    const brow = totals.rows.find((r) => r.ticker === "TTE");
    check("4. SIZER: still sized, non-zero", !!brow && brow.shares > 0, String(brow?.shares));
    check("4. NO DIVERGENCE — tab and Sizer agree after a re-paste", isInLiveDisplayGroup({ ...row, section: "pending" }) === candidates.some((c) => c.ticker === "TTE"));

    // …and re-running the promoter re-derives onto the NEW row (rule 3).
    const r2 = await runPromoter();
    check("4. the promoter re-derives on the new run", r2.promoted === 1);
    const reStamped = db
      .prepare(`SELECT fired_at FROM decisions WHERE id = ?`)
      .get(run2.ids.find((i) => i.ticker === "TTE")!.decisionId) as { fired_at: string | null };
    check("4. …stamping the CURRENT run's row too", reStamped.fired_at === ET);
    check("4. …without re-alerting (once per setup)", sent.length === 1);
  }

  // ========================================================================
  console.log("\n5. RIMLESS CONTROL — pending on both surfaces, in neither feed");
  // ========================================================================
  {
    const row = boardRowFor("NORIM")!;
    check("5. never stamped", row.firedStatus == null && row.firedAt == null);
    check("5. TAB: not in the LIVE display group", !isInLiveDisplayGroup({ ...row, section: "pending" }));
    check("5. SIZER: absent", !sizer().candidates.some((c) => c.ticker === "NORIM"));
    check("5. …despite closing 95.00, far above its entry 89.39", NORIM_BARS[NORIM_BARS.length - 1].close === 95);
  }

  // ========================================================================
  console.log("\n6. CURRENT-GEOMETRY RE-DERIVATION — a stale fire is un-promoted");
  // ========================================================================
  {
    // TTE's rim is corrected to 91.00, which its bars never clear.
    //
    // NOTE the path: upsertSetup writes `breakout_level = COALESCE(breakout_level, ?)`,
    // so a weekly re-paste can only BACKFILL a null rim — it can never revise an
    // existing one. The only ways a live rim changes are a direct-DB correction or the
    // archive rim-backfill script, so that is what this simulates.
    db.prepare(`UPDATE setups SET breakout_level = 91.0 WHERE id = ?`).run(tteSetupId);
    const r3 = await runPromoter();
    check("6. the stale fire is un-promoted", r3.promoted === 0 && r3.unpromoted === 1, JSON.stringify(r3));
    const row = boardRowFor("TTE")!;
    check("6. the board no longer reports a fire", row.firedStatus == null);
    check("6. TAB: out of the LIVE display group", !isInLiveDisplayGroup({ ...row, section: "pending" }));
    check("6. SIZER: dropped", !sizer().candidates.some((c) => c.ticker === "TTE"));
    check("6. no stamp survives on ANY run's row", (db.prepare(`SELECT COUNT(*) AS c FROM decisions WHERE setup_id = ? AND fired_at IS NOT NULL`).get(tteSetupId) as { c: number }).c === 0);
  }

  alerts.setAlertTransport(null);
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.stack : String(err), "\n");
    process.exit(1);
  });
