"use client";

import { useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Play, RotateCcw, Copy, Check, Briefcase, Filter, Database } from "lucide-react";
import { useJackValidation } from "@/components/bloomberg/hooks/useJackValidation";

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
  const { mutate, data, isPending, reset } = useJackValidation();

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
  const proseClass = isDarkMode
    ? "prose prose-invert prose-sm max-w-none prose-table:text-orange-200 prose-th:text-orange-400 prose-th:border-orange-900 prose-td:border-orange-900 prose-strong:text-orange-300 prose-blockquote:border-orange-900 prose-blockquote:text-orange-300"
    : "prose prose-sm max-w-none";

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
        <div className={`text-xs ${subFg}`}>
          Risk/trade: <span className={fg}>${riskPerTrade.toLocaleString()}</span>
          {" · "}Indiv cap: <span className={fg}>${individualCap.toLocaleString()}</span>
          {" · "}Session cap: <span className={fg}>${sessionCap.toLocaleString()}</span>
        </div>
      </div>

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
      </div>

      {/* Main body */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Left: input */}
        <div className={`lg:w-2/5 flex flex-col border-r ${border} min-h-0`}>
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
        </div>

        {/* Right: output */}
        <div className="lg:flex-1 flex flex-col min-h-0" style={{ maxHeight: "calc(100vh - 8rem)" }}>
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

          {/* Output scroll area */}
          <div className="flex-1 overflow-y-auto overflow-x-auto p-4">
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

            {!isPending && data?.markdown && (
              <div className={proseClass}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.markdown}</ReactMarkdown>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
