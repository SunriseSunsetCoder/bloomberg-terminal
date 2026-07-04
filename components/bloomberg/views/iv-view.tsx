"use client";

import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import {
  useIVRegime,
  ivRegimeColor,
  ivRegimeBg,
  termStructureColor,
  type OptionsSignalResponse,
} from "../hooks/useIVRegime";

interface IVViewProps {
  isDarkMode: boolean;
  onBack: () => void;
}

export function IVView({ isDarkMode, onBack }: IVViewProps) {
  const { data: regime, isLoading, error, refetch } = useIVRegime();
  const [ticker, setTicker] = useState("SPY");
  const [signal, setSignal] = useState<OptionsSignalResponse | null>(null);
  const [signalLoading, setSignalLoading] = useState(false);
  const [signalError, setSignalError] = useState<string | null>(null);

  const fetchSignal = async (forceRefresh = false) => {
    setSignalLoading(true);
    setSignalError(null);
    try {
      const url = `/api/options-signal?ticker=${encodeURIComponent(ticker.toUpperCase())}${forceRefresh ? "&refresh=1" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok && !data.regime) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSignal(data);
    } catch (e) {
      setSignalError(e instanceof Error ? e.message : String(e));
    } finally {
      setSignalLoading(false);
    }
  };

  const bgClass = isDarkMode ? "bg-black" : "bg-gray-100";
  const textClass = isDarkMode ? "text-amber-300" : "text-gray-900";

  if (isLoading) {
    return (
      <div className={`${bgClass} ${textClass} font-mono p-6 min-h-screen`}>
        <BackBar onBack={onBack} isDarkMode={isDarkMode} />
        <div className="text-amber-400 mt-4">Loading IV regime...</div>
      </div>
    );
  }

  if (error || !regime) {
    return (
      <div className={`${bgClass} ${textClass} font-mono p-6 min-h-screen`}>
        <BackBar onBack={onBack} isDarkMode={isDarkMode} />
        <div className="text-red-400 mt-4">
          IV regime unavailable: {error instanceof Error ? error.message : "unknown error"}
          <button
            onClick={() => refetch()}
            className="ml-4 px-3 py-1 bg-amber-900 hover:bg-amber-800 text-amber-100 border border-amber-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`${bgClass} ${textClass} font-mono min-h-screen`}>
      <BackBar onBack={onBack} isDarkMode={isDarkMode} />

      <div className="p-4 text-sm">
        {/* Top strip: VIX / IV Rank / IV Pct / Term Ratio */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <MetricCell label="VIX" value={regime.vix.toFixed(2)} />
          <MetricCell
            label="IV RANK"
            value={`${regime.ivRank.toFixed(1)}%`}
            tone={regime.ivRank > 60 ? "warn" : regime.ivRank < 30 ? "good" : "neutral"}
          />
          <MetricCell
            label="IV PCT"
            value={`${regime.ivPercentile.toFixed(1)}%`}
            tone={regime.ivPercentile > 60 ? "warn" : regime.ivPercentile < 30 ? "good" : "neutral"}
          />
          <div className="border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-xs text-zinc-500 mb-1">TERM {regime.termStructureSource}</div>
            <div className={`text-xl font-bold ${termStructureColor(regime.termStructureState)}`}>
              {regime.termStructureRatio.toFixed(3)}
            </div>
            <div className={`text-xs ${termStructureColor(regime.termStructureState)}`}>
              {regime.termStructureState}
            </div>
          </div>
        </div>

        {/* Regime badge */}
        <div className={`border-2 ${ivRegimeBg(regime.regime)} p-4 mb-4`}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-zinc-400 mb-1">IV REGIME</div>
              <div className={`text-3xl font-bold ${ivRegimeColor(regime.regime)}`}>
                {regime.regime.replace("_", " ")}
              </div>
              <div className="text-xs text-zinc-500 mt-1">
                Confidence {(regime.confidence * 100).toFixed(0)}%
                {regime.degraded && (
                  <span className="ml-2 text-amber-500">
                    [DEGRADED: n={regime.sampleSize}, src={regime.termStructureSource}]
                  </span>
                )}
              </div>
            </div>
            <div className="text-right text-xs text-zinc-500">
              <div>VIX3M: {regime.vix3m ?? "—"}</div>
              <div>VIX9D: {regime.vix9d ?? "—"}</div>
              <div className="mt-1">{new Date(regime.timestamp).toLocaleString()}</div>
            </div>
          </div>
        </div>

        {/* Options signal panel */}
        <div className="border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs text-zinc-400">TICKER</span>
            <input
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              className="bg-black border border-zinc-700 px-2 py-1 text-amber-300 w-24 uppercase"
              maxLength={6}
            />
            <button
              onClick={() => fetchSignal(false)}
              disabled={signalLoading}
              className="px-4 py-1 bg-amber-900 hover:bg-amber-800 disabled:opacity-50 text-amber-100 border border-amber-700"
            >
              {signalLoading ? "..." : "GET SIGNAL"}
            </button>
            {signal && (
              <button
                onClick={() => fetchSignal(true)}
                disabled={signalLoading}
                className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 border border-zinc-700 text-xs"
              >
                ↻
              </button>
            )}
          </div>

          {signalError && (
            <div className="text-red-400 text-xs mb-2">Error: {signalError}</div>
          )}

          {signal?.ivProxyNote && (
            <div className="text-amber-500 text-xs mb-2">⚠ {signal.ivProxyNote}</div>
          )}

          {signal?.signal ? (
            <SignalBlock signal={signal.signal} ticker={signal.ticker} fromCache={signal.fromCache} />
          ) : signal && !signal.signal ? (
            <div className="text-amber-400 text-xs">
              Strategy generation unavailable. Regime data: {signal.regime?.regime}. {signal.error}
            </div>
          ) : (
            <div className="text-zinc-500 text-xs">
              Enter ticker and click GET SIGNAL for Claude-generated options strategy.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BackBar({ onBack, isDarkMode }: { onBack: () => void; isDarkMode: boolean }) {
  const barBg = isDarkMode ? "bg-zinc-950 border-zinc-800" : "bg-gray-200 border-gray-300";
  return (
    <div className={`flex items-center gap-2 px-3 py-2 border-b ${barBg}`}>
      <button
        onClick={onBack}
        className="flex items-center gap-1 px-2 py-1 bg-amber-900 hover:bg-amber-800 text-amber-100 border border-amber-700 text-xs"
      >
        <ArrowLeft className="h-3 w-3" />
        BACK
      </button>
      <span className="text-xs text-zinc-500 uppercase tracking-wider">IV Regime &amp; Options Signal</span>
    </div>
  );
}

function MetricCell({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "neutral";
}) {
  const color =
    tone === "good" ? "text-green-400" : tone === "warn" ? "text-red-400" : "text-amber-300";
  return (
    <div className="border border-zinc-800 bg-zinc-950 p-3">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function SignalBlock({
  signal,
  ticker,
  fromCache,
}: {
  signal: OptionsSignalResponse["signal"];
  ticker: string;
  fromCache?: boolean;
}) {
  if (!signal) return null;
  const fitColor =
    signal.regimeFit === "STRONG"
      ? "text-green-400"
      : signal.regimeFit === "MODERATE"
        ? "text-amber-400"
        : "text-red-400";
  const dirColor =
    signal.direction === "SHORT_VOL"
      ? "text-green-400"
      : signal.direction === "LONG_VOL"
        ? "text-red-400"
        : "text-amber-300";

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3">
        <div className="text-2xl font-bold text-amber-300">{signal.strategy}</div>
        <div className={`text-xs ${dirColor}`}>{signal.direction.replace("_", " ")}</div>
        <div className={`text-xs ${fitColor}`}>FIT: {signal.regimeFit}</div>
        {fromCache && <div className="text-xs text-zinc-600">[cached]</div>}
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <span className="text-zinc-500">STRIKES:</span>{" "}
          <span className="text-amber-300">{signal.strikeRule}</span>
        </div>
        <div>
          <span className="text-zinc-500">DTE:</span>{" "}
          <span className="text-amber-300">{signal.dteBand}</span>
        </div>
        <div>
          <span className="text-zinc-500">SIZING:</span>{" "}
          <span className="text-amber-300">{signal.sizing}</span>
        </div>
      </div>
      <div className="text-xs text-zinc-300 pt-2 border-t border-zinc-800">
        <span className="text-zinc-500">Rationale ({ticker}):</span> {signal.rationale}
      </div>
      {signal.warnings && signal.warnings.length > 0 && (
        <div className="text-xs text-amber-500 pt-1">
          {signal.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}
