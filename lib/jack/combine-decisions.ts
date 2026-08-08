// =============================================================================
// JACK decision merge — PURE (no React, no DB). Combines this week's validation
// decisions with the open-positions fetch into ONE list where every setup lands
// in exactly one section.
//
// Rule: a setup is OWNED (a position to manage) when its LATEST mark is TRADED AND
// it has NO recorded exit. An owned setup renders in CURRENT POSITIONS (section
// "open", the open-management view), never in LIVE/PENDING — regardless of whether
// an entry fill is logged. A RECORDED EXIT = closed = no longer owned; it routes
// normally (LIVE if still firing this week, else nowhere).
//   · owned          — the open-positions rows (getOpenPositions excludes exited),
//                      minus any that also appear as a NON-owned run row (safety net).
//   · ownedUncovered — fall-through guard: an OWNED run row not yet represented by an
//                      owned row (open fetch still loading / a race) is re-sectioned to
//                      "open" so an owned setup can NEVER vanish. Exited rows are NOT
//                      owned, so they are not re-grabbed here.
//   · runNonOwned    — everything else (PASSED / WATCHING / unmarked / EXITED) stays
//                      in its normal LIVE/PENDING section.
//
// Invariant (unit-tested): every TRADED setup appears in exactly one section (open);
// every non-traded run row in exactly one (live/pending); no setup vanishes, none
// double-renders.
// =============================================================================

import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";

// Owned = a live position to manage: marked TRADED AND no recorded exit. A
// recorded exit (userExitPrice set) = CLOSED, so the setup is no longer owned —
// it routes normally (LIVE if still firing this week, else nowhere). Keying only
// on userAction === "TRADED" (ignoring exit) is the bug that left an exited-but-
// still-firing setup stuck in CURRENT POSITIONS via the fall-through guard.
export const isOwnedPosition = (d: JackDecisionClient): boolean =>
  d.userAction === "TRADED" && d.userExitPrice == null;

/**
 * A close-confirmed fire that is still ACTIONABLE — the setup broke out and the trade
 * has not already played out. 'resolved' is deliberately excluded: it fired AND hit its
 * stop or target, so it must never join the actionable LIVE group.
 */
export const isFiredActionable = (d: JackDecisionClient): boolean =>
  d.firedStatus === "confirmed" || d.firedStatus === "late";

/**
 * DISPLAY re-section for a fired pending row: 'confirmed'/'late' render under LIVE.
 *
 * This is the same technique as the ownedUncovered re-section below — a `section`
 * override on the returned CLIENT object only. `decisions.section` in the DB is NEVER
 * written: it is the scoping key behind getPendingSetups() → the intraday price
 * refresh, the alert ticker batch, and the EOD entry/earnings passes. A fired setup
 * must stay in that set (its NOW price has to keep refreshing), so the DB says
 * "pending" while the UI says "live". That split is the whole point.
 *
 * Only a PENDING row is moved — a live row is already live, and 'resolved' stays put
 * carrying its flag so the view can show a muted "fired & resolved" tag.
 */
function applyFiredDisplaySection(d: JackDecisionClient): JackDecisionClient {
  // `dbSection` preserves where the row actually lives in the DB, so the P-rank
  // populations stay stable across a display move (see computePriorityRanks).
  if (d.section === "pending" && isFiredActionable(d)) {
    return { ...d, section: "live" as const, dbSection: "pending" as const };
  }
  return d;
}

// ============================================================================
// P-RANK — two INDEPENDENT ordinal sequences, each numbered from P1
//
//   · LIVE ranks    — over the current run's LIVE-section rows only
//   · PENDING ranks — over the current run's PENDING-section rows, ranked among
//                     themselves ("as if it breaks")
//
// Both populations are taken from the DB SECTION (dbSection ?? section), i.e. BEFORE
// any display re-sectioning. A pending setup that fires and moves into the LIVE
// display group keeps its PENDING rank and is NOT added to the live population — so a
// fire can never renumber this week's live P-ranks.
//
// The ordering blend is the same one buildClientDecisions sorts LIVE by (scanner
// priority DESC → size bucket → handle_score DESC → stable), so live ranks are
// unchanged from the previous position-derived numbering.
// ============================================================================

const BUCKET_RANK: Record<string, number> = { full: 0, half: 1, skip: 2 };

/** Identity for rank lookup. NOT section-keyed — a row's section can change for display. */
export const rankKey = (d: JackDecisionClient): string => `${d.ticker}|${d.handleLowDate}`;

/** Where the row lives in the DB, regardless of where it is being displayed. */
export const dbSectionOf = (d: JackDecisionClient): "live" | "pending" | "open" =>
  d.dbSection ?? d.section;

/**
 * Ordinal ranks (1..N) over ONE population, keyed by rankKey.
 *
 * Owned (TRADED) rows and rows with no scanner priority consume no number — a P-rank
 * covers setups you can still deploy into, matching the prior behaviour.
 */
export function computePriorityRanks(rows: JackDecisionClient[]): Map<string, number> {
  const ranked = rows
    .filter((d) => d.userAction !== "TRADED" && d.priority != null)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      const pa = a.d.priority as number;
      const pb = b.d.priority as number;
      if (pa !== pb) return pb - pa; // higher priority first
      const ba = a.d.sizeBucket ? BUCKET_RANK[a.d.sizeBucket] ?? 3 : 3;
      const bb = b.d.sizeBucket ? BUCKET_RANK[b.d.sizeBucket] ?? 3 : 3;
      if (ba !== bb) return ba - bb;
      const sa = a.d.handleScore ?? Number.NEGATIVE_INFINITY;
      const sb = b.d.handleScore ?? Number.NEGATIVE_INFINITY;
      if (sa !== sb) return sb - sa;
      return a.i - b.i; // stable
    })
    .map((x) => x.d);

  const m = new Map<string, number>();
  ranked.forEach((d, idx) => m.set(rankKey(d), idx + 1));
  return m;
}

/**
 * Both sequences at once, split by DB section. Pass the COMBINED rows — the split
 * uses dbSectionOf, so it is immune to the fired display move.
 */
export function computeSectionRanks(rows: JackDecisionClient[]): {
  live: Map<string, number>;
  pending: Map<string, number>;
} {
  return {
    live: computePriorityRanks(rows.filter((d) => dbSectionOf(d) === "live")),
    pending: computePriorityRanks(rows.filter((d) => dbSectionOf(d) === "pending")),
  };
}

export function combineJackDecisions(
  runDecisions: JackDecisionClient[],
  openPositions: JackDecisionClient[]
): JackDecisionClient[] {
  // OWNED WINS: the fired re-section applies only to rows that are NOT owned, so a
  // setup you already hold still routes to CURRENT POSITIONS regardless of its flag.
  const runNonOwned = runDecisions.filter((d) => !isOwnedPosition(d)).map(applyFiredDisplaySection);
  const nonOwnedIds = new Set(
    runNonOwned.map((d) => d.setupId).filter((x): x is number => x != null)
  );
  // Owned rows come from getOpenPositions (latest-mark-TRADED + no exit), so they
  // never overlap a non-owned run row; the filter is a defensive safety net that
  // ALSO drops a stale open-fetch row once the run row shows a fresh exit.
  const owned = openPositions.filter((p) => p.setupId == null || !nonOwnedIds.has(p.setupId));
  const ownedIds = new Set(owned.map((p) => p.setupId).filter((x): x is number => x != null));

  // Fall-through guard: an OWNED run row not yet covered by an owned row (open
  // fetch still loading / a race) is re-sectioned to "open" so it can't vanish.
  // Now gated on isOwnedPosition, so an exited row is NOT re-grabbed here.
  const ownedUncovered = runDecisions
    .filter((d) => isOwnedPosition(d) && (d.setupId == null || !ownedIds.has(d.setupId)))
    .map((d) => ({ ...d, section: "open" as const }));

  return [...owned, ...ownedUncovered, ...runNonOwned];
}
