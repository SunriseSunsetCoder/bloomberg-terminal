"use client";

import { useState, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play, RotateCcw, Copy, Check, Briefcase, Filter, Database, RefreshCw, DollarSign, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useJackValidation } from "@/components/bloomberg/hooks/useJackValidation";
import { useJackOpenPositions } from "@/components/bloomberg/hooks/useJackOpenPositions";
import { useJackFiredFlags } from "@/components/bloomberg/hooks/useJackFiredFlags";
import { JackDecisionsTable } from "@/components/bloomberg/views/jack-decisions-table";
import { combineJackDecisions } from "@/lib/jack/combine-decisions";

interface OutcomesToast {
  kind: "ok" | "error";
  message: string;
}

const DEFAULT_RISK = 2000;
const LS_KEY_RISK = "jack.riskPerTrade";
const LS_KEY_CSV = "jack.lastCsv";

interface JackViewProps {
  isDarkMode?: boolean;
  onBack?: () => void;
}

export function JackView({ isDarkMode = true, onBack }: JackViewProps) {
  const [riskPerTrade, setRiskPerTrade] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_RISK;
    const stored = window.localStorage.getItem(LS_KEY_RISK);
    const n = stored ? Number(stored) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RISK;
  });

  const [csv, setCsv] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(LS_KEY_CSV) ?? "";
  });

  const [copied, setCopied] = useState(false);
  // Collapsible input panel so the decision output gets primary space (React
  // state only — no storage). Auto-collapses once a result exists is deliberately
  // NOT done; the user drives it.
  const [inputCollapsed, setInputCollapsed] = useState(false);
  // v2: expandable rows are the primary surface; the raw markdown (wide Table 1/2)
  // is a collapsed fallback for copy/reference. Default hidden.
  const [showRaw, setShowRaw] = useState(false);
  const { mutate, data, isPending, reset } = useJackValidation();
  // Open positions across ALL runs, so an open trade stays reachable even when it
  // isn't in this week's scan. A setup whose latest mark is TRADED routes to CURRENT
  // POSITIONS (open-management view) and out of LIVE/PENDING — see combineJackDecisions,
  // which also guarantees every TRADED setup appears in exactly one section.
  const { data: openData } = useJackOpenPositions();
  const queryClient = useQueryClient();
  // Instant-after-save: a recorded exit closes the position, but the cached
  // validation response (data.decisions) doesn't refresh until re-VALIDATE. Keep a
  // local map of setups exited THIS session and patch their userExitPrice into the
  // combine input so the row re-routes out of CURRENT POSITIONS immediately. The DB
  // is authoritative — the next VALIDATE reads the same exit, making this redundant
  // (never contradictory), so we never need to clear it.
  const [localExits, setLocalExits] = useState<Record<number, { price: number; date: string | null }>>({});

  // Close-confirmed FIRE flags, polled on the same 180s cadence as the open-position
  // board. The validation response is frozen at VALIDATE time, so this is what lets an
  // 18:00 fire re-section a row to LIVE on an already-open terminal, unattended.
  const setupIds = useMemo(
    () =>
      Array.from(
        new Set((data?.decisions ?? []).map((d) => d.setupId).filter((x): x is number => x != null))
      ),
    [data?.decisions]
  );
  const { data: firedFlags } = useJackFiredFlags(setupIds);

  const combinedDecisions = useMemo(() => {
    const runDecisions = (data?.decisions ?? []).map((d) => {
      let row = d;
      if (d.setupId != null && localExits[d.setupId]) {
        row = { ...row, userExitPrice: localExits[d.setupId].price, userExitDate: localExits[d.setupId].date };
      }
      // Overlay the freshly-polled flag BEFORE combining, so combineJackDecisions can
      // do the display re-section (fired → LIVE group) on current data.
      const f = d.setupId != null ? firedFlags?.[String(d.setupId)] : undefined;
      if (f) {
        row = { ...row, firedAt: f.firedAt, fireClose: f.fireClose, fireBar: f.fireBar, firedStatus: f.firedStatus };
      }
      return row;
    });
    return combineJackDecisions(runDecisions, openData?.positions ?? []);
  }, [data?.decisions, openData?.positions, localExits, firedFlags]);

  // "Update Outcomes" trigger (Session B, Deliverable 3) — POST the tracker,
  // toast the summary. React state only, no storage.
  const [outcomesPending, setOutcomesPending] = useState(false);
  const [outcomesToast, setOutcomesToast] = useState<OutcomesToast | null>(null);

  const handleUpdateOutcomes = useCallback(async () => {
    setOutcomesPending(true);
    setOutcomesToast(null);
    try {
      const res = await fetch("/api/jack-outcomes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}), // resolutionDays defaults to 90 server-side
      });
      const json = (await res.json()) as {
        ok: boolean;
        message?: string;
        error?: string;
      };
      setOutcomesToast({
        kind: json.ok ? "ok" : "error",
        message: json.message ?? json.error ?? "No response",
      });
    } catch (e) {
      setOutcomesToast({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setOutcomesPending(false);
    }
  }, []);

  // "Refresh Prices" trigger — lightweight NOW-price update (NO LLM re-read). mode=auto
  // resolves server-side: market open → intraday (Tiingo IEX, display-only), closed →
  // eod close + outcome tracker. Writes jack:prices; invalidating the open-positions
  // query re-reads it (Redis-first) and recomputes unrealized. React state only.
  const [pricesPending, setPricesPending] = useState(false);

  const handleRefreshPrices = useCallback(async () => {
    setPricesPending(true);
    try {
      const res = await fetch("/api/jack-refresh?mode=auto", { method: "POST" });
      const json = (await res.json()) as { ok: boolean; mode?: string; updated?: number; iexUnavailable?: boolean; error?: string };
      setOutcomesToast({
        kind: json.ok ? "ok" : "error",
        message: json.ok
          ? `Prices refreshed (${json.mode}${json.updated != null ? `, ${json.updated} tickers` : ""})${json.iexUnavailable ? " — IEX unavailable, showing last close" : ""}`
          : json.error ?? "Refresh failed",
      });
      await queryClient.invalidateQueries({ queryKey: ["jack-open-positions"] });
    } catch (e) {
      setOutcomesToast({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPricesPending(false);
    }
  }, [queryClient]);

  const handleRiskChange = useCallback((next: number) => {
    setRiskPerTrade(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LS_KEY_RISK, String(next));
    }
  }, []);

  const handleCsvChange = useCallback((next: string) => {
    setCsv(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LS_KEY_CSV, next);
    }
  }, []);

  const handleValidate = useCallback(() => {
    if (!csv.trim()) return;
    mutate({ csv, riskPerTrade });
  }, [csv, riskPerTrade, mutate]);

  const handleClear = useCallback(() => {
    setCsv("");
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LS_KEY_CSV);
    }
    reset();
  }, [reset]);

  const handleCopy = useCallback(async () => {
    if (!data?.markdown) return;
    try {
      await navigator.clipboard.writeText(data.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fail silently
    }
  }, [data?.markdown]);

  const rowCount = useMemo(() => {
    if (!csv.trim()) return 0;
    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return Math.max(0, lines.length - 1);
  }, [csv]);

  const sessionCap = riskPerTrade * 400;
  const individualCap = riskPerTrade * 100;

  const bg = isDarkMode ? "bg-black" : "bg-white";
  const fg = isDarkMode ? "text-orange-400" : "text-orange-700";
  const subFg = isDarkMode ? "text-gray-400" : "text-gray-600";
  const border = isDarkMode ? "border-orange-900" : "border-orange-200";
  const inputBg = isDarkMode ? "bg-gray-950" : "bg-gray-50";
  const inputBorder = isDarkMode ? "border-gray-800" : "border-gray-300";
  const inputFg = isDarkMode ? "text-orange-300" : "text-gray-900";
  const btnPrimary = isDarkMode
    ? "bg-orange-600 hover:bg-orange-500 text-black"
    : "bg-orange-600 hover:bg-orange-700 text-white";
  const btnSecondary = isDarkMode
    ? "bg-gray-900 hover:bg-gray-800 text-orange-300 border border-gray-800"
    : "bg-white hover:bg-gray-100 text-gray-800 border border-gray-300";
  return (
    <div className={`flex flex-col w-full ${bg} ${fg} font-mono text-sm overflow-hidden`} style={{ height: "calc(100vh - 4rem)" }}>
      {/* Header bar */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${border} flex-shrink-0`}>
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btnSecondary}`}
            >
              <ArrowLeft size={14} /> BACK
            </button>
          )}
          <div className="flex items-center gap-2">
            <Briefcase size={16} />
            <span className="font-bold tracking-wider">JACK</span>
            <span className={`text-xs ${subFg}`}>
              Cup with Handle t05 v1.2 — Live + Pending with Tiingo
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRefreshPrices}
            disabled={pricesPending}
            title="Lightweight NOW-price refresh (no LLM re-read). Market open → intraday IEX (display-only); closed → EOD close + outcome tracker."
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btnSecondary} disabled:opacity-50`}
          >
            {pricesPending ? (
              <><RefreshCw size={12} className="animate-spin" /> REFRESHING…</>
            ) : (
              <><DollarSign size={12} /> REFRESH PRICES</>
            )}
          </button>
          <button
            onClick={handleUpdateOutcomes}
            disabled={outcomesPending}
            title="Run the Tiingo outcome tracker: replay each resolved setup (90 trading days), write theoretical R to the outcomes table."
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btnSecondary} disabled:opacity-50`}
          >
            {outcomesPending ? (
              <><RefreshCw size={12} className="animate-spin" /> UPDATING…</>
            ) : (
              <><RefreshCw size={12} /> UPDATE OUTCOMES</>
            )}
          </button>
          <div className={`text-xs ${subFg}`}>
            Risk/trade: <span className={fg}>${riskPerTrade.toLocaleString()}</span>
            {" · "}Indiv cap: <span className={fg}>${individualCap.toLocaleString()}</span>
            {" · "}Session cap: <span className={fg}>${sessionCap.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Outcome-tracker toast */}
      {outcomesToast && (
        <div
          className={`px-4 py-2 border-b ${border} flex-shrink-0 text-xs flex items-center justify-between ${
            outcomesToast.kind === "ok" ? "text-green-400" : "text-yellow-400"
          }`}
        >
          <span>
            <span className="font-bold">Outcomes:</span> {outcomesToast.message}
          </span>
          <button onClick={() => setOutcomesToast(null)} className={subFg}>✕</button>
        </div>
      )}

      {/* Strategy + pipeline info strip */}
      <div className={`px-4 py-2 border-b ${border} text-xs ${subFg} flex-shrink-0`}>
        <span className={fg}>Strategy:</span> Bulkowski Cup with Handle t05
        {" · "}
        <span className={fg}>Backtest:</span> PF 2.09 IS / 1.70 OOS
        {" · "}
        <span className={fg}>Filter:</span> drop handle &gt;15d (validated)
        {" · "}
        <span className={fg}>Caps:</span> 30 Live / 50 Pending
        {" · "}
        <span className={fg}>Data:</span> Tiingo EOD+news+earnings
        {openData?.priceMeta?.asOf && (
          <>
            {" · "}
            <span className={fg}>Prices:</span>{" "}
            {openData.priceMeta.iexUnavailable ? (
              <span className="text-yellow-400">IEX unavailable — showing last close</span>
            ) : (
              <>
                {openData.priceMeta.mode === "intraday" ? "IEX intraday" : "EOD close"}
                {" as of "}
                {new Date(openData.priceMeta.asOf).toLocaleTimeString("en-US", {
                  timeZone: "America/New_York",
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                ET
              </>
            )}
          </>
        )}
      </div>

      {/* Main body */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Left: input (collapsible — so the decision output gets primary space) */}
        <div className={`${inputCollapsed ? "lg:w-9" : "lg:w-2/5"} flex flex-col border-r ${border} min-h-0 flex-shrink-0 transition-[width] duration-150`}>
          {inputCollapsed ? (
            <button
              type="button"
              onClick={() => setInputCollapsed(false)}
              title="Expand input panel"
              className={`flex-1 flex flex-col items-center gap-3 py-3 ${subFg} hover:text-orange-400`}
            >
              <PanelLeftOpen size={16} />
              <span className="[writing-mode:vertical-rl] rotate-180 text-[10px] tracking-widest">INPUT · CSV</span>
            </button>
          ) : (
          <>
          <div className={`flex items-center justify-between px-3 py-2 border-b ${border} flex-shrink-0`}>
            <span className={`text-xs font-bold ${subFg}`}>INPUT</span>
            <button
              type="button"
              onClick={() => setInputCollapsed(true)}
              title="Collapse input panel"
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${btnSecondary}`}
            >
              <PanelLeftClose size={12} /> Collapse
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className={`block text-xs mb-1 ${subFg}`}>RISK PER TRADE (USD)</label>
              <input
                type="number" min={1} step={50}
                value={riskPerTrade}
                onChange={(e) => handleRiskChange(Number(e.target.value) || DEFAULT_RISK)}
                className={`w-full px-3 py-2 rounded ${inputBg} ${inputBorder} border ${inputFg} font-mono text-sm focus:outline-none focus:border-orange-500`}
              />
              <div className={`mt-1 text-xs ${subFg}`}>Sticky — persisted across sessions.</div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className={`block text-xs ${subFg}`}>SCANNER CSV</label>
                <span className={`text-xs ${subFg}`}>
                  {rowCount > 0 ? `${rowCount} setups detected` : "no rows"}
                </span>
              </div>
              <textarea
                value={csv}
                onChange={(e) => handleCsvChange(e.target.value)}
                placeholder="Paste scanner CSV here. Required: ticker,status,handle_low_date,current_price,entry,stop,t05_target,cup_depth_pct,breakout_level"
                rows={16}
                className={`w-full px-3 py-2 rounded ${inputBg} ${inputBorder} border ${inputFg} font-mono text-xs resize-y focus:outline-none focus:border-orange-500`}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleValidate}
                disabled={isPending || rowCount === 0}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded font-bold text-sm ${btnPrimary} disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {isPending ? (
                  <><RotateCcw size={14} className="animate-spin" /> VALIDATING…</>
                ) : (
                  <><Play size={14} /> VALIDATE</>
                )}
              </button>
              <button
                onClick={handleClear}
                disabled={isPending}
                className={`px-3 py-2 rounded text-xs ${btnSecondary} disabled:opacity-50`}
              >
                CLEAR
              </button>
            </div>

            <div className={`text-xs ${subFg} leading-relaxed`}>
              v1.2 pipeline: parse → drop handle-stale → split Live/Pending → cap each → Tiingo enrichment → Claude validates both sections. Typical runtime 30-60s.
            </div>

            <div className={`text-xs ${subFg} leading-relaxed p-2 rounded ${inputBg} ${inputBorder} border`}>
              <span className={fg}>v1.2 changes:</span> Two-section output (Live + Pending). Tiingo integration for EOD prices, news headlines, and estimated earnings dates. Sector RS and cross-asset still training-data inference. Pending ranking is freshness-only (untested) — Colab pending test pending.
            </div>
          </div>
          </>
          )}
        </div>

        {/* Right: output */}
        <div className="lg:flex-1 flex flex-col min-h-0 min-w-0" style={{ maxHeight: "calc(100vh - 8rem)" }}>
          {/* Output header */}
          <div className={`flex items-center justify-between px-4 py-2 border-b ${border} flex-shrink-0`}>
            <div className={`text-xs ${subFg}`}>
              {data ? (
                <>
                  <span className={fg}>Run:</span>{" "}
                  {new Date(data.timestamp).toLocaleString()}
                  {data.tokens && (
                    <>
                      {" · "}
                      <span className={fg}>Tokens:</span>{" "}
                      {data.tokens.input.toLocaleString()} in /{" "}
                      {data.tokens.output.toLocaleString()} out
                    </>
                  )}
                  {data.degraded && (
                    <>
                      {" · "}
                      <span className="text-yellow-500">⚠ DEGRADED</span>
                    </>
                  )}
                </>
              ) : (
                <span>Output will appear here after validation runs.</span>
              )}
            </div>
            {data?.markdown && (
              <button
                onClick={handleCopy}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btnSecondary}`}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>

          {/* Filter pipeline banner — two sections */}
          {data?.filterStats && data.filterStats.inputRowCount > 0 && (
            <div className={`px-4 py-2 border-b ${border} flex-shrink-0 space-y-1`}>
              <div className="flex items-center gap-2 text-xs">
                <Filter size={12} className={fg} />
                <span className={subFg}>Pipeline:</span>
                <span className={fg}>{data.filterStats.inputRowCount}</span>
                <span className={subFg}>input</span>
              </div>
              <div className="flex items-center gap-2 text-xs pl-5">
                <span className="text-green-400 font-bold">LIVE:</span>
                <span className={subFg}>{data.filterStats.live.inputCount} →</span>
                {data.filterStats.live.droppedHandleStale > 0 && (
                  <span className="text-red-400">−{data.filterStats.live.droppedHandleStale} stale</span>
                )}
                {data.filterStats.live.droppedOverCap > 0 && (
                  <span className="text-yellow-400">−{data.filterStats.live.droppedOverCap} over cap</span>
                )}
                <span className={fg}>= {data.filterStats.live.finalCount} validated</span>
              </div>
              <div className="flex items-center gap-2 text-xs pl-5">
                <span className="text-blue-400 font-bold">PENDING:</span>
                <span className={subFg}>{data.filterStats.pending.inputCount} →</span>
                {data.filterStats.pending.droppedHandleStale > 0 && (
                  <span className="text-red-400">−{data.filterStats.pending.droppedHandleStale} stale</span>
                )}
                {data.filterStats.pending.droppedOverCap > 0 && (
                  <span className="text-yellow-400">−{data.filterStats.pending.droppedOverCap} over cap</span>
                )}
                <span className={fg}>= {data.filterStats.pending.finalCount} watching</span>
              </div>
              <div className="flex items-center gap-2 text-xs pl-5">
                <Database size={10} className={fg} />
                <span className={subFg}>Tiingo:</span>
                <span className={fg}>
                  {data.filterStats.tiingoCallsSucceeded}/{data.filterStats.tiingoCallsAttempted} setups enriched
                </span>
              </div>
            </div>
          )}

          {/* Output scroll area — vertical only; wide content (markdown tables,
              decision table) scrolls inside its OWN container, not the page. */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 min-w-0">
            {isPending && (
              <div className={`text-center ${subFg} py-12`}>
                <RotateCcw size={32} className="animate-spin mx-auto mb-3" />
                <div className="text-sm">Filtering {rowCount} setups, fetching Tiingo data, sending to Claude…</div>
                <div className="text-xs mt-2">Typical runtime: 30–60s</div>
              </div>
            )}

            {!isPending && !data && (
              <div className={`text-center ${subFg} py-12 text-sm`}>
                Paste scanner CSV on the left and click VALIDATE.
              </div>
            )}

            {!isPending && data?.error && (
              <div className="text-yellow-400 text-sm mb-4 p-3 rounded bg-yellow-950/20 border border-yellow-900">
                <div className="font-bold mb-1">⚠ {data.degraded ? "Degraded result" : "Validation error"}</div>
                <div className="text-xs">{data.error}</div>
              </div>
            )}

            {/* Interactive decision table — source of truth for user writes.
                Renders CURRENT POSITIONS (open trades from any run) + this run's
                LIVE/PENDING from the JSON decisions block. Shows even before a run
                so open positions stay reachable. */}
            {!isPending && combinedDecisions.length > 0 && (
              <JackDecisionsTable
                decisions={combinedDecisions}
                isDarkMode={isDarkMode}
                persistenceAvailable={data?.persistenceAvailable ?? openData?.persistenceAvailable ?? false}
                individualCap={individualCap}
                onExitSaved={(setupId, price, date) =>
                  setLocalExits((prev) => ({ ...prev, [setupId]: { price, date } }))
                }
              />
            )}

            {/* Raw analysis — collapsed by default, behind this toggle only. The
                expandable rows above are the sole default surface. Rendered as
                PLAIN monospace text (NOT ReactMarkdown), so the old wide Table 1/2
                can never render as an HTML <table> and character-wrap — there is
                no <table> in this view at all anymore. Copy button gives the raw
                text either way. */}
            {!isPending && data?.markdown && (
              <div className="mt-4 border-t pt-3 border-orange-900/40">
                <button
                  type="button"
                  onClick={() => setShowRaw((v) => !v)}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btnSecondary}`}
                >
                  {showRaw ? "▾ Hide raw analysis" : "▸ Raw analysis (text)"}
                </button>
                {showRaw && (
                  <pre
                    className={`mt-3 p-3 rounded text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto ${inputBg} ${inputBorder} border ${subFg}`}
                  >
                    {data.markdown}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
