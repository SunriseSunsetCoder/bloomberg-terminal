/*
 * JACK fill-guard + owned-position fill-EDIT self-test.
 *
 * Covers the two halves of the UMBF fix:
 *
 *   1. DECIMAL GUARD (lib/jack/fill-guard.ts) — a 10×-off fill is REJECTED, a normal
 *      fill PASSES. This is the check that would have caught 15.00 on a ~150 setup.
 *
 *   2. OWNED-POSITION EDIT PATH — an already-TRADED position's entry fill must be
 *      correctable:
 *        a) mergeSeeded keeps an in-progress edit across a server re-seed. The
 *           open-position query refetches every 180s and on window focus; both
 *           re-seed effects used to replace row state wholesale, so the field snapped
 *           back to the stored (bad) value mid-correction. THE regression test.
 *        b) the open row actually RENDERS an editable entry-price input (the fill
 *           panel is not exit-only).
 *        c) the DB round trip: correcting the entry through updateUserFills leaves
 *           the position OPEN, moves only user_entry_price, and recomputes user_R.
 *
 * Real throwaway SQLite DB + a real React render. No network, no Redis, no LLM.
 *
 * Run:  npx tsx scripts/jack-fill-guard-selftest.tsx
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkFillPrice,
  checkFills,
  geometryReference,
  FILL_GUARD_GEOMETRY_TOL,
} from "../lib/jack/fill-guard";
import { JackDecisionsTable, mergeSeeded, seedRows } from "../components/bloomberg/views/jack-decisions-table";
import type { JackDecisionClient } from "../components/bloomberg/hooks/useJackValidation";

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

const HLD = "2026-07-06";
// The real shape of the setup that was mis-filled: a ~150 name.
const UMBF = { entry: 152.5, stop: 143.0, target: 175.0, breakout: 151.8, currentPrice: 156.2 };

async function main(): Promise<void> {
  // ============================================================
  console.log("\n1. DECIMAL GUARD — the 15.00-vs-150 case");
  // ============================================================
  {
    const bad = checkFillPrice("entry", 15.0, UMBF);
    check("a 10×-off entry fill (15.00 on a ~152 setup) is REJECTED", !bad.ok, bad.reason);
    check("the rejection names the decimal slip", (bad.reason ?? "").toLowerCase().includes("decimal"), bad.reason);
    check("it reports the 1/10 factor", bad.decimalFactor === 0.1, String(bad.decimalFactor));
    check("it measures against the setup entry", bad.refPrice === UMBF.entry, String(bad.refPrice));

    const good = checkFillPrice("entry", 153.0, UMBF);
    check("the CORRECTED fill (153.00) passes", good.ok, good.reason);
    check("a fill right at the rim passes", checkFillPrice("entry", 151.8, UMBF).ok);
    check("a normal slip above entry (156.40) passes", checkFillPrice("entry", 156.4, UMBF).ok);
    check("a fill at the stop passes (a real stop-out fill)", checkFillPrice("exit", 143.0, UMBF).ok);
    check("a fill at the target passes", checkFillPrice("exit", 175.0, UMBF).ok);

    check("a 100×-off fill is REJECTED", !checkFillPrice("entry", 15250, UMBF).ok);
    check("a 10×-HIGH fill (1525) is REJECTED", !checkFillPrice("entry", 1525, UMBF).ok);
    check("an exit fill 10× off is REJECTED", !checkFillPrice("exit", 15.0, UMBF).ok);
    check("zero / negative is REJECTED", !checkFillPrice("entry", 0, UMBF).ok && !checkFillPrice("entry", -5, UMBF).ok);
  }

  // ============================================================
  console.log("\n2. GUARD BOUNDARIES + degradation");
  // ============================================================
  {
    const ref = UMBF.entry;
    const justInside = ref * (1 + FILL_GUARD_GEOMETRY_TOL - 0.01);
    const justOutside = ref * (1 + FILL_GUARD_GEOMETRY_TOL + 0.01);
    check(`${(FILL_GUARD_GEOMETRY_TOL * 100 - 1).toFixed(0)}% away passes`, checkFillPrice("entry", justInside, { ...UMBF, currentPrice: null }).ok);
    check(`${(FILL_GUARD_GEOMETRY_TOL * 100 + 1).toFixed(0)}% away is rejected`, !checkFillPrice("entry", justOutside, { ...UMBF, currentPrice: null }).ok);

    // No geometry (older CSV rows) → fall back to the last close alone.
    const noGeom = { entry: null, breakout: null, stop: null, target: null, currentPrice: 150 };
    check("no geometry + sane vs last close → passes", checkFillPrice("entry", 148, noGeom).ok);
    check("no geometry + 10× off last close → rejected", !checkFillPrice("entry", 15, noGeom).ok);
    check("nothing to compare against → passes (never blocks blind)", checkFillPrice("entry", 15, {}).ok);
    check("a null fill passes (blank field is not an error)", checkFillPrice("entry", null, UMBF).ok);

    check("reference prefers entry", geometryReference(UMBF) === UMBF.entry);
    check("reference falls back to the rim", geometryReference({ entry: null, breakout: 151.8 }) === 151.8);
    check(
      "reference falls back to the stop/target midpoint",
      geometryReference({ entry: null, breakout: null, stop: 100, target: 120 }) === 110
    );

    check("checkFills surfaces a bad ENTRY first", !checkFills({ entry: 15, exit: 160 }, UMBF).ok);
    check("checkFills catches a bad EXIT with a good entry", !checkFills({ entry: 153, exit: 16 }, UMBF).ok);
    check("checkFills passes a clean pair", checkFills({ entry: 153, exit: 168 }, UMBF).ok);
  }

  // ============================================================
  console.log("\n3. OWNED-POSITION EDIT — the 180s poll must not clobber the correction");
  // ============================================================
  const ownedRow: JackDecisionClient = {
    decisionId: 41,
    setupId: 7,
    ticker: "UMBF",
    handleLowDate: HLD,
    section: "open",
    decision: "TRADE",
    entry: UMBF.entry,
    stop: UMBF.stop,
    target: UMBF.target,
    shares: 200,
    breakout: UMBF.breakout,
    currentPrice: UMBF.currentPrice,
    note: null,
    newsClass: null,
    sectorRs: null,
    crossAsset: null,
    earningsFlag: null,
    pctToBreakout: null,
    userAction: "TRADED",
    userEntryPrice: 15.0, // the corrupted fill
    userEntryDate: "2026-07-10",
    userExitPrice: null,
    userExitDate: null,
    jackDecisionAtMark: "TRADE",
    sharesAtMark: 200,
    jackAnalysisAtMark: "Cup complete, handle tight.",
  };
  {
    const key = "d41";
    const seeded = seedRows([ownedRow]);
    check("the owned row seeds from the stored fill", seeded[key]?.entry === "15");

    // The user types the correction. Every keystroke marks the row dirty.
    const editing = { ...seeded, [key]: { ...seeded[key], entry: "153.00", dirty: true } };

    // …then the 180s open-position poll (or a window-focus refetch) re-seeds.
    const merged = mergeSeeded(editing, seedRows([ownedRow]));
    check("an UNSAVED correction survives the server re-seed", merged[key]?.entry === "153.00", merged[key]?.entry);

    // After a successful save the row is clean again, so the server value wins —
    // this is what lets a corrected value refresh from the DB.
    const savedClean = { ...merged, [key]: { ...merged[key], dirty: false } };
    const afterSave = mergeSeeded(savedClean, seedRows([{ ...ownedRow, userEntryPrice: 153 }]));
    check("a CLEAN row takes the fresh server value", afterSave[key]?.entry === "153");

    // A dirty row the new seed doesn't know about is not dropped mid-edit.
    const orphan = mergeSeeded({ zz: { ...seeded[key], entry: "99", dirty: true } }, seedRows([ownedRow]));
    check("a dirty row missing from the new seed is kept", orphan["zz"]?.entry === "99");
    check("…and the seeded rows are still there", orphan[key]?.entry === "15");
  }

  // ============================================================
  console.log("\n4. OWNED-POSITION EDIT — the row renders and advertises the correction");
  // ============================================================
  {
    // Rows are collapsed by default and there is no DOM here (no jsdom), so this
    // cannot click the row open — the fill panel itself is covered by 3 + 5. What it
    // does prove: an owned row reaches the board, routes to CURRENT POSITIONS, and
    // the group tells the user the logged ENTRY (not just the exit) is editable.
    const html = renderToStaticMarkup(
      <JackDecisionsTable decisions={[ownedRow]} isDarkMode persistenceAvailable individualCap={200000} />
    );
    check("the open row renders in CURRENT POSITIONS", html.includes("CURRENT POSITIONS"));
    check("the group tells the user the entry fill is correctable", html.includes("correct the logged entry fill"));
    check("the row is marked TRADED", html.includes("TRADED"));
    check("the mis-filled ticker is on the board", html.includes("UMBF"));
  }

  // ============================================================
  console.log("\n5. DB ROUND TRIP — correcting an owned position's entry fill");
  // ============================================================
  {
    const write = await import("../lib/db/write");
    const read = await import("../lib/db/read");
    const { getDb } = await import("../lib/db/init");
    const db = getDb();

    const setupId = write.upsertSetup(
      {
        ticker: "UMBF",
        handleLowDate: HLD,
        status: "just_fired",
        entry: UMBF.entry,
        stop: UMBF.stop,
        t05Target: UMBF.target,
        breakoutLevel: UMBF.breakout,
        tier: "Q5",
        priority: 8.2,
        sizeBucket: "full",
      },
      "2026-07-06T12:00:00Z"
    );
    const runId = write.insertValidationRun({
      timestamp: "2026-07-06T12:00:00Z", inputRowCount: 1, totalFinalCount: 1, liveFinalCount: 1,
      pendingFinalCount: 0, liveDroppedStale: 0, pendingDroppedStale: 0, liveDroppedOverCap: 0,
      pendingDroppedOverCap: 0, tiingoAttempted: 0, tiingoSucceeded: 0, riskPerTrade: 2000, parseSuccess: true,
    });
    const { ids } = write.insertDecisions(
      [{ ticker: "UMBF", handleLowDate: HLD, section: "live", decision: "TRADE", shares: 200 }],
      runId,
      new Map([[`UMBF|${HLD}`, setupId]])
    );
    read.markDecisionUserAction(ids[0].decisionId, "TRADED");

    // The corrupted fill goes in exactly as the UI wrote it.
    write.updateUserFills(setupId, 15.0, "2026-07-10", null, null);
    const before = read.getOpenPositions().find((p) => p.ticker === "UMBF");
    check("the mis-filled position is OPEN (reachable to correct)", before != null);
    check("…carrying the bad 15.00 fill", before?.userEntryPrice === 15.0, String(before?.userEntryPrice));

    // The correction — the exit side passed back unchanged (what the script does).
    const res = write.updateUserFills(setupId, 153.0, before?.userEntryDate ?? null, before?.userExitPrice ?? null, before?.userExitDate ?? null);
    const after = read.getOpenPositions().find((p) => p.ticker === "UMBF");
    check("the entry fill is corrected", after?.userEntryPrice === 153.0, String(after?.userEntryPrice));
    check("the entry DATE is preserved", after?.userEntryDate === "2026-07-10", String(after?.userEntryDate));
    check("the position is STILL open (no exit invented)", after != null && after.userExitPrice == null);
    check("user_R stays null while open", res.userRRealized === null, String(res.userRRealized));
    check("the stop used is the setup's", res.stop === UMBF.stop, String(res.stop));
    check(
      "exactly one outcomes row for the setup",
      (db.prepare(`SELECT COUNT(*) AS c FROM outcomes WHERE setup_id = ?`).get(setupId) as { c: number }).c === 1
    );

    // …and once it closes, user_R is computed off the CORRECTED basis.
    write.updateUserFills(setupId, 153.0, "2026-07-10", 168.0, "2026-08-01");
    const closed = db
      .prepare(`SELECT user_R_realized AS r FROM outcomes WHERE setup_id = ?`)
      .get(setupId) as { r: number };
    const expected = (168 - 153) / (153 - UMBF.stop);
    check("user_R is computed off the corrected basis", Math.abs(closed.r - expected) < 1e-9, `${closed.r} vs ${expected}`);
    check("the closed position leaves CURRENT POSITIONS", read.getOpenPositions().every((p) => p.ticker !== "UMBF"));

    // The guard would have stopped the original mistake at the door.
    const guarded = checkFillPrice("entry", 15.0, {
      entry: before?.entry ?? null,
      breakout: before?.breakout ?? null,
      stop: before?.stop ?? null,
      target: before?.target ?? null,
    });
    check("the guard rejects 15.00 against the STORED setup geometry", !guarded.ok, guarded.reason);
  }
}

const dir = mkdtempSync(join(tmpdir(), "jack-fill-guard-"));
process.env.JACK_DB_PATH = join(dir, "test.db");

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
