import { NextResponse } from "next/server";
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
// Type-only — compiles away, keeps better-sqlite3 off Vercel.
import type { BasketCandidate, OpenHolding } from "@/lib/jack/basket";
// The candidate gate is pure and shared — the basket sizes the board's LIVE (fired)
// new-entry group, never the whole pending pipeline.
import { selectBasketCandidates } from "@/lib/jack/basket";

export const dynamic = "force-dynamic";

// ============================================================
// Basket Sizer feed — READ-ONLY. Serves the two accessors the page needs:
//   · getPendingSetups()  — the run-scoped, owned-excluded pending set, then narrowed
//     by selectBasketCandidates to the FIRED + tradeable rows (the board's LIVE
//     new-entry group). Un-fired and resolved setups are NOT basket rows.
//   · getOpenPositions()  — what is already held. Deliberately NOT run-scoped: an open
//     position persists across validation runs, so the whole owned set rolls into the
//     combined-book math (sector caps, buying power, heat, slots).
//
// No writes, no LLM, no Tiingo. This route never touches decisions.section, the
// pending scope, alerts, or outcomes — the Basket Sizer is a planning view.
// ============================================================

interface BasketFeedResponse {
  ok: boolean;
  persistenceAvailable: boolean;
  reason?: string;
  candidates?: BasketCandidate[];
  open?: OpenHolding[];
  /** Diagnostics for the empty state: how much of the pipeline is waiting to fire. */
  pendingTotal?: number;
  error?: string;
}

export async function GET() {
  if (!isPersistenceAvailable()) {
    return NextResponse.json<BasketFeedResponse>({
      ok: false,
      persistenceAvailable: false,
      reason: persistenceUnavailableReason(),
    });
  }

  try {
    // Lazy-load so better-sqlite3 is only required on the VPS/local (never Vercel).
    const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");

    const pending = dbRead.getPendingSetups();
    // FIRED + tradeable + not-owned only. Same predicates the board routes with.
    const candidates: BasketCandidate[] = selectBasketCandidates(pending).map((p) => ({
      setupId: p.setupId,
      ticker: p.ticker,
      handleLowDate: p.handleLowDate,
      entry: p.entry,
      stop: p.stop,
      target: p.target,
      tier: p.tier,
      sector: p.sector,
      priority: p.priority,
      sizeBucket: p.sizeBucket,
      handleScore: p.handleScore,
    }));

    const open: OpenHolding[] = dbRead.getOpenPositions().map((p) => ({
      setupId: p.setupId,
      ticker: p.ticker,
      sector: p.sector,
      entry: p.entry,
      stop: p.stop,
      shares: p.shares,
      userEntryPrice: p.userEntryPrice,
    }));

    return NextResponse.json<BasketFeedResponse>({
      ok: true,
      persistenceAvailable: true,
      candidates,
      open,
      pendingTotal: pending.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<BasketFeedResponse>({ ok: false, persistenceAvailable: true, error: msg }, { status: 500 });
  }
}
