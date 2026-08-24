import { computeSizing, normalizeSizeBucket } from "@/lib/jack/handle-score";
import { finalizeClientDecisions, type JackDecisionClient } from "@/lib/jack/validation-core";
import type { CurrentBoardRow, UserMark } from "@/lib/db/read";
import type { StoredPrices } from "@/lib/jack/price-refresh";

// ============================================================================
// The HYDRATION render path's row shaping — SQLite rows → JackDecisionClient[].
//
// This lives in lib/, not inside app/api/jack-board/route.ts, for two reasons.
// A route.ts may export only handlers + config (the Next 16 build constraint
// that 1efe942 fixed), so a route-local mapper is unreachable from anywhere
// else — including a test. And a mapper no test can reach is precisely how this
// path drifted from the VALIDATE path twice: the only way to check it was to
// re-implement it in the test, which checks the copy rather than the code.
//
// Both type-only imports above are erased at compile time, so requiring this
// module never pulls better-sqlite3 into an environment that cannot load it
// (Vercel). The route still require()s lib/db/read lazily, as before.
// ============================================================================

/**
 * Is the price store from TODAY (ET)? A stale store must not be shown as NOW.
 *
 * The board route previously skipped this check entirely while
 * /api/jack-open-positions applied it, so the same jack:prices value could render
 * as a live price on one surface and be correctly ignored on the other.
 */
export function isPriceStoreFresh(store: StoredPrices | null, etDay: string): boolean {
  if (!store?.asOf) return false;
  const d = new Date(store.asOf);
  if (Number.isNaN(d.getTime())) return false;
  return etDateISO(d) === etDay;
}

/** ET calendar date of an instant, as YYYY-MM-DD. */
export function etDateISO(d: Date): string {
  // en-CA gives ISO-shaped YYYY-MM-DD directly.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export interface HydrationInput {
  rows: CurrentBoardRow[];
  riskPerTrade: number;
  marks: Map<number, UserMark>;
  /** The jack:prices store, or null when Redis is unavailable/absent. */
  priceStore: StoredPrices | null;
  /** ET day to judge the store's freshness against. */
  etDay: string;
}

/**
 * Rebuild the board's client rows from persisted state.
 *
 * Exits through finalizeClientDecisions — the same call buildClientDecisions
 * ends with — so numeric types and row order are settled identically for both
 * render paths. Do not sort or coerce here; that is the shared exit's job, and
 * duplicating it is how the two paths drift apart again.
 */
export function buildHydratedDecisions(input: HydrationInput): JackDecisionClient[] {
  const { rows, riskPerTrade, marks, priceStore, etDay } = input;
  const fresh = isPriceStoreFresh(priceStore, etDay);
  const prices = fresh ? priceStore?.prices ?? {} : {};

  const mapped: JackDecisionClient[] = rows.map((r) => {
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
      // The store holds { price, source, asOf } per ticker — read `.price`, the
      // way /api/jack-open-positions always has. Handing the whole object to a
      // field typed `number | null` is what made the price ladder call .toFixed
      // on an object. finalizeClientDecisions unwraps defensively too; this is
      // the correct read, not a reliance on that safety net.
      currentPrice: prices[r.ticker.toUpperCase()]?.price ?? null,

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
    } as JackDecisionClient;
  });

  return finalizeClientDecisions(mapped);
}
