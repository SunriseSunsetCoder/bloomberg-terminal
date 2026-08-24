import { NextResponse } from "next/server";
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
import { computeSizing, normalizeSizeBucket } from "@/lib/jack/handle-score";
import { DEFAULT_RISK_PER_TRADE, type JackDecisionClient } from "@/lib/jack/validation-core";

export const dynamic = "force-dynamic";

// Mirrors PRICES_KEY in lib/jack/price-refresh.ts, inlined for the same reason
// /api/jack-open-positions inlines it: importing that module here would pull the
// Tiingo/refresh chain into a read-only route.
const PRICES_KEY = "jack:prices";

// ============================================================================
// GET /api/jack-board — rebuild the CURRENT board from SQLite.
//
// WHY THIS EXISTS
//
// The terminal used to render the board from ONE place: the JSON body of the
// VALIDATE POST, mirrored into a client-side Jotai atom (jackResultAtom, a plain
// in-memory atom). That works when a human presses the button — the browser is
// the thing that receives the response.
//
// It does not work for the nightly pipeline. pipeline/ingest.py POSTs the same
// CSV to the same endpoint from the VPS; the run persists correctly and becomes
// getCurrentRunId(), but the response body goes to a Python process. No browser
// ever sees it, so the atom stays null and the terminal shows the empty
// "paste scanner CSV" state — while the board sits complete in jack.db.
//
// This route closes that gap: the board becomes a thing you can ASK the server
// for, not just a thing you happen to be holding. A fresh page load hydrates
// from here, so the morning after an unattended 19:00 run the board is simply
// there. It also fixes the latent refresh-wipe — losing the board on F5 was
// always a bug, just one everybody worked around by re-pasting.
//
// PRECEDENCE (enforced client-side, in useJackBoard): a live VALIDATE response
// always outranks a hydrated board. Hydration only fills the empty state, so
// pressing VALIDATE behaves exactly as it does today.
//
// WHAT HYDRATES — the actionable board is COMPLETE. Levels (entry/stop/target/
// breakout), tier, size_bucket, handle_score, priority, sector, cup/handle
// geometry, fired state, the Phase 3 entry_status stamp, user marks, and the
// analysis commentary all round-trip, because all of it is persisted.
//
// WHAT DOES NOT — nothing on the board itself. days_since_handle_low is now
// persisted alongside the freshness stamp, so a restored board shows the number
// the CSV carried. It is still never RECOMPUTED here: re-deriving it from a wall
// clock is precisely the drift the ASOF anchor fix removed.
//
// Open-position fields (unrealizedPct, daysHeld, rulesFlag, liveRead*) are not
// this route's job — they arrive from /api/jack-open-positions and are merged by
// combineJackDecisions exactly as they are for a VALIDATE-rendered board.
// ============================================================================

export interface JackBoardResponse {
  runId: number | null;
  decisions: JackDecisionClient[];
  riskPerTrade: number;
  /** ISO timestamp of the run that produced this board. */
  runTimestamp: string | null;
  persistenceAvailable: boolean;
  /** True when the board came from SQLite rather than a live validation. */
  hydrated: boolean;
  error?: string;
}

const empty = (over: Partial<JackBoardResponse> = {}): JackBoardResponse => ({
  runId: null,
  decisions: [],
  riskPerTrade: DEFAULT_RISK_PER_TRADE,
  runTimestamp: null,
  persistenceAvailable: isPersistenceAvailable(),
  hydrated: false,
  ...over,
});

export async function GET() {
  // Vercel guard — never require the native DB layer where it cannot load.
  if (!isPersistenceAvailable()) {
    return NextResponse.json<JackBoardResponse>(
      empty({ error: persistenceUnavailableReason() })
    );
  }

  try {
    const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");
    const board = dbRead.getCurrentBoard();
    if (board.runId === null) {
      return NextResponse.json<JackBoardResponse>(empty({ persistenceAvailable: true }));
    }

    const rows = [...board.live, ...board.pending];

    // The run's OWN risk setting, so recomputed share counts match what that run
    // was sized against rather than today's default.
    const run = dbRead.getRunMeta(board.runId);
    const riskPerTrade = run?.riskPerTrade ?? DEFAULT_RISK_PER_TRADE;

    // Latest user marks (cross-run), the same source buildClientDecisions uses.
    const marks = dbRead.getUserMarksForSetups(rows.map((r) => r.setupId));

    // NOW price from the shared Redis store the open-position board already reads.
    // Best-effort: a Redis hiccup must not cost the whole board.
    let prices: Record<string, number> = {};
    try {
      const { redis } = await import("@/lib/redis");
      const store = (await redis.get(PRICES_KEY)) as { prices?: Record<string, number> } | null;
      prices = store?.prices ?? {};
    } catch {
      prices = {}; // a Redis hiccup must not cost the whole board
    }

    const decisions: JackDecisionClient[] = rows.map((r) => {
      const mark = marks.get(r.setupId);
      const bucket = normalizeSizeBucket(r.sizeBucket);
      const sizing = computeSizing(riskPerTrade, r.entry, r.stop);
      const recShares =
        bucket === "half" ? sizing.halfShares : bucket === "skip" ? null : sizing.fullShares;

      return {
        decisionId: r.decisionId,
        setupId: r.setupId,
        ticker: r.ticker,
        handleLowDate: r.handleLowDate,
        section: r.section,
        decision: r.decision,
        entry: r.entry,
        stop: r.stop,
        target: r.target,
        breakout: r.breakout,
        shares: r.shares ?? null,
        currentPrice: prices[r.ticker.toUpperCase()] ?? null,

        // Commentary — persisted per-decision all along, read back here.
        note: r.notes ?? null,
        newsClass: r.newsClass ?? null,
        sectorRs: r.sectorRs ?? null,
        crossAsset: r.crossAsset ?? null,
        earningsFlag: r.earningsFlag ?? null,
        pctToBreakout: r.pctToBreakout ?? null,

        // User marks + frozen decision-time context.
        userAction: mark?.userAction ?? r.userAction ?? null,
        userEntryPrice: mark?.userEntryPrice ?? null,
        userEntryDate: mark?.userEntryDate ?? null,
        userExitPrice: mark?.userExitPrice ?? r.userExitPrice ?? null,
        userExitDate: mark?.userExitDate ?? null,
        jackDecisionAtMark: mark?.jackDecisionAtMark ?? r.jackDecisionAtMark ?? null,
        sharesAtMark: mark?.sharesAtMark ?? null,
        jackAnalysisAtMark: r.jackAnalysisAtMark ?? null,

        // Fired state — what drives the pending→LIVE display re-section.
        firedAt: r.firedAt,
        fireClose: r.fireClose,
        fireBar: r.fireBar,
        firedStatus: r.firedStatus,

        // Scanner classification + geometry.
        handleScore: r.handleScore,
        sizeBucket: bucket,
        sector: r.sector,
        tier: r.tier,
        priority: r.priority,
        cupDepthPct: r.cupDepthPct ?? null,
        handleRetrPct: r.handleRetrPct ?? null,

        // Phase 3 entry freshness — the FRESH/AGING split.
        entryStatus: r.entryStatus ?? null,
        confirmedCloseDate: r.confirmedCloseDate ?? null,
        daysSinceConfirm: r.daysSinceConfirm ?? null,

        // Persisted by the ingest (the detector's ASOF-anchored value), never
        // recomputed here — re-deriving it from a wall clock is the drift the
        // anchor fix removed.
        daysSinceHandleLow: r.daysSinceHandleLow ?? null,

        // Sizing, recomputed from the run's own risk setting.
        fullShares: sizing.fullShares,
        fullNotional: sizing.fullNotional,
        halfShares: sizing.halfShares,
        halfNotional: sizing.halfNotional,
        recShares,
        recNotional: recShares != null && r.entry != null ? recShares * r.entry : null,
      };
    });

    return NextResponse.json<JackBoardResponse>({
      runId: board.runId,
      decisions,
      riskPerTrade,
      runTimestamp: run?.timestamp ?? null,
      persistenceAvailable: true,
      hydrated: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<JackBoardResponse>(
      empty({ persistenceAvailable: true, error: msg }),
      { status: 500 }
    );
  }
}
