import { NextResponse } from "next/server";
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
import { buildHydratedDecisions, etDateISO } from "@/lib/jack/board-hydration";
import { DEFAULT_RISK_PER_TRADE, type JackDecisionClient } from "@/lib/jack/validation-core";
import type { StoredPrices } from "@/lib/jack/price-refresh";

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
    //
    // The store's shape is StoredPrices — { price, source, asOf } PER TICKER, not
    // a bare number. It is handed to buildHydratedDecisions whole, which reads
    // `.price` and applies the same ET-day freshness gate /api/jack-open-positions
    // uses. Asserting a wrong shape here is what put an object into a field the
    // client type promised was a number.
    let priceStore: StoredPrices | null = null;
    try {
      const { redis } = await import("@/lib/redis");
      priceStore = (await redis.get(PRICES_KEY)) as StoredPrices | null;
    } catch {
      priceStore = null; // a Redis hiccup must not cost the whole board
    }

    // Shape the rows through the SHARED exit. buildHydratedDecisions ends with
    // finalizeClientDecisions, the same call buildClientDecisions ends with, so
    // this board is type- and order-identical to a VALIDATE-rendered one by
    // construction rather than by two mappers happening to agree.
    const decisions: JackDecisionClient[] = buildHydratedDecisions({
      rows,
      riskPerTrade,
      marks,
      priceStore,
      etDay: etDateISO(new Date()),
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
