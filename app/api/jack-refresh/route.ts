import { NextRequest, NextResponse } from "next/server";
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
import { isMarketOpen } from "@/lib/jack/market-hours";
import { runPriceRefresh, type RefreshResult } from "@/lib/jack/price-refresh";

export const maxDuration = 60; // eod path also runs the outcome tracker
export const dynamic = "force-dynamic";

// Lightweight price refresh for the open-position board — NOW price + unrealized
// (and, on the eod path only, the outcome tracker). NO LLM thesis re-read. Redis +
// Tiingo only (no better-sqlite3 at module scope), but needs the open book from
// SQLite, so it is VPS-guarded like the other JACK routes.
//   ?mode=auto      → intraday if the market is open now, else eod (default)
//   ?mode=intraday  → Tiingo IEX (display-only)
//   ?mode=eod       → Tiingo EOD close + outcome tracker
export interface JackRefreshResponse extends RefreshResult {
  persistenceAvailable: boolean;
  resolvedFrom?: "auto";
}

function baseUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

export async function POST(req: NextRequest) {
  if (!isPersistenceAvailable()) {
    return NextResponse.json<JackRefreshResponse>({
      ok: false,
      persistenceAvailable: false,
      mode: "eod",
      updated: 0,
      iexUnavailable: false,
      ranOutcomes: false,
      asOf: new Date().toISOString(),
      error: persistenceUnavailableReason(),
    });
  }

  const modeParam = new URL(req.url).searchParams.get("mode") ?? "auto";
  const isAuto = modeParam === "auto";
  const mode = isAuto ? (isMarketOpen(new Date()) ? "intraday" : "eod") : modeParam === "intraday" ? "intraday" : "eod";

  try {
    const result = await runPriceRefresh({ mode, selfBase: baseUrl(req) });
    return NextResponse.json<JackRefreshResponse>({
      ...result,
      persistenceAvailable: true,
      ...(isAuto ? { resolvedFrom: "auto" as const } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<JackRefreshResponse>(
      {
        ok: false,
        persistenceAvailable: true,
        mode,
        updated: 0,
        iexUnavailable: false,
        ranOutcomes: false,
        asOf: new Date().toISOString(),
        error: msg,
      },
      { status: 500 }
    );
  }
}
