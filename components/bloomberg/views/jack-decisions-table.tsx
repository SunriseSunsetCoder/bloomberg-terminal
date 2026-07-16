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
}

// Overlay freshly-fetched DB marks onto the (possibly stale) decisions so seedRows
// re-displays the latest saved action + fills. DB is source of truth on mount.
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

export function JackDecisionsTable({ decisions, isDarkMode, persistenceAvailable }: JackDecisionsTableProps) {
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

  const liveDecisions = useMemo(() => decisions.filter((d) => d.section === "live"), [decisions]);
  const pendingDecisions = useMemo(() => decisions.filter((d) => d.section === "pending"), [decisions]);

  if (decisions.length === 0) return null;

  // ================= small presentational helpers =================

  const verdictPill = (decision: string) => {
    const v = classifyVerdict(decision);
    const cls =
      v === "trade"
        ? "bg-green-600/20 text-green-400 border-green-700"
        : v === "skip"
          ? "bg-red-600/20 text-red-400 border-red-700"
          : v === "watch"
            ? "bg-amber-500/20 text-amber-400 border-amber-600"
            : "bg-gray-600/20 text-gray-400 border-gray-600";
    return (
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide border ${cls} whitespace-nowrap`}>
        {decision}
      </span>
    );
  };

  const rMultipleChip = (rr: number | null) => {
    if (rr == null) return <span className={`text-[11px] ${subFg}`}>R/R —</span>;
    const color = rr >= 1.5 ? "text-green-400" : rr >= 1 ? "text-amber-400" : "text-red-400";
    return (
      <span className={`text-[11px] font-bold ${color} whitespace-nowrap`}>R/R {rr.toFixed(2)}</span>
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

  const renderRow = (d: JackDecisionClient, i: number) => {
    const key = rowKey(d, i);
    const row = getRow(key);
    const isOpen = !!expanded[key];
    const isTraded = row.userAction === "TRADED";
    const rr = rewardRisk(d);
    const rPreview = row.serverUserR ?? previewR(d, row);

    return (
      <div key={key} className={`border rounded ${border} ${isOpen ? openBg : rowBg}`}>
        {/* Collapsed header — scannable, click to expand */}
        <button
          type="button"
          onClick={() => toggle(key)}
          className={`w-full flex items-center gap-2 px-2 py-1.5 text-left rounded ${rowHover}`}
        >
          <ChevronRight
            size={13}
            className={`${subFg} shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
          <span className={`font-bold ${fg} w-14 shrink-0`}>{d.ticker}</span>
          {verdictPill(d.decision)}
          <span className={`text-[11px] ${subFg} whitespace-nowrap`}>
            {d.stop != null ? d.stop.toFixed(2) : "—"} <span className="opacity-60">→</span>{" "}
            {d.target != null ? d.target.toFixed(2) : "—"}
          </span>
          {rMultipleChip(rr)}
          <span className="ml-auto shrink-0 flex items-center gap-1">
            {row.actionSave === "saving" && <Loader2 size={10} className="animate-spin" />}
            {actionBadge(row.userAction)}
          </span>
        </button>

        {/* Expanded detail */}
        {isOpen && (
          <div className={`px-3 pb-3 pt-2 space-y-3 border-t ${border}`}>
            {priceLadder(d)}

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
            {isTraded && (
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
            )}
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
