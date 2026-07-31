// =============================================================================
// JACK verdict classification — PURE (no React, no DB). Moved out of
// components/bloomberg/views/jack-decisions-table.tsx so the analytics/scorecard
// layer can classify a stored AI decision with the EXACT same rules the table
// renders with: one definition, no drift between what you saw and what the
// scorecard counts. The table imports these; behaviour is unchanged.
// =============================================================================

// JACK verdict → colour class family.
export type Verdict = "trade" | "skip" | "watch" | "fired" | "other";

export function classifyVerdict(decision: string): Verdict {
  const s = (decision || "").toUpperCase();
  if (s.includes("TRADE")) return "trade";
  if (s.includes("SKIP") || s.includes("AVOID") || s.includes("PASS")) return "skip";
  if (s.includes("WATCH")) return "watch";
  if (s.includes("FIRED") || s.includes("EXTENDED")) return "fired";
  return "other";
}

// ---- Disagreement flag (two independent sizing signals) ----------------------
// The ANALYSIS verdict (news/sector/risk context) and the HANDLE bucket (handle
// quality) answer different questions. When they point in OPPOSITE directions we
// surface a quiet flag; the user reconciles. Directional mapping is explicit so
// the flag is deterministic:
//   analysis: TRADE = positive · SIZE DOWN/REDUCE = caution · SKIP/AVOID/PASS = negative
//   handle:   FULL  = positive · HALF             = caution · SKIP            = negative
// We flag ONLY the hard positive/negative contradiction (TRADE+SKIP, SKIP+FULL).
// caution-vs-anything is a nuance, not a conflict, and would make the ⚠ noise.
export type SignalDir = "pos" | "caution" | "neg";

export function analysisDirection(decision: string | null | undefined): SignalDir | null {
  const s = (decision ?? "").toUpperCase();
  // "SIZE DOWN"/"REDUCE" is caution even when the word TRADE also appears
  // (e.g. "TRADE — SIZE DOWN 50%"), so test it first.
  if (/SIZE\s*DOWN|REDUCE|TRIM/.test(s)) return "caution";
  if (/TRADE/.test(s)) return "pos";
  if (/SKIP|AVOID|PASS/.test(s)) return "neg";
  return null; // WATCH / FIRED / INCOMPLETE / UNKNOWN — no directional stance
}

export function handleDirection(bucket: string | null | undefined): SignalDir | null {
  const b = (bucket ?? "").toLowerCase().trim();
  if (b === "full") return "pos";
  if (b === "half") return "caution";
  if (b === "skip") return "neg";
  return null;
}

export function signalsDisagree(
  decision: string | null | undefined,
  bucket: string | null | undefined
): boolean {
  const a = analysisDirection(decision);
  const h = handleDirection(bucket);
  if (a == null || h == null) return false;
  return (a === "pos" && h === "neg") || (a === "neg" && h === "pos");
}
