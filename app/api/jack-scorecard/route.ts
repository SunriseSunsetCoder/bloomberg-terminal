import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
// Type-only — compiles away, keeps better-sqlite3 off Vercel.
import type { JackScorecard } from "@/lib/jack/scorecard";

export const dynamic = "force-dynamic";

// ============================================================
// JACK Performance Scorecard — READ-ONLY. Same guard pattern as jack-analytics:
// on Vercel (no persistent SQLite) it returns a disabled payload without ever
// require()ing the DB layer. No writes, no schema changes, no LLM, no Tiingo — it
// only re-reads outcome rows the replay already produced.
//
//   GET /api/jack-scorecard?risk=2000   → risk/trade for the $ equity curve
// ============================================================

interface ScorecardResponse {
  ok: boolean;
  persistenceAvailable: boolean;
  reason?: string;
  scorecard?: JackScorecard;
  error?: string;
}

const DEFAULT_RISK = 2000;

export async function GET(req: NextRequest) {
  if (!isPersistenceAvailable()) {
    return NextResponse.json<ScorecardResponse>({
      ok: false,
      persistenceAvailable: false,
      reason: persistenceUnavailableReason(),
    });
  }

  const raw = Number(req.nextUrl.searchParams.get("risk"));
  const riskPerTrade = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RISK;

  try {
    // Lazy-load so better-sqlite3 is only required on the VPS/local (never Vercel).
    const { getScorecardRows, getPriorityRanks } =
      require("@/lib/db/analytics") as typeof import("@/lib/db/analytics");
    const { computeScorecard } = require("@/lib/jack/scorecard") as typeof import("@/lib/jack/scorecard");
    const scorecard = computeScorecard(getScorecardRows(), getPriorityRanks(), riskPerTrade);
    return NextResponse.json<ScorecardResponse>({ ok: true, persistenceAvailable: true, scorecard });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<ScorecardResponse>(
      { ok: false, persistenceAvailable: true, error: msg },
      { status: 500 }
    );
  }
}
