"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Save, ChevronRight, AlertTriangle } from "lucide-react";
import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";
import { CandleThumbnail } from "@/components/bloomberg/ui/candle-thumbnail";
import { CandleChartModal } from "@/components/bloomberg/ui/candle-chart-modal";
import { classifyVerdict, signalsDisagree } from "@/lib/jack/verdict";
import { computeSectionRanks, dbSectionOf, rankKey, sortByRank } from "@/lib/jack/combine-decisions";
import { checkFills } from "@/lib/jack/fill-guard";

// ============================================================================
// JACK decision surface (UI v2). ONE expandable row per setup, in two preserved
// groups (LIVE / PENDING). Replaces the old interactive table + wide markdown
// tables. Progressive disclosure — collapsed by default, expand on click — so
// nothing is a wide table and there's no horizontal scroll / char-wrap.
//
// SOURCE OF TRUTH for user writes. Binds to the parsed JSON decisions block
// (props.decisions), NOT scraped markdown:
//   - Action TRADED/PASSED/WATCHED → decisions.user_action (upsert per setup)
//   - Fills (entry/exit price + dates, only on TRADED) → outcomes user-fill cols
// React state only — NO localStorage/sessionStorage. On Vercel
// (persistenceAvailable=false) rows render but writes are disabled.
// ============================================================================

type UserAction = "TRADED" | "PASSED" | "WATCHED";
type SaveState = "idle" | "saving" | "saved" | "error";

interface RowState {
  userAction: UserAction | null;
  entry: string;
  entryDate: string;
  exit: string;
  exitDate: string;
  actionSave: SaveState;
  fillsSave: SaveState;
  serverUserR: number | null;
  error?: string;
  // UNSAVED local edit present. Re-seeds from the server (the 180s open-position
  // poll, a window-focus refetch, the mount re-hydration) must NOT clobber it —
  // see mergeSeeded. This is what made an owned position's fill uncorrectable.
  dirty?: boolean;
  // Fill-sanity warning awaiting confirmation ("check the decimal"). While set, the
  // save button is an explicit "Save anyway"; a second click writes.
  guardWarning?: string | null;
}

// Keep only digits and a single decimal point so the field stays a valid price
// while allowing normal keyboard entry (type=number mangles partial decimals).
export function sanitizePrice(v: string): string {
  let s = v.replace(/[^0-9.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  return s;
}

interface JackDecisionsTableProps {
  decisions: JackDecisionClient[];
  isDarkMode: boolean;
  persistenceAvailable: boolean;
  // Individual position notional cap (riskPerTrade × 100) from the JACK header,
  // for the expanded-row notional fill-bar. Presentation only.
  individualCap?: number;
  // Fired on a successful "Save fills" that recorded an EXIT — lets the parent
  // patch the in-memory decision so the now-closed setup re-routes out of CURRENT
  // POSITIONS immediately (no re-VALIDATE). See combineJackDecisions.
  onExitSaved?: (setupId: number, exitPrice: number, exitDate: string | null) => void;
}

function rowKey(d: JackDecisionClient, i: number): string {
  return d.decisionId != null
    ? `d${d.decisionId}`
    : `${d.ticker}|${d.handleLowDate}|${d.section}|${i}`;
}

async function postDecision(body: unknown): Promise<{ ok: boolean; userRRealized?: number | null; error?: string }> {
  const res = await fetch("/api/jack-decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; userRRealized?: number | null; error?: string };
}

function defaultRow(): RowState {
  return {
    userAction: null,
    entry: "",
    entryDate: "",
    exit: "",
    exitDate: "",
    actionSave: "idle",
    fillsSave: "idle",
    serverUserR: null,
  };
}

// Seed row state from existing marks/fills the route attached to each decision,
// so a re-VALIDATE re-displays what the user previously recorded (Bug A).
export function seedRows(decisions: JackDecisionClient[]): Record<string, RowState> {
  const out: Record<string, RowState> = {};
  decisions.forEach((d, i) => {
    const hasFill =
      d.userEntryPrice != null || d.userEntryDate != null || d.userExitPrice != null || d.userExitDate != null;
    if (d.userAction == null && !hasFill) return;
    out[rowKey(d, i)] = {
      ...defaultRow(),
      userAction: d.userAction ?? null,
      entry: d.userEntryPrice != null ? String(d.userEntryPrice) : "",
      entryDate: d.userEntryDate ?? "",
      exit: d.userExitPrice != null ? String(d.userExitPrice) : "",
      exitDate: d.userExitDate ?? "",
      actionSave: d.userAction != null ? "saved" : "idle",
      fillsSave: hasFill ? "saved" : "idle",
    };
  });
  return out;
}

// Re-seed WITHOUT destroying in-progress edits.
//
// THE OWNED-POSITION EDIT BUG: the open-position query refetches every 180s and on
// window focus, which hands this table a new `decisions` array; both re-seed effects
// then replaced row state wholesale. An owned position is the ONLY kind of row on that
// poll, so correcting its logged entry fill was a race the user could not win — tab
// away to check the real fill, tab back, and the field had snapped to the stored (bad)
// value; saving then re-wrote the bad value.
//
// Rule: a row with unsaved edits (dirty) keeps its local state; every other row takes
// the fresh server seed. Dirty rows the new seed no longer knows about are kept too,
// so a row mid-edit can never disappear. PURE + exported for the self-test.
export function mergeSeeded(
  prev: Record<string, RowState>,
  next: Record<string, RowState>
): Record<string, RowState> {
  const out: Record<string, RowState> = { ...next };
  for (const [key, row] of Object.entries(prev)) {
    if (row.dirty) out[key] = row;
  }
  return out;
}

interface MarkDto {
  userAction: UserAction | null;
  userEntryPrice: number | null;
  userEntryDate: string | null;
  userExitPrice: number | null;
  userExitDate: string | null;
  jackDecisionAtMark: string | null;
  sharesAtMark: number | null;
}

// Overlay freshly-fetched DB marks onto the (possibly stale) decisions so seedRows
// re-displays the latest saved action + fills. DB is source of truth on mount.
// `decision`/`shares` stay LIVE (current re-assessment); the *AtMark fields carry
// the frozen decision-time snapshot.
export function overlayMarks(decisions: JackDecisionClient[], marks: Record<string, MarkDto>): JackDecisionClient[] {
  return decisions.map((d) => {
    const m = d.setupId != null ? marks[String(d.setupId)] : undefined;
    if (!m) return d;
    return {
      ...d,
      userAction: m.userAction ?? null,
      userEntryPrice: m.userEntryPrice ?? null,
      userEntryDate: m.userEntryDate ?? null,
      userExitPrice: m.userExitPrice ?? null,
      userExitDate: m.userExitDate ?? null,
      jackDecisionAtMark: m.jackDecisionAtMark ?? null,
      sharesAtMark: m.sharesAtMark ?? null,
    };
  });
}

// Reward:risk multiple from the setup geometry (theoretical, NOT user R).
function rewardRisk(d: JackDecisionClient): number | null {
  if (d.entry == null || d.stop == null || d.target == null || d.entry === d.stop) return null;
  return (d.target - d.entry) / (d.entry - d.stop);
}

// SETUP GEOMETRY + LEVELS/RISK for the expand — PURE + exported for the self-test.
// Builds the exact text tokens the row renders: the cup/handle shape, per-level
// %-distances, R:R, and $-risk / $-reward. $ figures use the DEPLOYABLE size
// (recShares) but fall back to full-risk shares when recShares is 0/nullish (SKIP)
// so they're never blank or $0. Each token appears only when its inputs exist.
export type SetupContextTone = "stop" | "target" | "now" | "accent" | "muted";
export function computeSetupContext(d: {
  cupDepthPct?: number | null;
  handleRetrPct?: number | null;
  daysSinceHandleLow?: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  currentPrice: number | null;
  recShares?: number | null;
  fullShares?: number | null;
}): { geometry: string[]; levels: { text: string; tone: SetupContextTone }[] } {
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

  const geometry: string[] = [];
  if (d.cupDepthPct != null) geometry.push(`cup depth ${d.cupDepthPct.toFixed(1)}%`);
  if (d.handleRetrPct != null) geometry.push(`handle retrace ${d.handleRetrPct.toFixed(1)}%`);
  if (d.daysSinceHandleLow != null) geometry.push(`${d.daysSinceHandleLow}d since handle low`);

  const e = d.entry;
  const s = d.stop;
  const t = d.target;
  // Deployable size, with the SKIP fallback (recShares 0/nullish → full-risk shares).
  const shares = d.recShares != null && d.recShares > 0 ? d.recShares : d.fullShares ?? null;
  const levels: { text: string; tone: SetupContextTone }[] = [];
  if (e != null && s != null && e !== 0) levels.push({ text: `to stop ${pct(((s - e) / e) * 100)}`, tone: "stop" });
  if (e != null && t != null && e !== 0) levels.push({ text: `to target ${pct(((t - e) / e) * 100)}`, tone: "target" });
  if (e != null && d.currentPrice != null && e !== 0)
    levels.push({ text: `now ${pct(((d.currentPrice - e) / e) * 100)} from entry`, tone: "now" });
  if (e != null && s != null && t != null && e !== s) levels.push({ text: `R:R ${((t - e) / (e - s)).toFixed(1)}`, tone: "accent" });
  if (shares != null && e != null && s != null) levels.push({ text: `risk ${usd0(shares * (e - s))}`, tone: "muted" });
  if (shares != null && e != null && t != null) levels.push({ text: `reward ${usd0(shares * (t - e))}`, tone: "muted" });

  return { geometry, levels };
}

// classifyVerdict / analysisDirection / handleDirection / signalsDisagree now live
// in @/lib/jack/verdict (imported at the top of this file) so the scorecard can
// classify stored decisions with the identical rules. Behaviour unchanged.

// The MAIN "Shares" number (handoff decision 3): tied to the HANDLE BUCKET, not the
// LLM's verdict-driven count. Marked rows keep their frozen mark-time size. Unmarked:
// FULL → full-risk · HALF → ×0.5 (both via recShares) · SKIP → the would-be number
// STRUCK (vetoed). The SKIP veto fires on a SKIP analysis verdict OR a skip bucket;
// it shows recShares, or full-risk (fullShares) when the bucket itself is skip and
// recShares is null — never a bare 0. Pure + exported for the self-test.
export function mainSharesForRow(d: {
  userAction: "TRADED" | "PASSED" | "WATCHED" | null;
  decision: string;
  sizeBucket?: "full" | "half" | "skip" | null;
  sharesAtMark: number | null;
  recShares?: number | null;
  fullShares?: number | null;
}): { shares: number | null; vetoed: boolean } {
  const marked = d.userAction != null;
  const vetoed = !marked && (classifyVerdict(d.decision) === "skip" || d.sizeBucket === "skip");
  const shares = marked
    ? d.sharesAtMark
    : vetoed
      ? d.recShares ?? d.fullShares ?? null
      : d.recShares ?? null;
  return { shares, vetoed };
}

export function JackDecisionsTable({ decisions, isDarkMode, persistenceAvailable, individualCap, onExitSaved }: JackDecisionsTableProps) {
  const [rows, setRows] = useState<Record<string, RowState>>(() => seedRows(decisions));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({}); // all collapsed by default
  // The setup whose candle chart is open (one modal, one chart instance at a time).
  const [chartFor, setChartFor] = useState<JackDecisionClient | null>(null);

  useEffect(() => {
    // Merge, never replace — the open-position poll re-fires this every 180s.
    setRows((prev) => mergeSeeded(prev, seedRows(decisions)));
  }, [decisions]);

  // Re-hydration on mount / return-to-JACK: saving fills writes the DB but NOT the
  // cached validation response, so navigating away and back (without re-VALIDATE)
  // would show stale/blank rows. Fetch the latest marks + fills and overlay them.
  useEffect(() => {
    if (!persistenceAvailable) return;
    const setupIds = Array.from(new Set(decisions.map((d) => d.setupId).filter((x): x is number => x != null)));
    if (setupIds.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/jack-decisions?setupIds=${setupIds.join(",")}`);
        // marks/fills only — the FIRE flags are polled by useJackFiredFlags in
        // jack-view and arrive on props, so combineJackDecisions can re-section on them.
        const json = (await res.json()) as { marks?: Record<string, MarkDto> };
        const marks = json.marks;
        if (cancelled || !marks) return;
        setRows((prev) => mergeSeeded(prev, seedRows(overlayMarks(decisions, marks))));
      } catch {
        // Non-fatal — the props-based seed still stands.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [decisions, persistenceAvailable]);

  const getRow = (key: string): RowState => rows[key] ?? defaultRow();

  // Merge onto the LATEST state (prev), not the render-snapshot `rows` closure —
  // so two patches in one handler don't clobber each other.
  const patch = (key: string, next: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [key]: { ...(prev[key] ?? defaultRow()), ...next } }));

  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  // ---- theme tokens (Bloomberg language: mono, orange accents, dark tokens) ----
  const subFg = isDarkMode ? "text-gray-400" : "text-gray-600";
  const fg = isDarkMode ? "text-orange-400" : "text-orange-700";
  const textFg = isDarkMode ? "text-orange-200" : "text-gray-800";
  const border = isDarkMode ? "border-orange-900/60" : "border-orange-200";
  const rowBg = isDarkMode ? "bg-gray-950/40" : "bg-gray-50";
  const rowHover = isDarkMode ? "hover:bg-gray-900/50" : "hover:bg-gray-100";
  const openBg = isDarkMode ? "bg-gray-950/70" : "bg-white";
  const inputBg = isDarkMode ? "bg-gray-950" : "bg-gray-50";
  const inputBorder = isDarkMode ? "border-gray-800" : "border-gray-300";
  const inputFg = isDarkMode ? "text-orange-300" : "text-gray-900";
  const track = isDarkMode ? "bg-gray-700" : "bg-gray-300";

  // ---- action write (T/P/W) → decisions.user_action (upsert per setup, server-side) ----
  const handleAction = async (d: JackDecisionClient, key: string, action: UserAction) => {
    patch(key, { userAction: action, error: undefined });
    if (!persistenceAvailable || d.decisionId == null) return; // Vercel / unpersisted — local only
    patch(key, { actionSave: "saving" });
    try {
      const r = await postDecision({ type: "user_action", decisionId: d.decisionId, action });
      patch(key, r.ok ? { actionSave: "saved" } : { actionSave: "error", error: r.error });
    } catch (e) {
      patch(key, { actionSave: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };

  // ---- fill write → outcomes user-fill columns (reuses updateUserFills unchanged) ----
  const handleSaveFills = async (d: JackDecisionClient, key: string) => {
    const row = getRow(key);
    const entry = row.entry === "" ? null : Number(row.entry);
    const entryDate = row.entryDate === "" ? null : row.entryDate;
    const exit = row.exit === "" ? null : Number(row.exit);
    const exitDate = row.exitDate === "" ? null : row.exitDate;
    if (!persistenceAvailable) {
      patch(key, { fillsSave: "error", error: "persistence disabled (Vercel) — no writes here" });
      return;
    }
    if (d.setupId == null) {
      patch(key, { fillsSave: "error", error: "no DB id for this setup — re-run VALIDATE first" });
      return;
    }
    // DECIMAL GUARD — a fill far from the setup's own geometry (or implying an
    // impossible same-day move) is a typo until the trader says otherwise. First
    // click warns; the button becomes "Save anyway" and a second click writes.
    if (row.guardWarning == null) {
      const verdict = checkFills({ entry, exit }, d);
      if (!verdict.ok) {
        patch(key, { fillsSave: "idle", error: undefined, guardWarning: verdict.reason });
        return;
      }
    }
    patch(key, { fillsSave: "saving", error: undefined });
    try {
      const r = await postDecision({ type: "user_fills", setupId: d.setupId, entry, entryDate, exit, exitDate });
      patch(
        key,
        r.ok
          ? { fillsSave: "saved", serverUserR: r.userRRealized ?? null, dirty: false, guardWarning: null }
          : { fillsSave: "error", error: r.error }
      );
      // Recorded an EXIT → the setup is now closed. Tell the parent so it re-routes
      // out of CURRENT POSITIONS immediately (patches the in-memory decision's exit).
      if (r.ok && exit != null && d.setupId != null) onExitSaved?.(d.setupId, exit, exitDate);
    } catch (e) {
      patch(key, { fillsSave: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };

  // Live client-side preview of user_R = (exit - entry) / (entry - stop).
  const previewR = (d: JackDecisionClient, row: RowState): number | null => {
    const entry = Number(row.entry);
    const exit = Number(row.exit);
    if (!row.entry || !row.exit || d.stop == null || !Number.isFinite(entry) || !Number.isFinite(exit)) return null;
    if (entry === d.stop) return null;
    return (exit - entry) / (entry - d.stop);
  };

  // Ordinal priority rank shown as "P1", "P2", … — TWO INDEPENDENT sequences, each
  // numbered from P1 and each computed over the DB section (dbSection ?? section),
  // i.e. BEFORE any display re-sectioning:
  //   · LIVE ranks    — this run's live rows
  //   · PENDING ranks — this run's pending rows, ranked among themselves ("as if it
  //                     breaks")
  // A pending setup that FIRES renders in the LIVE group but keeps its PENDING rank
  // and never joins the live population — so a fire cannot renumber the live ranks.
  // The blend (priority DESC → bucket → handle_score) lives in computePriorityRanks.
  const sectionRanks = useMemo(() => computeSectionRanks(decisions), [decisions]);
  const openDecisions = useMemo(() => decisions.filter((d) => d.section === "open"), [decisions]);
  const liveDecisions = useMemo(() => decisions.filter((d) => d.section === "live"), [decisions]);
  // PENDING renders in ITS OWN P-rank order: P1 first, unranked (no scanner priority)
  // last, stable within ties — sorted by the SAME map that renders the chips, so the
  // list and the chips can never disagree. LIVE order is untouched: it keeps the
  // buildClientDecisions ordering, and a fired pending row that re-sections into the
  // live group stays after the native live rows rather than reshuffling them.
  const pendingDecisions = useMemo(
    () => sortByRank(decisions.filter((d) => d.section === "pending"), sectionRanks.pending),
    [decisions, sectionRanks]
  );


  if (decisions.length === 0) return null;

  // ================= small presentational helpers =================

  // muted=true → de-emphasized outline pill (used for JACK's FROZEN verdict on a
  // marked row, so the user's action badge dominates instead of JACK's call).
  const verdictPill = (decision: string, muted = false) => {
    const v = classifyVerdict(decision);
    if (muted) {
      return (
        <span
          className={`px-1 py-0.5 rounded text-[9px] font-semibold tracking-wide border whitespace-nowrap shrink-0 ${
            isDarkMode ? "border-gray-700 text-gray-500" : "border-gray-300 text-gray-500"
          }`}
          title="JACK's verdict when you marked this setup"
        >
          {decision}
        </span>
      );
    }
    // Filled pills with black/white text — high contrast in BOTH themes (the
    // previous /20 tints on colored text were unreadable in light mode).
    const cls = isDarkMode
      ? v === "trade"
        ? "bg-green-600 text-black border-green-400"
        : v === "skip"
          ? "bg-red-600 text-white border-red-400"
          : v === "watch"
            ? "bg-amber-500 text-black border-amber-300"
            : "bg-gray-500 text-white border-gray-300"
      : v === "trade"
        ? "bg-green-700 text-white border-green-800"
        : v === "skip"
          ? "bg-red-700 text-white border-red-800"
          : v === "watch"
            ? "bg-amber-400 text-black border-amber-600"
            : "bg-gray-600 text-white border-gray-700";
    return (
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide border ${cls} whitespace-nowrap shrink-0`}>
        {decision}
      </span>
    );
  };

  const rMultipleChip = (rr: number | null) => {
    if (rr == null) return <span className={`text-[11px] ${subFg} shrink-0`}>R/R —</span>;
    // Sub-1.0 R/R is a bad setup — alarming red pill (theme-aware; the previous
    // red-300 on /30 tint was illegible in light mode).
    if (rr < 1) {
      const alarm = isDarkMode
        ? "text-red-100 bg-red-700/60 border-red-500"
        : "text-white bg-red-700 border-red-800";
      return (
        <span className={`text-[10px] font-bold border rounded px-1.5 py-0.5 whitespace-nowrap shrink-0 ${alarm}`}>
          ⚠ R/R {rr.toFixed(2)}
        </span>
      );
    }
    const color = rr >= 1.5 ? (isDarkMode ? "text-green-400" : "text-green-700") : isDarkMode ? "text-amber-400" : "text-amber-600";
    return (
      <span className={`text-[11px] font-bold ${color} whitespace-nowrap shrink-0`}>R/R {rr.toFixed(2)}</span>
    );
  };

  // ---- handle_score sizing directive (recommendation — the user decides) ----
  const fmtUsd0 = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  // STRUCTURED handle-score pill — read from the ingested size_bucket + handle_score
  // columns (NOT LLM prose). Renders on EVERY scored row. Format "handle score:
  // FULL · 0.72": bucket in caps for the action, 2-decimal score for the nuance.
  // Weight encodes the directive — FULL emphasized (filled), HALF neutral (outline),
  // SKIP de-emphasized (muted outline) — but SKIP stays fully legible (a low score
  // is information; borderline ones like 0.452 just under the 0.456 line get an eye).
  const bucketPill = (d: JackDecisionClient) => {
    const bucket = d.sizeBucket ?? null;
    if (bucket == null && d.handleScore == null) return null;
    const label = bucket ? bucket.toUpperCase() : "—";
    const score = d.handleScore != null ? d.handleScore.toFixed(2) : "—";
    const cls = isDarkMode
      ? bucket === "full"
        ? "bg-green-600 text-black border-green-400 font-bold"
        : bucket === "half"
          ? "bg-transparent text-amber-300 border-amber-500/70 font-semibold"
          : "bg-transparent text-gray-500 border-gray-700 font-medium"
      : bucket === "full"
        ? "bg-green-700 text-white border-green-800 font-bold"
        : bucket === "half"
          ? "bg-transparent text-amber-700 border-amber-500 font-semibold"
          : "bg-transparent text-gray-500 border-gray-400 font-medium";
    return (
      <span
        className={`px-1.5 py-0.5 rounded text-[10px] tracking-wide border whitespace-nowrap shrink-0 ${cls}`}
        title="Handle-quality sizing from the scanner's handle_score — a SEPARATE signal from the analysis verdict. Recommendation; you reconcile + size."
      >
        <span className="opacity-60 font-normal">handle score:</span> {label} · {score}
      </span>
    );
  };

  // Scanner classification tags — shown on the COLLAPSED row (always visible, so no
  // setup reads "no sector") right beside the handle-score pill. Each degrades to
  // nothing when the scanner omitted that column.
  //  · tier   — handle quintile Q3/Q4/Q5. The KEY tell: Q3/Q4/Q5 all size FULL now,
  //             so without the tier the score is the only way to decode the quintile.
  //  · sector — GICS sector name (Financials / Industrials / Unknown).
  //  · P{n}   — LIVE priority RANK (P1 = best pick this week); ordinal derived from
  //             the priority-desc sort. The float itself stays the sort/persist key.
  const tierLabel = (d: JackDecisionClient) =>
    d.tier ? (
      <span
        className={`text-[10px] px-1 py-0.5 rounded border ${border} ${subFg} whitespace-nowrap shrink-0`}
        title="Handle quintile from the scanner (Q3/Q4/Q5). Q3/Q4/Q5 all size FULL, so the tier is the only quintile tell."
      >
        {d.tier}
      </span>
    ) : null;
  const sectorLabel = (d: JackDecisionClient) =>
    d.sector ? (
      <span
        className={`text-[10px] px-1 py-0.5 rounded border ${border} ${subFg} whitespace-nowrap shrink-0`}
        title="GICS sector from the scanner."
      >
        {d.sector}
      </span>
    ) : null;
  // Close-confirmed FIRE badge. The flag arrives on the decision row (polled by
  // useJackFiredFlags in jack-view, which also feeds combineJackDecisions' display
  // re-section) — a 'confirmed'/'late' row is rendered under LIVE, a 'resolved' one
  // stays where it is and gets the muted tag.
  const firedBadge = (d: JackDecisionClient) => {
    if (!d.firedStatus || !d.firedAt) return null;
    const detail = [
      d.fireClose != null ? `close ${d.fireClose.toFixed(2)}` : null,
      d.fireBar != null ? `bar ${d.fireBar}/15` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    if (d.firedStatus === "resolved") {
      return (
        <span
          className={`text-[10px] px-1 py-0.5 rounded border ${border} ${subFg} whitespace-nowrap shrink-0`}
          title={`Close-confirmed fire on ${d.firedAt}, and the trade has already hit its stop or target — not actionable, so it stays out of the LIVE group.${detail ? ` (${detail})` : ""}`}
        >
          fired · resolved
        </span>
      );
    }

    const late = d.firedStatus === "late";
    return (
      <span className="inline-flex items-center gap-1 shrink-0">
        <span
          className={`text-[10px] px-1 py-0.5 rounded border font-bold whitespace-nowrap ${
            late ? "border-amber-600 text-amber-400" : "border-green-600 text-green-400"
          }`}
          title={
            late
              ? `Close-confirmed fire on ${d.firedAt} — earlier than today, so entering now is off-parity vs the backtest fill.`
              : "Close confirmed above the rim. The backtest fill is the NEXT session's open."
          }
        >
          {late ? `🔥 FIRED ${d.firedAt}` : "🔥 FIRED · buy next open"}
        </span>
        {detail && <span className={`text-[10px] ${subFg} whitespace-nowrap`}>{detail}</span>}
      </span>
    );
  };

  // "exited" marker — a TRADED setup with a recorded exit that is firing AGAIN this
  // week (so it routes to LIVE, not CURRENT POSITIONS). Distinguishes it from a
  // never-traded candidate; it deliberately carries NO P-rank (re-entry is a choice).
  const exitedLabel = (d: JackDecisionClient) =>
    d.userAction === "TRADED" && d.userExitPrice != null ? (
      <span
        className={`text-[10px] px-1 py-0.5 rounded border whitespace-nowrap shrink-0 ${
          isDarkMode ? "border-sky-800 text-sky-300" : "border-sky-300 text-sky-700"
        }`}
        title="Closed — you recorded an exit on this setup. It's back in LIVE because it's firing again; re-entry is a deliberate choice, so it gets no P-rank."
      >
        exited
      </span>
    ) : null;
  const priorityLabel = (d: JackDecisionClient) =>
    (() => {
      const from = dbSectionOf(d);
      if (from === "open") return null;
      const rank = (from === "live" ? sectionRanks.live : sectionRanks.pending).get(rankKey(d));
      if (rank == null) return null;
      const pendingRank = from === "pending";
      return (
        <span
          className={`text-[10px] ${subFg} whitespace-nowrap shrink-0`}
          title={
            pendingRank
              ? "PENDING priority rank — 1 is the best of this week's pending setups, ranked among themselves as if it breaks. Independent of the LIVE ranks; a fired setup keeps this number."
              : "LIVE priority rank — 1 is the highest-priority (best) live setup this week. Independent of the PENDING ranks."
          }
        >
          {`P${rank}`}
        </span>
      );
    })();

  // Quiet disagreement cue — the analysis verdict and the handle bucket point in
  // HARD-OPPOSITE directions (TRADE+SKIP or SKIP+FULL). Visual only; changes no data.
  const disagreeFlag = (analysisVerdict: string | null, d: JackDecisionClient) => {
    if (!signalsDisagree(analysisVerdict, d.sizeBucket)) return null;
    return (
      <span
        className="inline-flex items-center gap-0.5 text-[9px] text-amber-500/80 whitespace-nowrap shrink-0"
        title={`Signals disagree — analysis says ${analysisVerdict}, handle says ${(d.sizeBucket ?? "").toUpperCase()}. Reconcile before sizing.`}
      >
        <AlertTriangle size={9} /> signals disagree
      </span>
    );
  };

  // Expanded sizing — the existing FULL-RISK share count (risk/trade ÷ stop
  // distance) shown ALONGSIDE the handle-recommended size:
  //   FULL → handle-recommended = full-risk shares (same)
  //   HALF → full-risk × 0.5
  //   SKIP → shares shown but greyed + "handle SKIP" (override possible, discouraged)
  // Display, not auto-applied — the user still makes the sizing call.
  const sizingBlock = (d: JackDecisionClient) => {
    if (d.sizeBucket == null && d.handleScore == null) return null;
    const bucket = d.sizeBucket ?? null;
    const fullRiskTxt =
      d.fullShares != null && d.fullNotional != null
        ? `full-risk ${d.fullShares.toLocaleString()} sh / ${fmtUsd0(d.fullNotional)}`
        : "full-risk — (missing entry/stop)";
    // handle-recommended: rec for full/half; for skip show full-risk shares greyed.
    const handle =
      bucket === "full"
        ? { text: `handle FULL → ${d.recShares?.toLocaleString() ?? "—"} sh`, muted: false }
        : bucket === "half"
          ? { text: `handle HALF → ${d.recShares?.toLocaleString() ?? "—"} sh`, muted: false }
          : bucket === "skip"
            ? { text: `handle SKIP → ${d.fullShares?.toLocaleString() ?? "—"} sh (discouraged)`, muted: true }
            : { text: "handle —", muted: true };
    return (
      <div className={`rounded border ${border} px-2.5 py-1.5 ${isDarkMode ? "bg-gray-950/60" : "bg-white"}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`text-[9px] uppercase tracking-widest ${subFg}`}>handle_score sizing</span>
          {bucketPill(d)}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 mt-1 text-[11px]">
          <span className={fg + " font-bold"}>{fullRiskTxt}</span>
          <span className="opacity-50">·</span>
          <span className={handle.muted ? `${subFg} line-through decoration-1` : "text-green-400 font-bold"}>
            {handle.text}
          </span>
        </div>
        <div className={`text-[9px] ${subFg} mt-1 italic`}>
          Recommendation from the validated handle-score edge — you decide and size. Full-risk shares = risk/trade ÷ (entry − stop).
        </div>
      </div>
    );
  };

  // SETUP GEOMETRY + LEVELS/RISK — renders the pure computeSetupContext tokens
  // (cup/handle shape · %-distances · R:R · $-risk/$-reward). Maps each token's
  // tone to a theme class; text/values are computed by the exported pure fn.
  const setupContext = (d: JackDecisionClient) => {
    const { geometry, levels } = computeSetupContext(d);
    if (geometry.length === 0 && levels.length === 0) return null;
    const toneCls: Record<SetupContextTone, string> = {
      stop: "text-red-400",
      target: "text-green-400",
      now: "text-sky-400",
      accent: fg,
      muted: subFg,
    };
    return (
      <div className="space-y-1">
        {geometry.length > 0 && (
          <div>
            <div className={`text-[9px] uppercase tracking-widest ${subFg} mb-0.5`}>Setup geometry</div>
            <div className={`text-[11px] ${textFg}`}>{geometry.join(" · ")}</div>
          </div>
        )}
        {levels.length > 0 && (
          <div>
            <div className={`text-[9px] uppercase tracking-widest ${subFg} mb-0.5`}>Levels / risk</div>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
              {levels.map((p, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  {i > 0 && <span className="opacity-40">·</span>}
                  <span className={toneCls[p.tone]}>{p.text}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const actionBadge = (action: UserAction | null) => {
    if (action === "TRADED") return <span className="text-[10px] font-bold text-green-400">✓ TRADED</span>;
    if (action === "PASSED") return <span className="text-[10px] font-bold text-gray-300">✓ PASSED</span>;
    if (action === "WATCHED") return <span className="text-[10px] font-bold text-sky-400">✓ WATCHED</span>;
    return <span className={`text-[10px] ${subFg}`}>unmarked</span>;
  };

  const priceLadder = (d: JackDecisionClient) => {
    type LadderPt = { label: string; v: number | null; dot: string; text: string };
    const raw: LadderPt[] = [
      { label: "STOP", v: d.stop, dot: "bg-red-500", text: "text-red-400" },
      { label: "ENTRY", v: d.entry, dot: "bg-orange-500", text: "text-orange-400" },
      { label: "NOW", v: d.currentPrice, dot: "bg-sky-400", text: "text-sky-400" },
      { label: "TGT", v: d.target, dot: "bg-green-500", text: "text-green-400" },
    ];
    const pts = raw.filter((p): p is { label: string; v: number; dot: string; text: string } => p.v != null);
    if (pts.length < 2) return null;
    const vals = pts.map((p) => p.v);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pct = (v: number) => (hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100);
    return (
      <div>
        <div className={`text-[9px] uppercase tracking-widest ${subFg} mb-1`}>Price ladder</div>
        <div className="relative h-4">
          <div className={`absolute top-1/2 left-1 right-1 h-px ${track}`} />
          {pts.map((p) => (
            <div
              key={p.label}
              className="absolute -translate-x-1/2 top-1/2 -translate-y-1/2"
              style={{ left: `${pct(p.v)}%` }}
            >
              <div className={`w-2 h-2 rounded-full ${p.dot} ring-2 ${isDarkMode ? "ring-gray-950" : "ring-white"}`} />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
          {pts.map((p) => (
            <span key={p.label} className={`text-[10px] ${p.text}`}>
              <b>{p.label}</b> {p.v.toFixed(2)}
            </span>
          ))}
        </div>
      </div>
    );
  };

  const chip = (label: string, val: string | null | undefined) =>
    val ? (
      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${border} ${subFg}`}>
        <span className={fg}>{label}</span> {val}
      </span>
    ) : null;

  const renderSaveButton = (d: JackDecisionClient, key: string, state: SaveState, guarded = false) => {
    const base =
      "flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-bold border transition-colors disabled:opacity-50";
    const cls = guarded
      ? "border-red-500 text-red-200 bg-red-800/60 hover:bg-red-700/70"
      : state === "saved"
        ? "border-green-600 text-green-400 bg-green-950/30"
        : state === "error"
          ? "border-red-600 text-red-400 bg-red-950/30 hover:bg-red-950/50"
          : "bg-orange-600 border-orange-500 text-black hover:bg-orange-500";
    return (
      <button type="button" onClick={() => handleSaveFills(d, key)} disabled={state === "saving"} className={`${base} ${cls}`}>
        {state === "saving" ? (
          <><Loader2 size={12} className="animate-spin" /> Saving…</>
        ) : guarded ? (
          <><AlertTriangle size={12} /> Save anyway</>
        ) : state === "saved" ? (
          <><Check size={12} /> Saved</>
        ) : state === "error" ? (
          <><Save size={12} /> Retry</>
        ) : (
          <><Save size={12} /> Save fills</>
        )}
      </button>
    );
  };

  const actionButton = (d: JackDecisionClient, key: string, action: UserAction, active: boolean) => {
    const on =
      action === "TRADED"
        ? "bg-green-600 border-green-500 text-black"
        : action === "PASSED"
          ? "bg-gray-600 border-gray-500 text-white"
          : "bg-sky-600 border-sky-500 text-white";
    const off = isDarkMode
      ? "bg-transparent border-gray-700 text-gray-400 hover:border-gray-500"
      : "bg-transparent border-gray-300 text-gray-600 hover:border-gray-500";
    return (
      <button
        type="button"
        onClick={() => handleAction(d, key, action)}
        className={`px-2.5 py-1 rounded text-[11px] font-bold border transition-colors ${active ? on : off}`}
      >
        {action}
      </button>
    );
  };

  const stopKeys = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const priceCls = `w-20 px-1 py-0.5 rounded ${inputBg} border ${inputBorder} ${inputFg} text-[11px] focus:outline-none focus:border-orange-500`;
  const dateCls = `w-32 px-1 py-0.5 rounded ${inputBg} border ${inputBorder} ${inputFg} text-[11px] focus:outline-none focus:border-orange-500`;

  // Fill panel (entry/exit prices + dates + user R + Save) — shared by TRADED scan
  // rows and open-position rows so the exit-fill write path is identical everywhere.
  const fillPanel = (d: JackDecisionClient, key: string) => {
    const row = getRow(key);
    const rPreview = row.serverUserR ?? previewR(d, row);
    // Every keystroke marks the row DIRTY (survives a server re-seed — mergeSeeded)
    // and clears any standing decimal warning so the guard re-judges the new value.
    const editing = { fillsSave: "idle" as SaveState, guardWarning: null, dirty: true };
    return (
      <div className={`rounded border ${border} px-3 py-2 ${isDarkMode ? "bg-orange-950/20" : "bg-orange-50"}`}>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <span className={`self-center text-[10px] font-bold tracking-widest ${fg}`}>FILLS</span>
          {(
            [
              { lbl: "Entry price", val: row.entry, kind: "price", set: (v: string) => patch(key, { entry: sanitizePrice(v), ...editing }) },
              { lbl: "Entry date", val: row.entryDate, kind: "date", set: (v: string) => patch(key, { entryDate: v, ...editing }) },
              { lbl: "Exit price", val: row.exit, kind: "price", set: (v: string) => patch(key, { exit: sanitizePrice(v), ...editing }) },
              { lbl: "Exit date", val: row.exitDate, kind: "date", set: (v: string) => patch(key, { exitDate: v, ...editing }) },
            ] as const
          ).map((f) => (
            <label key={f.lbl} className="flex flex-col gap-0.5">
              <span className={`text-[9px] uppercase tracking-wide ${subFg}`}>{f.lbl}</span>
              <input
                type={f.kind === "date" ? "date" : "text"}
                inputMode={f.kind === "price" ? "decimal" : undefined}
                value={f.val}
                onChange={(e) => f.set(e.target.value)}
                onKeyDown={stopKeys}
                className={f.kind === "date" ? dateCls : priceCls}
                placeholder={f.kind === "price" ? "0.00" : undefined}
              />
            </label>
          ))}
          <div className={`self-stretch w-px ${isDarkMode ? "bg-orange-900" : "bg-orange-200"}`} />
          <div className="flex flex-col gap-0.5">
            <span className={`text-[9px] uppercase tracking-wide ${subFg}`}>user R</span>
            <span
              className={`text-[13px] font-bold leading-6 ${
                rPreview != null ? (rPreview >= 0 ? "text-green-400" : "text-red-400") : subFg
              }`}
            >
              {rPreview != null ? `${rPreview >= 0 ? "+" : ""}${rPreview.toFixed(2)}R` : "—"}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {row.error && row.fillsSave === "error" && (
              <span className="text-red-400 text-[10px] max-w-40">{row.error}</span>
            )}
            {row.guardWarning && (
              <button
                type="button"
                onClick={() => patch(key, { guardWarning: null })}
                className={`px-2.5 py-1 rounded text-[11px] font-bold border ${
                  isDarkMode ? "border-gray-600 text-gray-300 hover:border-gray-400" : "border-gray-400 text-gray-700 hover:border-gray-600"
                }`}
              >
                Cancel
              </button>
            )}
            {renderSaveButton(d, key, row.fillsSave, !!row.guardWarning)}
          </div>
        </div>
        {/* DECIMAL GUARD — blocks the first click on an implausible fill. */}
        {row.guardWarning && (
          <div
            className={`mt-2 rounded border px-2.5 py-1.5 text-[11px] flex items-start gap-1.5 ${
              isDarkMode ? "border-red-600 bg-red-950/40 text-red-200" : "border-red-500 bg-red-50 text-red-800"
            }`}
          >
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>
              <b>Check the decimal.</b> {row.guardWarning} Fix the field, or click <b>Save anyway</b> if the fill is
              really this.
            </span>
          </div>
        )}
      </div>
    );
  };

  // ---- Open-position live re-read (Part C) → colour + label ----
  type ReadTone = { badge: string; banner: string; label: string };
  const liveReadTone = (verdict: string | null | undefined): ReadTone => {
    const v = (verdict ?? "").toUpperCase();
    if (v === "HOLD")
      return {
        badge: isDarkMode ? "bg-green-600 text-black border-green-400" : "bg-green-700 text-white border-green-800",
        banner: isDarkMode ? "border-green-700 bg-green-950/30 text-green-200" : "border-green-500 bg-green-50 text-green-800",
        label: "HOLD",
      };
    if (v === "EXIT")
      return {
        badge: isDarkMode ? "bg-red-600 text-white border-red-400" : "bg-red-700 text-white border-red-800",
        banner: isDarkMode ? "border-red-700 bg-red-950/30 text-red-200" : "border-red-500 bg-red-50 text-red-800",
        label: "EXIT",
      };
    if (v === "REDUCE")
      return {
        badge: isDarkMode ? "bg-amber-500 text-black border-amber-300" : "bg-amber-400 text-black border-amber-600",
        banner: isDarkMode ? "border-amber-700 bg-amber-950/30 text-amber-200" : "border-amber-500 bg-amber-50 text-amber-800",
        label: "REDUCE",
      };
    return {
      badge: isDarkMode ? "bg-gray-600 text-white border-gray-400" : "bg-gray-500 text-white border-gray-600",
      banner: isDarkMode ? "border-gray-700 bg-gray-900/40 text-gray-300" : "border-gray-300 bg-gray-50 text-gray-600",
      label: verdict ? "…" : "re-read pending",
    };
  };

  const rulesChip = (label: string | null | undefined, tone: string | null | undefined) => {
    if (!label) return null;
    const cls =
      tone === "danger"
        ? isDarkMode ? "border-red-500 text-red-300" : "border-red-600 text-red-700"
        : tone === "good"
          ? isDarkMode ? "border-green-500 text-green-300" : "border-green-600 text-green-700"
          : tone === "warn"
            ? isDarkMode ? "border-amber-500 text-amber-300" : "border-amber-600 text-amber-700"
            : isDarkMode ? "border-gray-600 text-gray-400" : "border-gray-400 text-gray-600";
    return <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap shrink-0 ${cls}`}>{label}</span>;
  };

  const unrealChip = (pct: number | null | undefined) => {
    if (pct == null) return null;
    const good = pct >= 0;
    const cls = good ? (isDarkMode ? "text-green-400" : "text-green-700") : isDarkMode ? "text-red-400" : "text-red-600";
    return <span className={`text-[11px] font-bold ${cls} whitespace-nowrap shrink-0`}>{good ? "+" : ""}{pct.toFixed(1)}%</span>;
  };

  // Open-position row (section "open"). THREE clearly-distinct layers so the frozen
  // entry thesis is never conflated with the live re-read:
  //   1. LIVE RE-READ (LLM, prominent) — has it broken? HOLD/EXIT/REDUCE + why.
  //   2. PRICE LADDER + NOW + unrealized % + days held — where it is.
  //   3. FROZEN THESIS (immutable, de-emphasized) — why I entered.
  const renderOpenRow = (d: JackDecisionClient, i: number) => {
    const key = rowKey(d, i);
    const isOpen = !!expanded[key];
    const tone = liveReadTone(d.liveReadVerdict);
    const frozenVerdict = d.jackDecisionAtMark ?? d.decision;
    return (
      <div key={key} className={`border rounded ${border} ${isOpen ? openBg : rowBg}`}>
        {/* Collapsed header — live re-read verdict is the dominant signal */}
        <button
          type="button"
          onClick={() => toggle(key)}
          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left rounded ${rowHover}`}
        >
          <ChevronRight size={13} className={`${subFg} shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
          <span className={`font-bold ${fg} w-14 shrink-0`}>{d.ticker}</span>
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide border ${tone.badge} whitespace-nowrap shrink-0`}
            title="Live position re-read (LLM, updates each run)"
          >
            {tone.label}
          </span>
          {d.currentPrice != null && (
            <span className={`text-[11px] ${subFg} whitespace-nowrap shrink-0`}>
              NOW {d.currentPrice.toFixed(2)}
            </span>
          )}
          {unrealChip(d.unrealizedPct)}
          {rulesChip(d.rulesFlag, d.rulesTone)}
          {bucketPill(d)}
          <span className="shrink-0 flex items-center gap-1 ml-auto">
            {verdictPill(frozenVerdict, true)}
            <span className="text-[10px] font-bold text-green-400">✓ TRADED</span>
          </span>
        </button>

        {isOpen && (
          <div className={`px-3 pb-3 pt-2 space-y-3 border-t ${border}`}>
            {/* LAYER 1 — LIVE RE-READ (prominent) */}
            <div className={`rounded border px-2.5 py-2 ${tone.banner}`}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-[9px] uppercase tracking-widest opacity-80">Live re-read</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide border ${tone.badge}`}>{tone.label}</span>
                {d.liveReadThesisStatus && d.liveReadThesisStatus !== "unknown" && (
                  <span className="text-[10px] font-semibold opacity-80">thesis: {d.liveReadThesisStatus}</span>
                )}
                <span className="text-[9px] opacity-70 ml-auto">updates each run</span>
              </div>
              {d.liveReadReasoning && d.liveReadReasoning.trim().length > 0 ? (
                <p className="text-xs leading-relaxed break-words">{d.liveReadReasoning}</p>
              ) : (
                <p className="text-[11px] opacity-80 italic">
                  No live re-read yet — run JACK (or check that the position-management LLM is reachable). Frozen thesis + rules below still apply.
                </p>
              )}
              <p className="text-[9px] opacity-60 mt-1.5 italic">
                No live news feed — context in this read is the model&apos;s own inference from price action and general context, not sourced headlines.
              </p>
            </div>

            {/* LAYER 2 — PRICE LADDER + where it is now */}
            {priceLadder(d)}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
              {d.currentPrice != null && (
                <span className={subFg}><span className={`${fg} font-bold`}>NOW</span> {d.currentPrice.toFixed(2)}</span>
              )}
              {d.unrealizedPct != null && (
                <span className={subFg}>
                  <span className={`${fg} font-bold`}>Unrealized</span>{" "}
                  <span className={d.unrealizedPct >= 0 ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                    {d.unrealizedPct >= 0 ? "+" : ""}{d.unrealizedPct.toFixed(1)}%
                  </span>
                </span>
              )}
              {d.daysHeld != null && (
                <span className={subFg}><span className={`${fg} font-bold`}>Held</span> {d.daysHeld}d / 120d</span>
              )}
              {rulesChip(d.rulesFlag, d.rulesTone)}
            </div>

            {/* Candle-chart thumbnail — same overlays; open rows carry the frozen
                setup geometry (entry/stop/target/breakout + handle_low_date). */}
            <div>
              <div className={`text-[9px] uppercase tracking-widest ${subFg} mb-1`}>Chart</div>
              <CandleThumbnail decision={d} isDarkMode={isDarkMode} onOpen={() => setChartFor(d)} />
            </div>

            {/* LAYER 3 — FROZEN ENTRY THESIS (immutable, de-emphasized) */}
            <div className={`rounded border ${isDarkMode ? "border-gray-800" : "border-gray-300"} px-2.5 py-1.5`}>
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[9px] uppercase tracking-widest ${subFg}`}>Entry thesis (frozen — why I entered)</span>
                {verdictPill(frozenVerdict, true)}
              </div>
              <p className={`text-[11px] leading-relaxed break-words ${subFg}`}>
                {d.jackAnalysisAtMark && d.jackAnalysisAtMark.trim().length > 0
                  ? d.jackAnalysisAtMark
                  : "No entry thesis was frozen for this position (marked before thesis-freeze shipped)."}
              </p>
            </div>

            {/* Fills — same write path as any TRADED row (updateUserFills upsert).
                BOTH sides are editable here: the ENTRY fill of a position you already
                own can be corrected (a mis-keyed cost basis poisons unrealized %, the
                rules flag and user_R), and the EXIT closes the position. Edits survive
                the 180s open-position poll — see mergeSeeded. */}
            <div className={`text-[9px] uppercase tracking-widest ${subFg} mb-1`}>
              Fills — correct the entry, or record the exit to close
            </div>
            {fillPanel(d, key)}
          </div>
        )}
      </div>
    );
  };

  const renderRow = (d: JackDecisionClient, i: number) => {
    if (d.section === "open") return renderOpenRow(d, i);
    const key = rowKey(d, i);
    const row = getRow(key);
    const isOpen = !!expanded[key];
    const isTraded = row.userAction === "TRADED";
    const rr = rewardRisk(d);
    const marked = row.userAction != null;
    const liveVerdict = d.decision;
    const frozenVerdict = d.jackDecisionAtMark ?? null;
    // Main position size follows the HANDLE BUCKET (handoff decision 3), NOT the
    // LLM's verdict-driven share count: FULL → full-risk · HALF → ×0.5 (both via
    // d.recShares) · SKIP → discouraged. Marked rows keep the frozen mark-time size.
    // SKIP VETO: a SKIP analysis verdict OR a skip bucket greys/strikes the size (an
    // override is possible but discouraged) — we still show the would-be number
    // (recShares, or full-risk when the bucket itself is skip and recShares is null)
    // struck, not a bare 0.
    const { shares: effShares, vetoed: skipVeto } = mainSharesForRow(d);
    const notional = effShares != null && effShares > 0 && d.entry != null ? effShares * d.entry : null;
    const capPct = notional != null && individualCap ? (notional / individualCap) * 100 : null;
    // JACK's LIVE verdict differs from what it said when the user marked → re-assessed.
    const reassessed =
      marked && frozenVerdict != null && classifyVerdict(liveVerdict) !== classifyVerdict(frozenVerdict);
    const belowEntry = d.currentPrice != null && d.entry != null && d.currentPrice < d.entry;
    // The analysis verdict actually SHOWN beside the handle pill (frozen when
    // marked, live otherwise) — that's the one the disagreement flag reconciles.
    const shownAnalysisVerdict = marked ? frozenVerdict ?? liveVerdict : liveVerdict;

    return (
      <div key={key} className={`border rounded ${border} ${isOpen ? openBg : rowBg}`}>
        {/* Collapsed header — scannable, click to expand */}
        <button
          type="button"
          onClick={() => toggle(key)}
          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left rounded ${rowHover}`}
        >
          <ChevronRight
            size={13}
            className={`${subFg} shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
          <span className={`font-bold ${fg} w-14 shrink-0`}>{d.ticker}</span>
          {/* Marked → frozen verdict, DE-EMPHASIZED (the user's action dominates,
              not JACK's call). Unmarked → live verdict, prominent. */}
          {marked ? verdictPill(frozenVerdict ?? liveVerdict, true) : verdictPill(liveVerdict)}
          {bucketPill(d)}
          {tierLabel(d)}
          {sectorLabel(d)}
          {priorityLabel(d)}
          {exitedLabel(d)}
          {firedBadge(d)}
          {disagreeFlag(shownAnalysisVerdict, d)}
          <span className={`text-[11px] ${subFg} whitespace-nowrap shrink-0`}>
            {d.stop != null ? d.stop.toFixed(2) : "—"} <span className="opacity-60">→</span>{" "}
            {d.target != null ? d.target.toFixed(2) : "—"}
          </span>
          {rMultipleChip(rr)}
          {reassessed && (
            <span
              className="text-[10px] font-bold text-amber-400 whitespace-nowrap shrink-0"
              title={`JACK now says ${liveVerdict} (was ${frozenVerdict} when you marked)`}
            >
              ⚠ changed
            </span>
          )}
          {/* Packed left; the action badge is the dominant signal on marked rows. */}
          <span className="shrink-0 flex items-center gap-1 ml-1">
            {row.actionSave === "saving" && <Loader2 size={10} className="animate-spin" />}
            {actionBadge(row.userAction)}
          </span>
        </button>

        {/* Expanded detail */}
        {isOpen && (
          <div className={`px-3 pb-3 pt-2 space-y-3 border-t ${border}`}>
            {/* JACK's CURRENT re-assessment — framed as position info, NOT a
                contradictory verdict pill. Only shown when it changed post-mark. */}
            {reassessed && (
              <div
                className={`rounded border px-2.5 py-1.5 text-[11px] ${
                  isDarkMode ? "border-amber-700 bg-amber-950/30 text-amber-200" : "border-amber-500 bg-amber-50 text-amber-800"
                }`}
              >
                <span className="font-bold">⚠ JACK re-assessment:</span> now <b>{liveVerdict}</b> (was {frozenVerdict} when you
                marked)
                {d.currentPrice != null && (
                  <>
                    {" — "}${d.currentPrice.toFixed(2)}
                    {belowEntry && d.entry != null ? ` · below entry $${d.entry.toFixed(2)}` : ""}
                  </>
                )}
              </div>
            )}

            {priceLadder(d)}

            {/* Candle-chart thumbnail → opens the annotated modal (levels overlaid).
                Cheap SVG preview; the full chart is created only when the modal opens. */}
            <div>
              <div className={`text-[9px] uppercase tracking-widest ${subFg} mb-1`}>Chart</div>
              <CandleThumbnail decision={d} isDarkMode={isDarkMode} onOpen={() => setChartFor(d)} />
            </div>

            {/* SETUP GEOMETRY (cup/handle shape) + LEVELS/RISK (%-distances, R:R, $) */}
            {setupContext(d)}

            {/* handle_score sizing directive — concrete shares/notional (recommendation) */}
            {sizingBlock(d)}

            {/* Position size — bucket-driven (handoff decision 3). SKIP veto strikes
                the would-be number. Hidden when unknown. */}
            {notional != null && effShares != null && effShares > 0 && (
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-x-4 text-[11px]">
                  <span className={subFg}>
                    <span className={`${fg} font-bold`}>Shares</span>{" "}
                    <span className={skipVeto ? "line-through decoration-1 opacity-60" : ""}>
                      {effShares.toLocaleString()}
                    </span>
                    {skipVeto && <span className="opacity-70 italic"> handle SKIP — discouraged</span>}
                    {marked && <span className="opacity-60"> (at mark)</span>}
                  </span>
                  <span className={subFg}>
                    <span className={`${fg} font-bold`}>Notional</span> $
                    {notional.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    <span className="opacity-60"> (× entry)</span>
                  </span>
                </div>
                {capPct != null && individualCap != null && (
                  <div>
                    <div className="flex justify-between text-[10px] mb-0.5">
                      <span className={subFg}>vs individual cap (${individualCap.toLocaleString()})</span>
                      <span className={capPct >= 90 ? "text-red-400 font-bold" : capPct >= 50 ? "text-amber-400" : subFg}>
                        {capPct.toFixed(0)}%
                      </span>
                    </div>
                    <div className={`h-1.5 rounded ${track} overflow-hidden`}>
                      <div
                        className={`h-full rounded ${capPct >= 90 ? "bg-red-500" : capPct >= 50 ? "bg-amber-500" : "bg-green-500"}`}
                        style={{ width: `${Math.min(100, capPct)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Reasoning — full width, primary content */}
            <div>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {chip("earnings", d.earningsFlag)}
                {chip("news", d.newsClass)}
                {chip("sector RS", d.sectorRs)}
                {chip("cross", d.crossAsset)}
                {chip("→breakout", d.pctToBreakout != null ? `${d.pctToBreakout.toFixed(1)}%` : null)}
              </div>
              <p className={`text-xs leading-relaxed break-words ${textFg}`}>
                {d.note && d.note.trim().length > 0 ? d.note : <span className={subFg}>No JACK note for this setup.</span>}
              </p>
            </div>

            {/* Action controls */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[9px] uppercase tracking-widest ${subFg}`}>Mark</span>
              {actionButton(d, key, "TRADED", row.userAction === "TRADED")}
              {actionButton(d, key, "PASSED", row.userAction === "PASSED")}
              {actionButton(d, key, "WATCHED", row.userAction === "WATCHED")}
              {row.actionSave === "saved" && <Check size={12} className="text-green-400" />}
              {row.actionSave === "error" && <span className="text-red-400 text-[10px]">{row.error}</span>}
              {!persistenceAvailable && <span className="text-[10px] text-yellow-500">writes disabled</span>}
            </div>

            {/* Fill panel — ONLY on TRADED rows (any section) */}
            {isTraded && fillPanel(d, key)}
          </div>
        )}
      </div>
    );
  };

  const renderGroup = (title: string, list: JackDecisionClient[], color: string) => {
    if (list.length === 0) return null;
    return (
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-[11px] font-bold tracking-widest ${color}`}>{title}</span>
          <span className={`text-[11px] ${subFg}`}>({list.length})</span>
          <div className={`flex-1 h-px ${isDarkMode ? "bg-orange-900/50" : "bg-orange-200"}`} />
        </div>
        <div className="space-y-1">{list.map((d, i) => renderRow(d, i))}</div>
      </div>
    );
  };

  return (
    <div className="mb-4 space-y-4 min-w-0">
      {openDecisions.length > 0 && (
        <div className={`rounded border ${border} ${isDarkMode ? "bg-amber-950/15" : "bg-amber-50"} p-2`}>
          <div className={`text-[10px] ${subFg} mb-1 px-1`}>
            Open trades from any prior run — reachable until you record the exit, even if the ticker isn&apos;t in
            this week&apos;s scan. Each row shows the frozen entry thesis, live price (NOW / unrealized / days held),
            and a fresh HOLD/EXIT/REDUCE re-read. Expand to correct the logged entry fill, or Save the exit
            price/date to close it.
          </div>
          {renderGroup("CURRENT POSITIONS", openDecisions, "text-amber-400")}
        </div>
      )}
      {renderGroup("LIVE", liveDecisions, "text-green-400")}
      {renderGroup("PENDING", pendingDecisions, "text-sky-400")}
      <div className={`text-[10px] ${subFg}`}>
        Click a row to expand. <b>Mark</b> T/P/W → recorded per setup (unmarked stays neutral, not passed).
        Fill fields appear only on <b>TRADED</b> rows — enter prices/dates then <b>Save fills</b> (must go green
        <b> Saved</b> to persist). Marks &amp; fills reload from the DB when you return to JACK.
      </div>

      {/* ONE chart modal for the whole table — created on open, disposed on close. */}
      {chartFor && (
        <CandleChartModal decision={chartFor} isDarkMode={isDarkMode} onClose={() => setChartFor(null)} />
      )}
    </div>
  );
}
