import { NextResponse } from "next/server";
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
// Type-only — compiles away, keeps better-sqlite3 off Vercel.
import type { JackAnalytics } from "@/lib/jack/analytics";

export const dynamic = "force-dynamic";

// ============================================================
// JACK Session C analytics — READ-ONLY. Guarded by isPersistenceAvailable():
// on Vercel (no persistent SQLite) it returns a disabled payload without ever
// require()ing the DB layer. On the VPS/local it reads decision/outcome data and
// computes edge-decay / selection-value / execution / decision-breakdown stats.
// No writes, no schema changes.
// ============================================================

interface AnalyticsResponse {
  ok: boolean;
  persistenceAvailable: boolean;
  reason?: string;
  analytics?: JackAnalytics;
  error?: string;
}

export async function GET() {
  if (!isPersistenceAvailable()) {
    return NextResponse.json<AnalyticsResponse>({
      ok: false,
      persistenceAvailable: false,
      reason: persistenceUnavailableReason(),
    });
  }
  try {
    // Lazy-load so better-sqlite3 is only required on the VPS/local (never Vercel).
    const { getAnalyticsRows } = require("@/lib/db/analytics") as typeof import("@/lib/db/analytics");
    const { computeAnalytics } = require("@/lib/jack/analytics") as typeof import("@/lib/jack/analytics");
    const rows = getAnalyticsRows();
    const analytics = computeAnalytics(rows);
    return NextResponse.json<AnalyticsResponse>({ ok: true, persistenceAvailable: true, analytics });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<AnalyticsResponse>(
      { ok: false, persistenceAvailable: true, error: msg },
      { status: 500 }
    );
  }
}
