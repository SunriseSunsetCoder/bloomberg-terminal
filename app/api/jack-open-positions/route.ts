import { NextResponse } from "next/server";
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";

export const dynamic = "force-dynamic";

// ============================================================
// Open positions — every setup marked TRADED with an entry but no exit yet,
// REGARDLESS of the current run. Returned as JackDecisionClient rows (section
// "open") so the JACK decision table can render them as fully-editable TRADED
// rows (exit price/date + Save) at the top of the working view. READ-ONLY here;
// the fill write still goes through updateUserFills via /api/jack-decisions.
// Vercel-guarded (localhost SQLite only).
// ============================================================

interface OpenPositionsResponse {
  ok: boolean;
  persistenceAvailable: boolean;
  positions: JackDecisionClient[];
  reason?: string;
  error?: string;
}

export async function GET() {
  if (!isPersistenceAvailable()) {
    return NextResponse.json<OpenPositionsResponse>({
      ok: false,
      persistenceAvailable: false,
      positions: [],
      reason: persistenceUnavailableReason(),
    });
  }
  try {
    const { getOpenPositions } = require("@/lib/db/read") as typeof import("@/lib/db/read");
    const positions: JackDecisionClient[] = getOpenPositions().map((r) => ({
      decisionId: r.decisionId,
      setupId: r.setupId,
      ticker: r.ticker,
      handleLowDate: r.handleLowDate,
      section: "open",
      decision: r.jackDecisionAtMark ?? "TRADED",
      entry: r.entry,
      stop: r.stop,
      target: r.target,
      shares: r.shares,
      breakout: r.breakout,
      currentPrice: null, // no live mark stored for open positions
      note: null,
      newsClass: null,
      sectorRs: null,
      crossAsset: null,
      earningsFlag: null,
      pctToBreakout: null,
      userAction: "TRADED",
      userEntryPrice: r.userEntryPrice,
      userEntryDate: r.userEntryDate,
      userExitPrice: r.userExitPrice, // null (open) — the field the user fills to close it
      userExitDate: r.userExitDate,
      jackDecisionAtMark: r.jackDecisionAtMark,
      sharesAtMark: r.shares,
    }));
    return NextResponse.json<OpenPositionsResponse>({ ok: true, persistenceAvailable: true, positions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<OpenPositionsResponse>(
      { ok: false, persistenceAvailable: true, positions: [], error: msg },
      { status: 500 }
    );
  }
}
