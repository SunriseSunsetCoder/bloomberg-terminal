"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Save } from "lucide-react";
import type { JackDecisionClient } from "@/components/bloomberg/hooks/useJackValidation";

// ============================================================================
// JACK interactive decision table (Session B, Deliverable 2).
//
// SOURCE OF TRUTH for user writes. Binds to the parsed JSON decisions block
// (props.decisions), NOT scraped markdown. Two writes per row:
//   - Action TRADED/PASSED/WATCHED → decisions.user_action
//   - Fills (entry/exit/exit-date, enabled when TRADED) → outcomes user-fill cols
//
// State is React-only — NO localStorage/sessionStorage (forbidden in this repo).
// On Vercel (persistenceAvailable=false) rows render but writes are disabled.
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

// Bug A re-hydration: seed row state from existing marks/fills the route attached
// to each decision, so a re-VALIDATE re-displays what the user previously recorded
// instead of blank rows. Rows with no prior marks are left to lazy defaults.
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

export function JackDecisionsTable({ decisions, isDarkMode, persistenceAvailable }: JackDecisionsTableProps) {
  // Seed from existing marks on first render, and re-seed whenever a new
  // validation response arrives (decisions identity changes) — that's the
  // re-VALIDATE case where persisted marks must reappear.
  const [rows, setRows] = useState<Record<string, RowState>>(() => seedRows(decisions));
  useEffect(() => {
    setRows(seedRows(decisions));
  }, [decisions]);

  const getRow = (key: string): RowState => rows[key] ?? defaultRow();

  // Merge onto the LATEST state (prev), not the render-snapshot `rows` closure.
  // Reading `rows` here dropped earlier updates when two patches fired in one
  // handler (e.g. handleAction's userAction patch then actionSave patch) — the
  // second clobbered userAction back to null, so the highlight/enable never stuck.
  const patch = (key: string, next: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [key]: { ...(prev[key] ?? defaultRow()), ...next } }));

  const subFg = isDarkMode ? "text-gray-400" : "text-gray-600";
  const fg = isDarkMode ? "text-orange-400" : "text-orange-700";
  const border = isDarkMode ? "border-orange-900" : "border-orange-200";
  const inputBg = isDarkMode ? "bg-gray-950" : "bg-gray-50";
  const inputBorder = isDarkMode ? "border-gray-800" : "border-gray-300";
  const inputFg = isDarkMode ? "text-orange-300" : "text-gray-900";
  const headBg = isDarkMode ? "bg-gray-950" : "bg-gray-100";

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

  const handleSaveFills = async (d: JackDecisionClient, key: string) => {
    const row = getRow(key);
    const entry = row.entry === "" ? null : Number(row.entry);
    const entryDate = row.entryDate === "" ? null : row.entryDate;
    const exit = row.exit === "" ? null : Number(row.exit);
    const exitDate = row.exitDate === "" ? null : row.exitDate;
    // Surface the no-op cases the old code swallowed silently (which looked like
    // "I clicked Save and nothing persisted").
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
        r.ok
          ? { fillsSave: "saved", serverUserR: r.userRRealized ?? null }
          : { fillsSave: "error", error: r.error }
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

  const renderSaveIcon = (state: SaveState) => {
    if (state === "saving") return <Loader2 size={11} className="animate-spin" />;
    if (state === "saved") return <Check size={11} className="text-green-400" />;
    if (state === "error") return <span className="text-red-400">!</span>;
    return null;
  };

  // Distinct color per action so the recorded choice is unmistakable (bug: all
  // three previously read as an identical green check).
  const actionTextColor = (a: UserAction | null): string =>
    a === "TRADED" ? "text-green-400" : a === "PASSED" ? "text-gray-300" : a === "WATCHED" ? "text-blue-400" : "";

  const actionBtn = (d: JackDecisionClient, key: string, action: UserAction, active: boolean) => {
    const base = "px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors";
    const on =
      action === "TRADED"
        ? "bg-green-600 border-green-500 text-black"
        : action === "PASSED"
          ? "bg-gray-600 border-gray-500 text-white"
          : "bg-blue-600 border-blue-500 text-white";
    const off = isDarkMode
      ? "bg-transparent border-gray-700 text-gray-400 hover:border-gray-500"
      : "bg-transparent border-gray-300 text-gray-600 hover:border-gray-500";
    return (
      <button
        type="button"
        onClick={() => handleAction(d, key, action)}
        className={`${base} ${active ? on : off}`}
      >
        {action.charAt(0)}
      </button>
    );
  };

  // Prominent per-row Save button for the fills. Lives in the full-width fills
  // sub-row (below), so it's never hidden by the table's horizontal scroll.
  const renderSaveButton = (d: JackDecisionClient, key: string, state: SaveState) => {
    const base = "flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-bold border transition-colors disabled:opacity-50";
    const cls =
      state === "saved"
        ? "border-green-600 text-green-400 bg-green-950/30"
        : state === "error"
          ? "border-red-600 text-red-400 bg-red-950/30 hover:bg-red-950/50"
          : "bg-orange-600 border-orange-500 text-black hover:bg-orange-500"; // idle / saving — prominent
    return (
      <button
        type="button"
        onClick={() => handleSaveFills(d, key)}
        disabled={state === "saving"}
        className={`${base} ${cls}`}
      >
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

  const renderSection = (title: string, list: JackDecisionClient[], color: string) => {
    if (list.length === 0) return null;
    const stopKeys = (e: { stopPropagation: () => void }) => e.stopPropagation();
    const inputCls = `w-20 px-1 py-0.5 rounded ${inputBg} border ${inputBorder} ${inputFg} text-[11px] focus:outline-none focus:border-orange-500`;
    const dateCls = `w-32 px-1 py-0.5 rounded ${inputBg} border ${inputBorder} ${inputFg} text-[11px] focus:outline-none focus:border-orange-500`;
    return (
      <div className="mb-3">
        <div className={`text-[11px] font-bold mb-1 ${color}`}>
          {title} ({list.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className={`${headBg} ${subFg}`}>
                <th className="text-left px-1.5 py-1 font-normal">Ticker</th>
                <th className="text-left px-1.5 py-1 font-normal">JACK</th>
                <th className="text-left px-1.5 py-1 font-normal">Stop/Tgt</th>
                <th className="text-center px-1.5 py-1 font-normal">Action</th>
              </tr>
            </thead>
            <tbody>
              {list.map((d, i) => {
                const key = rowKey(d, i);
                const row = getRow(key);
                const isTraded = row.userAction === "TRADED";
                const rPreview = row.serverUserR ?? previewR(d, row);
                return (
                  <Fragment key={key}>
                    <tr className={isTraded ? "" : `border-b ${border}`}>
                      <td className={`px-1.5 py-1 font-bold ${fg}`}>{d.ticker}</td>
                      <td className={`px-1.5 py-1 ${subFg}`}>{d.decision}</td>
                      <td className={`px-1.5 py-1 ${subFg} whitespace-nowrap`}>
                        {d.stop != null ? d.stop.toFixed(2) : "—"} / {d.target != null ? d.target.toFixed(2) : "—"}
                      </td>
                      <td className="px-1.5 py-1">
                        <div className="flex items-center justify-center gap-1">
                          {actionBtn(d, key, "TRADED", row.userAction === "TRADED")}
                          {actionBtn(d, key, "PASSED", row.userAction === "PASSED")}
                          {actionBtn(d, key, "WATCHED", row.userAction === "WATCHED")}
                          {row.userAction && (
                            <span className={`flex items-center gap-1 ${actionTextColor(row.userAction)}`}>
                              {renderSaveIcon(row.actionSave)}
                              <span className="text-[10px] font-bold">{row.userAction}</span>
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>

                    {/* Fills sub-row — only for TRADED. Full-width so the Save button
                        is always visible (was previously lost in horizontal scroll). */}
                    {isTraded && (
                      <tr className={`border-b ${border}`}>
                        <td colSpan={4} className="px-1.5 pb-2 pt-0.5">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-2">
                            <span className={`text-[10px] font-bold ${subFg}`}>FILLS →</span>
                            <label className={`flex items-center gap-1 ${subFg}`}>
                              Entry
                              <input
                                type="text" inputMode="decimal" value={row.entry}
                                onChange={(e) => patch(key, { entry: sanitizePrice(e.target.value), fillsSave: "idle" })}
                                onKeyDown={stopKeys} className={inputCls} placeholder="—"
                              />
                            </label>
                            <label className={`flex items-center gap-1 ${subFg}`}>
                              Entry date
                              <input
                                type="date" value={row.entryDate}
                                onChange={(e) => patch(key, { entryDate: e.target.value, fillsSave: "idle" })}
                                onKeyDown={stopKeys} className={dateCls}
                              />
                            </label>
                            <label className={`flex items-center gap-1 ${subFg}`}>
                              Exit
                              <input
                                type="text" inputMode="decimal" value={row.exit}
                                onChange={(e) => patch(key, { exit: sanitizePrice(e.target.value), fillsSave: "idle" })}
                                onKeyDown={stopKeys} className={inputCls} placeholder="—"
                              />
                            </label>
                            <label className={`flex items-center gap-1 ${subFg}`}>
                              Exit date
                              <input
                                type="date" value={row.exitDate}
                                onChange={(e) => patch(key, { exitDate: e.target.value, fillsSave: "idle" })}
                                onKeyDown={stopKeys} className={dateCls}
                              />
                            </label>
                            <span className={`font-bold ${rPreview != null ? (rPreview >= 0 ? "text-green-400" : "text-red-400") : subFg}`}>
                              user R: {rPreview != null ? `${rPreview >= 0 ? "+" : ""}${rPreview.toFixed(2)}R` : "—"}
                            </span>
                            {renderSaveButton(d, key, row.fillsSave)}
                            {row.error && <span className="text-red-400 text-[10px]">{row.error}</span>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className={`mb-4 border rounded ${border} p-3`}>
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs font-bold ${fg}`}>DECISIONS — mark what you did (source of truth)</span>
        {!persistenceAvailable && (
          <span className="text-[10px] text-yellow-500">writes disabled (persistence off)</span>
        )}
      </div>
      {renderSection("LIVE", liveDecisions, "text-green-400")}
      {renderSection("PENDING", pendingDecisions, "text-blue-400")}
      <div className={`text-[10px] ${subFg} mt-1`}>
        Action letters: <b>T</b>raded · <b>P</b>assed · <b>W</b>atched. Marking <b>TRADED</b> opens a fills row —
        enter entry/exit price + dates, then click <b>Save fills</b> (it must go green <b>Saved</b> to persist).
        Saved fills re-appear when you return to JACK. user R = (exit − entry) / (entry − stop); Entry/Exit dates
        capture your actual holding period.
      </div>
    </div>
  );
}
