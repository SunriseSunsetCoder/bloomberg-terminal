import { NextResponse } from "next/server";
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";
// Type-only — compiles away, keeps better-sqlite3 off Vercel.
import type { BasketCandidate, OpenHolding } from "@/lib/jack/basket";
// The candidate gate is pure and shared — the basket sizes the board's LIVE (fired)
// new-entry group, never the whole pending pipeline.
import { selectBasketCandidates } from "@/lib/jack/basket";
import { isInLiveDisplayGroup } from "@/lib/jack/combine-decisions";

export const dynamic = "force-dynamic";

// ============================================================
// Basket Sizer feed — READ-ONLY. Two INDEPENDENT feeds:
//
//   · candidates — getCurrentBoard() (the whole current run: live + pending) narrowed
//     by selectBasketCandidates to the board's LIVE DISPLAY GROUP: validated-live rows
//     PLUS fired-promoted pending ones, minus owned / retired / SKIP-tier. Sourcing
//     from getPendingSetups() was the bug: it only ever returns section='pending', so
//     validated-LIVE setups could never appear no matter what.
//   · open — getOpenPositions(). Deliberately NOT run-scoped: an open position
//     persists across validation runs, so the whole owned set rolls into the
//     combined-book math (sector caps, buying power, heat, slots).
//
// Each feed has its OWN try/catch. A failure in one must never blank the other — a
// single shared catch is what turns one bad query into an entirely empty page. Errors
// are returned per-feed so the view can say WHICH half failed instead of rendering
// nothing.
//
// No writes, no LLM, no Tiingo. Never touches decisions.section, the pending scope,
// alerts, or outcomes — the Basket Sizer is a planning view.
// ============================================================

interface BasketFeedResponse {
  ok: boolean;
  persistenceAvailable: boolean;
  reason?: string;
  candidates?: BasketCandidate[];
  open?: OpenHolding[];
  /** Size of the un-narrowed pending pipeline, for the empty state. */
  pendingTotal?: number;
  /** Size of the board's LIVE display group BEFORE the basket's own filters. */
  boardLiveTotal?: number;
  /** Per-feed failures. Either can be set while the other half still returns data. */
  candidatesError?: string;
  openError?: string;
  error?: string;
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function GET() {
  if (!isPersistenceAvailable()) {
    return NextResponse.json<BasketFeedResponse>({
      ok: false,
      persistenceAvailable: false,
      reason: persistenceUnavailableReason(),
    });
  }

  let dbRead: typeof import("@/lib/db/read");
  try {
    // Lazy-load so better-sqlite3 is only required on the VPS/local (never Vercel).
    dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");
  } catch (err) {
    console.error("[jack-basket] DB layer failed to load:", err);
    return NextResponse.json<BasketFeedResponse>(
      { ok: false, persistenceAvailable: true, error: msg(err) },
      { status: 500 }
    );
  }

  // ---- feed 1: LIVE (fired) candidates -------------------------------------
  let candidates: BasketCandidate[] = [];
  let pendingTotal: number | undefined;
  let boardLiveTotal: number | undefined;
  let candidatesError: string | undefined;
  try {
    const board = dbRead.getCurrentBoard();
    const all = [...board.live, ...board.pending];
    pendingTotal = board.pending.length;
    boardLiveTotal = all.filter(isInLiveDisplayGroup).length;
    candidates = selectBasketCandidates(all).map((p) => ({
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
  } catch (err) {
    candidatesError = msg(err);
    console.error("[jack-basket] LIVE candidate feed failed (open book unaffected):", err);
  }

  // ---- feed 2: the open book (run-independent) -----------------------------
  let open: OpenHolding[] = [];
  let openError: string | undefined;
  try {
    open = dbRead.getOpenPositions().map((p) => ({
      setupId: p.setupId,
      ticker: p.ticker,
      sector: p.sector,
      tier: p.tier,
      entry: p.entry,
      stop: p.stop,
      shares: p.shares,
      userEntryPrice: p.userEntryPrice,
    }));
  } catch (err) {
    openError = msg(err);
    console.error("[jack-basket] open-position feed failed (candidates unaffected):", err);
  }

  console.log(
    `[jack-basket] ${candidates.length} basket row(s) of ${boardLiveTotal ?? "?"} in the board LIVE group · ` +
      `${pendingTotal ?? "?"} pending · ` +
      `${open.length} open position(s)` +
      (candidatesError ? ` · candidates ERROR: ${candidatesError}` : "") +
      (openError ? ` · open ERROR: ${openError}` : "")
  );

  return NextResponse.json<BasketFeedResponse>({
    ok: !candidatesError && !openError,
    persistenceAvailable: true,
    candidates,
    open,
    pendingTotal,
    boardLiveTotal,
    candidatesError,
    openError,
  });
}
