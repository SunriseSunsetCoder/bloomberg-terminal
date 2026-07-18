// ============================================================================
// JACK position management — the OPEN-position live re-read (Part B rules + Part C
// LLM directive). This is a DIFFERENT question from the scan validation: the scan
// asks "is this a setup worth TRADING?"; this asks "I'm HOLDING this — has the
// entry thesis broken? HOLD / EXIT / REDUCE?".
//
// Pure + deterministic. No network, no DB — the route wires Tiingo prices + the
// Claude call around these helpers. Determinism mirrors the main pipeline:
// temperature 0 + a DAY-STABLE session context, so the re-read is stable within a
// market day and legitimately moves day-to-day as price/context move.
// ============================================================================

// A generous time stop for a swing setup — the strategy's holds cluster far under
// this; 120 calendar days flags a position that has gone dead-money.
export const TIME_STOP_DAYS = 120;
// "near" thresholds for the fast rules-based marker (Part B), in percent.
export const NEAR_STOP_PCT = 3;
export const NEAR_TARGET_PCT = 3;

export type PositionInput = {
  ticker: string;
  handleLowDate: string;
  entry: number | null; // planned entry (geometry) — fallback if no user fill
  stop: number | null;
  target: number | null;
  breakout: number | null;
  jackDecisionAtMark: string | null; // frozen verdict at entry
  jackAnalysisAtMark: string | null; // frozen entry thesis (Part A)
  userEntryPrice: number | null; // actual fill
  userEntryDate: string | null;
};

// ---- Part B: fast rules-based numbers + at-a-glance flag ----

/** Unrealized return vs the actual entry fill, in percent. Null if unknown. */
export function computeUnrealizedPct(entryPrice: number | null, current: number | null): number | null {
  if (entryPrice == null || current == null || entryPrice === 0) return null;
  return ((current - entryPrice) / entryPrice) * 100;
}

/** Whole calendar days a position has been held. Null if the entry date is unusable. */
export function computeDaysHeld(entryDate: string | null, now: Date = new Date()): number | null {
  if (!entryDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(entryDate);
  if (!m) return null;
  const entry = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(entry.getTime())) return null;
  const msPerDay = 1000 * 60 * 60 * 24;
  const days = Math.floor((now.getTime() - entry.getTime()) / msPerDay);
  return days < 0 ? 0 : days;
}

export type RulesFlag = {
  label: string;
  tone: "danger" | "warn" | "good" | "neutral";
} | null;

/**
 * Quick, deterministic rules-based marker — a cheap at-a-glance signal that runs
 * without the LLM. Intentionally simple (near stop / near target / underwater /
 * past time stop); the nuanced call is the LLM re-read. Most-urgent wins.
 */
export function computeRulesFlag(args: {
  entryPrice: number | null;
  stop: number | null;
  target: number | null;
  current: number | null;
  daysHeld: number | null;
}): RulesFlag {
  const { entryPrice, stop, target, current, daysHeld } = args;

  if (current != null && stop != null) {
    if (current <= stop) return { label: "at/below stop", tone: "danger" };
    if (current <= stop * (1 + NEAR_STOP_PCT / 100)) return { label: "near stop", tone: "danger" };
  }
  if (current != null && target != null) {
    if (current >= target) return { label: "at/above target", tone: "good" };
    if (current >= target * (1 - NEAR_TARGET_PCT / 100)) return { label: "near target", tone: "good" };
  }
  if (daysHeld != null && daysHeld >= TIME_STOP_DAYS) return { label: `past ${TIME_STOP_DAYS}d time stop`, tone: "warn" };
  if (entryPrice != null && current != null && current < entryPrice) return { label: "underwater", tone: "warn" };
  return null;
}

// ---- Part C: day-stable determinism context (mirrors the scan pipeline) ----

/** Human-readable ET day, stable for the whole calendar day → deterministic prompt. */
export function positionSessionContext(now: Date = new Date()): string {
  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  }).format(now);
  return `${dateStr} ET`;
}

/** ET calendar-day key (YYYY-MM-DD) — scopes the per-day re-read cache. */
export function positionEtDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

// ---- Part C: the position-management LLM directive (news-honest) ----

export type PositionVerdict = "HOLD" | "EXIT" | "REDUCE" | "UNKNOWN";
export type ThesisStatus = "intact" | "broken-technical" | "broken-context" | "extended" | "unknown";

export interface PositionReadResult {
  ticker: string;
  handleLowDate: string;
  verdict: PositionVerdict;
  thesisStatus: ThesisStatus;
  reasoning: string;
}

/** Stable key for matching an LLM verdict back to a position. */
export function positionKey(ticker: string, handleLowDate: string): string {
  return `${ticker.toUpperCase()}|${(handleLowDate ?? "").slice(0, 10)}`;
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  return n == null ? "—" : n.toFixed(digits);
}

/** One position block for the prompt — the frozen thesis + where price is now. */
function positionBlock(p: PositionInput, current: number | null, now: Date): string {
  const entryPrice = p.userEntryPrice ?? p.entry ?? null;
  const daysHeld = computeDaysHeld(p.userEntryDate, now);
  const unreal = computeUnrealizedPct(entryPrice, current);
  const flag = computeRulesFlag({ entryPrice, stop: p.stop, target: p.target, current, daysHeld });
  return [
    `### ${p.ticker} (${p.handleLowDate})`,
    `Frozen entry thesis (immutable — why JACK entered): ${p.jackAnalysisAtMark?.trim() || "(none recorded)"}`,
    `Frozen verdict at entry: ${p.jackDecisionAtMark ?? "TRADED"}`,
    `Entry fill: ${fmtNum(entryPrice)}${p.userEntryDate ? ` on ${p.userEntryDate}` : ""} | Now (latest EOD close): ${fmtNum(current)}` +
      `${unreal != null ? ` (${unreal >= 0 ? "+" : ""}${unreal.toFixed(1)}% unrealized)` : ""} | Days held: ${daysHeld ?? "?"}/${TIME_STOP_DAYS}`,
    `Geometry: stop ${fmtNum(p.stop)} · target ${fmtNum(p.target)} · breakout ${fmtNum(p.breakout)}`,
    `Rules marker: ${flag ? flag.label : "none"}`,
  ].join("\n");
}

/**
 * Build the position-management prompt. Separate from the scan template. Emits a
 * JSON array (one object per position, SAME ORDER) — HOLD/EXIT/REDUCE, thesis
 * status, and reasoning. News-honesty is enforced in the directive: no live feed,
 * so any context read is the model's own inference and must be labeled as such —
 * it must NOT fabricate specific headlines/dates.
 */
export function buildPositionMgmtPrompt(
  positions: PositionInput[],
  currentPrices: Map<string, number | null>,
  now: Date = new Date()
): string {
  const context = positionSessionContext(now);
  const blocks = positions
    .map((p) => positionBlock(p, currentPrices.get(positionKey(p.ticker, p.handleLowDate)) ?? null, now))
    .join("\n\n");

  return `You are JACK, managing OPEN swing-trade positions (Cup-with-Handle t05 strategy).
This is POSITION MANAGEMENT, NOT setup scanning. Each position below is ALREADY HELD.
For each, decide whether the ORIGINAL entry thesis still holds and issue HOLD / EXIT / REDUCE.
Do NOT emit a trade/skip setup verdict — these are open trades, not candidates.

Session context (day-stable): ${context}

NEWS HONESTY — READ CAREFULLY:
There is NO live news feed for this pass. Do NOT invent or cite specific headlines,
dates, analyst rating actions, earnings surprises, or events you cannot verify. A
fabricated "downgrade on a date" is worse than no news read at all. Base your
assessment on: (1) price action vs the setup geometry, (2) the frozen entry thesis,
and (3) GENERAL sector/macro context you already hold. Whenever you reference context,
label it explicitly as your own inference — e.g. "no live news feed — inference from
price action and general sector context" — never as sourced news.

VERDICTS:
- HOLD   — thesis intact; price behaving with the setup; let it work.
- REDUCE — thesis partially impaired, or the move is extended / at elevated risk; cut
           size rather than fully exit.
- EXIT   — thesis BROKEN: technically (breakout failed, closed below stop or a key
           level, base/structure invalidated) OR contextually (sector/macro clearly
           turned against it). This is where a failed-breakout "get out" call belongs.

thesis_status ∈ { "intact", "broken-technical", "broken-context", "extended" }.

POSITIONS:
${blocks}

OUTPUT — a SINGLE \`\`\`json fenced block and nothing else: a JSON ARRAY with one
object per position, in the SAME ORDER as above. Each object:
{
  "ticker": "...",
  "handle_low_date": "YYYY-MM-DD",
  "verdict": "HOLD" | "EXIT" | "REDUCE",
  "thesis_status": "intact" | "broken-technical" | "broken-context" | "extended",
  "reasoning": "2-4 sentences: what the price action says vs the frozen thesis, and any context read CLEARLY LABELED as inference (not sourced news)."
}
No prose outside the JSON block.`;
}

/**
 * Parse the position-management JSON array from the model response. Tolerant:
 * accepts a fenced ```json array or a bare array; normalizes verdict/status. Rows
 * that can't be identified (no ticker) are dropped. Never throws.
 */
export function parsePositionReads(text: string): PositionReadResult[] {
  let jsonStr: string | null = null;
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (fence) {
    jsonStr = fence[1].trim();
  } else {
    const arr = /\[[\s\S]*\]/.exec(text);
    if (arr) jsonStr = arr[0];
  }
  if (!jsonStr) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const normVerdict = (v: unknown): PositionVerdict => {
    const s = String(v ?? "").toUpperCase();
    if (s.includes("EXIT")) return "EXIT";
    if (s.includes("REDUCE")) return "REDUCE";
    if (s.includes("HOLD")) return "HOLD";
    return "UNKNOWN";
  };
  const normStatus = (v: unknown): ThesisStatus => {
    const s = String(v ?? "").toLowerCase();
    if (s.includes("broken-tech") || s.includes("technical")) return "broken-technical";
    if (s.includes("broken-con") || s.includes("context")) return "broken-context";
    if (s.includes("extended")) return "extended";
    if (s.includes("intact")) return "intact";
    return "unknown";
  };

  const out: PositionReadResult[] = [];
  for (const row of parsed as Array<Record<string, unknown>>) {
    const ticker = String(row.ticker ?? "").toUpperCase();
    if (!ticker) continue;
    out.push({
      ticker,
      handleLowDate: String(row.handle_low_date ?? "").slice(0, 10),
      verdict: normVerdict(row.verdict),
      thesisStatus: normStatus(row.thesis_status),
      reasoning: typeof row.reasoning === "string" ? row.reasoning : "",
    });
  }
  return out;
}
