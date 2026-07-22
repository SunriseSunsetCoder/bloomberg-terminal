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

export function combineJackDecisions(
  runDecisions: JackDecisionClient[],
  openPositions: JackDecisionClient[]
): JackDecisionClient[] {
  const runNonOwned = runDecisions.filter((d) => !isOwnedPosition(d));
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
