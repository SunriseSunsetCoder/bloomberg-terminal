"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Save, ChevronRight } from "lucide-react";
import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";

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

// JACK verdict → colour class family.
type Verdict = "trade" | "skip" | "watch" | "fired" | "other";
function classifyVerdict(decision: string): Verdict {
  const s = (decision || "").toUpperCase();
  if (s.includes("TRADE")) return "trade";
  if (s.includes("SKIP") || s.includes("AVOID") || s.includes("PASS")) return "skip";
  if (s.includes("WATCH")) return "watch";
  if (s.includes("FIRED") || s.includes("EXTENDED")) return "fired";
  return "other";
}

export function JackDecisionsTable({ decisions, isDarkMode, persistenceAvailable, individualCap }: JackDecisionsTableProps) {
  const [rows, setRows] = useState<Record<string, RowState>>(() => seedRows(decisions));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({}); // all collapsed by default

  useEffect(() => {
    setRows(seedRows(decisions));
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
        const json = (await res.json()) as { marks?: Record<string, MarkDto> };
        if (cancelled || !json.marks) return;
        setRows(seedRows(overlayMarks(decisions, json.marks)));
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
    patch(key, { fillsSave: "saving", error: undefined });
    try {
      const r = await postDecision({ type: "user_fills", setupId: d.setupId, entry, entryDate, exit, exitDate });
      patch(
        key,
        r.ok ? { fillsSave: "saved", serverUserR: r.userRRealized ?? null } : { fillsSave: "error", error: r.error }
      );
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

  const openDecisions = useMemo(() => decisions.filter((d) => d.section === "open"), [decisions]);
  const liveDecisions = useMemo(() => decisions.filter((d) => d.section === "live"), [decisions]);
  const pendingDecisions = useMemo(() => decisions.filter((d) => d.section === "pending"), [decisions]);

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

  // Headline FULL / HALF / SKIP pill + the handle_score. SKIP is still shown (a
  // skip is information; near-line scores like 0.452 deserve an eyeball).
  const bucketPill = (d: JackDecisionClient) => {
    const bucket = d.sizeBucket ?? null;
    if (bucket == null && d.handleScore == null) return null;
    const cls = isDarkMode
      ? bucket === "full"
        ? "bg-green-600 text-black border-green-400"
        : bucket === "half"
          ? "bg-amber-500 text-black border-amber-300"
          : "bg-gray-600 text-gray-200 border-gray-500"
      : bucket === "full"
        ? "bg-green-700 text-white border-green-800"
        : bucket === "half"
          ? "bg-amber-400 text-black border-amber-600"
          : "bg-gray-500 text-white border-gray-600";
    const label = bucket ? bucket.toUpperCase() : "—";
    // Recommended-bucket share count inline on the pill for FULL/HALF.
    const recSh = d.recShares != null && d.recShares > 0 ? ` ${d.recShares.toLocaleString()}sh` : "";
    return (
      <span className="inline-flex items-center gap-1 shrink-0">
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide border whitespace-nowrap ${cls}`}
          title="handle_score sizing directive — recommendation, you decide + size"
        >
          {label}{recSh}
        </span>
        {d.handleScore != null && (
          <span className={`text-[10px] font-mono ${subFg} whitespace-nowrap`} title="handle_score (0–1) — higher = better handle">
            {d.handleScore.toFixed(3)}
          </span>
        )}
      </span>
    );
  };

  // Expanded sizing block — concrete shares + notional the user would trade at the
  // recommended size, from risk/trade ÷ stop distance. Recommendation, not applied.
  const sizingBlock = (d: JackDecisionClient) => {
    if (d.sizeBucket == null && d.handleScore == null) return null;
    const bucket = d.sizeBucket ?? null;
    const headline =
      bucket === "full" && d.fullShares != null && d.fullNotional != null
        ? `FULL — ${d.fullShares.toLocaleString()} sh / ${fmtUsd0(d.fullNotional)}`
        : bucket === "half" && d.halfShares != null && d.halfNotional != null
          ? `HALF — ${d.halfShares.toLocaleString()} sh / ${fmtUsd0(d.halfNotional)}`
          : bucket === "skip"
            ? "SKIP — no position recommended (score below the Q3 line)"
            : bucket
              ? `${bucket.toUpperCase()} — share count unavailable (missing entry/stop)`
              : "unscored";
    return (
      <div className={`rounded border ${border} px-2.5 py-1.5 ${isDarkMode ? "bg-gray-950/60" : "bg-white"}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`text-[9px] uppercase tracking-widest ${subFg}`}>handle_score sizing</span>
          {bucketPill(d)}
          <span className={`text-[11px] font-bold ${bucket === "skip" ? subFg : fg}`}>{headline}</span>
        </div>
        {/* full/half reference line so the trader can see both sizes at a glance */}
        {(d.fullShares != null || d.halfShares != null) && (
          <div className={`flex flex-wrap gap-x-4 mt-1 text-[10px] ${subFg}`}>
            {d.fullShares != null && d.fullNotional != null && (
              <span>full {d.fullShares.toLocaleString()} sh · {fmtUsd0(d.fullNotional)}</span>
            )}
            {d.halfShares != null && d.halfNotional != null && (
              <span>half {d.halfShares.toLocaleString()} sh · {fmtUsd0(d.halfNotional)}</span>
            )}
          </div>
        )}
        <div className={`text-[9px] ${subFg} mt-1 italic`}>
          Recommendation from the validated handle-score edge — you decide and size. Shares = risk/trade ÷ (entry − stop).
        </div>
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

  const renderSaveButton = (d: JackDecisionClient, key: string, state: SaveState) => {
    const base =
      "flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-bold border transition-colors disabled:opacity-50";
    const cls =
      state === "saved"
        ? "border-green-600 text-green-400 bg-green-950/30"
        : state === "error"
          ? "border-red-600 text-red-400 bg-red-950/30 hover:bg-red-950/50"
          : "bg-orange-600 border-orange-500 text-black hover:bg-orange-500";
    return (
      <button type="button" onClick={() => handleSaveFills(d, key)} disabled={state === "saving"} className={`${base} ${cls}`}>
        {state === "saving" ? (
          <><Loader2 size={12} className="animate-spin" /> Saving…</>
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
    return (
      <div className={`rounded border ${border} px-3 py-2 ${isDarkMode ? "bg-orange-950/20" : "bg-orange-50"}`}>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <span className={`self-center text-[10px] font-bold tracking-widest ${fg}`}>FILLS</span>
          {(
            [
              { lbl: "Entry price", val: row.entry, kind: "price", set: (v: string) => patch(key, { entry: sanitizePrice(v), fillsSave: "idle" }) },
              { lbl: "Entry date", val: row.entryDate, kind: "date", set: (v: string) => patch(key, { entryDate: v, fillsSave: "idle" }) },
              { lbl: "Exit price", val: row.exit, kind: "price", set: (v: string) => patch(key, { exit: sanitizePrice(v), fillsSave: "idle" }) },
              { lbl: "Exit date", val: row.exitDate, kind: "date", set: (v: string) => patch(key, { exitDate: v, fillsSave: "idle" }) },
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
            {renderSaveButton(d, key, row.fillsSave)}
          </div>
        </div>
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

            {/* Exit fills — same write path as any TRADED row (updateUserFills) */}
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
    // Frozen share size on marked rows (mark-time context); current re-assessment's
    // shares otherwise. Notional = effective shares × entry.
    const effShares = marked ? d.sharesAtMark : d.shares;
    const notional = effShares != null && effShares > 0 && d.entry != null ? effShares * d.entry : null;
    const capPct = notional != null && individualCap ? (notional / individualCap) * 100 : null;
    // JACK's LIVE verdict differs from what it said when the user marked → re-assessed.
    const reassessed =
      marked && frozenVerdict != null && classifyVerdict(liveVerdict) !== classifyVerdict(frozenVerdict);
    const belowEntry = d.currentPrice != null && d.entry != null && d.currentPrice < d.entry;

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

            {/* handle_score sizing directive — concrete shares/notional (recommendation) */}
            {sizingBlock(d)}

            {/* Position size (frozen share size on marked rows). Hidden when 0/unknown. */}
            {notional != null && effShares != null && effShares > 0 && (
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-x-4 text-[11px]">
                  <span className={subFg}>
                    <span className={`${fg} font-bold`}>Shares</span> {effShares.toLocaleString()}
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
                {chip("sector", d.sectorRs)}
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
            and a fresh HOLD/EXIT/REDUCE re-read. Expand and Save the exit price/date to close it.
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
    </div>
  );
}
