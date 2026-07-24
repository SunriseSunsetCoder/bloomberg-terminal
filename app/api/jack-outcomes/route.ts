import { NextRequest, NextResponse } from "next/server";
// Concrete DB functions are loaded lazily via require() inside runOutcomeTracker so
// better-sqlite3 (native) is never required on Vercel (isPersistenceAvailable() === false).
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
// The replay core lives in lib/ so other modules (outcomes-refresh, price-refresh,
// backfill scripts) can import it — Next route files may ONLY export handlers +
// config, so shared helpers must not be exported from a route module.
import {
  runOutcomeTracker,
  DEFAULT_RESOLUTION_DAYS,
  ASSUMPTION_LABELS,
  type OutcomesSummary,
} from "@/lib/jack/outcome-tracker";

export const maxDuration = 120; // parallel Tiingo history fetches for many setups
export const dynamic = "force-dynamic";

// ============================================================
// Internal Tiingo EOD proxy base — derived from the request headers so the
// replay core can call the (now-fixed) [ticker] route with the Session B startDate.
// ============================================================
function tiingoBaseUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}/api/tiingo`;
}

// ============================================================
// POST — run the outcome tracker over all setups needing outcomes.
// ============================================================
export async function POST(req: NextRequest) {
  // Vercel guard — never touch the DB layer when persistence is off.
  if (!isPersistenceAvailable()) {
    return NextResponse.json<OutcomesSummary>(
      {
        ok: false,
        resolutionDays: DEFAULT_RESOLUTION_DAYS,
        candidates: 0,
        processed: 0,
        fired: 0,
        target: 0,
        stop: 0,
        timeout: 0,
        never_fired: 0,
        deferred: 0,
        skipped: 0,
        assumptions: ASSUMPTION_LABELS,
        details: [],
        message: `Persistence ${persistenceUnavailableReason()} — outcome tracking runs on the VPS only.`,
        error: persistenceUnavailableReason(),
      },
      { status: 200 }
    );
  }

  // Optional resolutionDays override (smoke tests use a smaller window so
  // not-yet-resolved setups resolve). Defaults to DEFAULT_RESOLUTION_DAYS — no edit needed.
  let resolutionDays = DEFAULT_RESOLUTION_DAYS;
  try {
    const body = (await req.json().catch(() => ({}))) as { resolutionDays?: number };
    if (typeof body.resolutionDays === "number" && body.resolutionDays > 0) {
      resolutionDays = Math.floor(body.resolutionDays);
    }
  } catch {
    // no body — use default
  }

  try {
    const summary = await runOutcomeTracker({ resolutionDays, tiingoBase: tiingoBaseUrl(req) });
    return NextResponse.json<OutcomesSummary>(summary, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<OutcomesSummary>(
      {
        ok: false,
        resolutionDays,
        candidates: 0,
        processed: 0,
        fired: 0,
        target: 0,
        stop: 0,
        timeout: 0,
        never_fired: 0,
        deferred: 0,
        skipped: 0,
        assumptions: ASSUMPTION_LABELS,
        details: [],
        message: `Outcome tracker failed: ${msg}`,
        error: msg,
      },
      { status: 500 }
    );
  }
}
