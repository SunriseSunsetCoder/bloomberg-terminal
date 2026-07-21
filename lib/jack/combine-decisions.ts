// =============================================================================
// JACK decision merge — PURE (no React, no DB). Combines this week's validation
// decisions with the open-positions fetch into ONE list where every setup lands
// in exactly one section.
//
// Rule: a setup whose LATEST mark is TRADED is a POSITION TO MANAGE, not a
// candidate. It renders in CURRENT POSITIONS (section "open", the open-management
// view), never in LIVE/PENDING — regardless of whether an entry fill is logged.
//   · owned            — the open-positions rows (getOpenPositions, now fill-agnostic),
//                        minus any that also appear as a NON-traded run row (safety net).
//   · tradedUncovered  — fall-through guard: a TRADED run row not yet represented by an
//                        owned row (open fetch still loading / a race) is re-sectioned to
//                        "open" so a TRADED setup can NEVER vanish.
//   · runNonTraded     — PASSED / WATCHING / unmarked run rows stay in LIVE/PENDING.
//
// Invariant (unit-tested): every TRADED setup appears in exactly one section (open);
// every non-traded run row in exactly one (live/pending); no setup vanishes, none
// double-renders.
// =============================================================================

import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";

export function combineJackDecisions(
  runDecisions: JackDecisionClient[],
  openPositions: JackDecisionClient[]
): JackDecisionClient[] {
  const runNonTraded = runDecisions.filter((d) => d.userAction !== "TRADED");
  const nonTradedIds = new Set(
    runNonTraded.map((d) => d.setupId).filter((x): x is number => x != null)
  );
  // Owned rows are TRADED (getOpenPositions returns latest-mark-TRADED setups), so
  // they never overlap a non-traded run row; the filter is a defensive safety net.
  const owned = openPositions.filter((p) => p.setupId == null || !nonTradedIds.has(p.setupId));
  const ownedIds = new Set(owned.map((p) => p.setupId).filter((x): x is number => x != null));

  const tradedUncovered = runDecisions
    .filter((d) => d.userAction === "TRADED" && (d.setupId == null || !ownedIds.has(d.setupId)))
    .map((d) => ({ ...d, section: "open" as const }));

  return [...owned, ...tradedUncovered, ...runNonTraded];
}
