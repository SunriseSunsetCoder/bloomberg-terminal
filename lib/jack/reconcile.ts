// =============================================================================
// JACK validation output-reconciliation — PURE (no DB, no network, no React).
//
// After the (possibly sub-batched, possibly truncated) Claude calls return, every
// input setup must end up with a decision. Any setup the model did NOT return a
// decision for gets an explicit INCOMPLETE placeholder — never a silent drop and
// never a defaulted SKIP. This module is the single source of truth for that
// reconciliation + the run-level "degraded" rule, so it is unit-testable in
// isolation (see scripts/jack-analysis-cap-selftest.ts).
//
// Extracted from app/api/jack-validation/route.ts (cap-harden, 2026-07-20) so the
// truncation/degrade logic has an automated guard.
// =============================================================================

// The exact placeholder verdict for a setup with no returned decision. It must
// NOT contain TRADE / SKIP / AVOID / PASS / WATCH so the display layer classifies
// it as "other" — no SKIP veto, no "signals disagree" flag. Guarded by the
// selftest (case iii).
export const INCOMPLETE_DECISION = "INCOMPLETE — RE-RUN";

/**
 * Normalize a date from Claude's JSON to ISO YYYY-MM-DD.
 * Accepts YYYY-MM-DD or M/D/YYYY. Returns null on unrecognized format.
 * (Single source of truth — route.ts imports this.)
 */
export function normalizeIsoDate(input: string | undefined): string | null {
  if (!input) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(input);
  if (us) {
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

// Minimal structural shapes — decouples the helper from route.ts's richer types.
export interface DecisionKeyed {
  ticker?: string;
  handle_low_date?: string;
}
export interface ReconcileSetup {
  ticker: string;
  handleLowDate: string;
}
export interface IncompleteDecision {
  ticker: string;
  handle_low_date: string;
  decision: string;
  notes: string;
}

/** Key a decision/setup by TICKER|ISO-handle-low-date (uppercase ticker). */
function keyOf(ticker: string, isoHandleLow: string): string {
  return `${ticker.toUpperCase()}|${isoHandleLow}`;
}

/** The set of TICKER|date keys that DID come back with a decision. */
export function buildDecidedKeys(decisions: DecisionKeyed[]): Set<string> {
  return new Set(
    decisions.map((d) => keyOf(d.ticker ?? "", normalizeIsoDate(d.handle_low_date ?? "") ?? ""))
  );
}

/**
 * For every input setup NOT present in `decidedKeys`, produce an INCOMPLETE
 * placeholder. `truncated` only changes the human-readable note wording.
 */
export function incompleteForSetups(
  setups: ReconcileSetup[],
  decidedKeys: Set<string>,
  truncated: boolean
): IncompleteDecision[] {
  const out: IncompleteDecision[] = [];
  for (const s of setups) {
    const hld = normalizeIsoDate(s.handleLowDate);
    if (decidedKeys.has(keyOf(s.ticker, hld ?? ""))) continue;
    out.push({
      ticker: s.ticker,
      handle_low_date: hld ?? s.handleLowDate,
      decision: INCOMPLETE_DECISION,
      notes: truncated
        ? "output hit the token cap before this setup — re-run"
        : "no decision returned — re-run",
    });
  }
  return out;
}

/**
 * Run-level degrade rule. A run is DEGRADED only when it produced no client
 * markdown at all, OR at least one setup ended up INCOMPLETE (real decision loss).
 * A raw `stop_reason === "max_tokens"` that cut only trailing markdown — every
 * decision parsed — is NOT degraded. This is the fix for the false-degrade churn
 * (a run flipping DEGRADED on a ~20-token output wobble).
 */
export function isDegraded(hasMarkdown: boolean, incompleteCount: number): boolean {
  return !hasMarkdown || incompleteCount > 0;
}
