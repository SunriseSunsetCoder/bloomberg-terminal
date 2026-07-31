"use client";

import { useCallback, useState } from "react";
import { ArrowLeft, Gauge, RotateCcw, RefreshCw, AlertTriangle, Info } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useJackScorecard } from "@/components/bloomberg/hooks/useJackScorecard";
import { LOW_SAMPLE_THRESHOLD, type RStat } from "@/lib/jack/analytics";
import type { RefStat } from "@/lib/jack/backtest-reference";

interface Props {
  isDarkMode?: boolean;
  onBack?: () => void;
  onAnalyticsClick?: () => void;
}

const LS_KEY_RISK = "jack.riskPerTrade"; // shared with the JACK view (sticky)
const DEFAULT_RISK = 2000;

const fmtR = (x: number | null | undefined) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`);
const fmtPct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
const fmtPf = (x: number | null | undefined) => (x == null ? "∞" : x.toFixed(2));
const fmtUsd = (x: number | null | undefined) =>
  x == null ? "—" : `${x < 0 ? "-" : ""}$${Math.abs(Math.round(x)).toLocaleString()}`;
const rColor = (x: number | null | undefined) => (x == null ? "" : x >= 0 ? "text-green-400" : "text-red-400");

export function JackScorecardView({ isDarkMode = true, onBack, onAnalyticsClick }: Props) {
  const [riskPerTrade, setRiskPerTrade] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_RISK;
    const stored = window.localStorage.getItem(LS_KEY_RISK);
    const n = stored ? Number(stored) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RISK;
  });
  const { data, isLoading, isFetching, refetch } = useJackScorecard(riskPerTrade);

  // Sticky, shared with the JACK view — rescales the $ axis only (R math is
  // risk-independent, so no metric changes).
  const handleRisk = useCallback((next: number) => {
    const v = Number.isFinite(next) && next > 0 ? next : DEFAULT_RISK;
    setRiskPerTrade(v);
    if (typeof window !== "undefined") window.localStorage.setItem(LS_KEY_RISK, String(v));
  }, []);

  const bg = isDarkMode ? "bg-black" : "bg-white";
  const fg = isDarkMode ? "text-orange-400" : "text-orange-700";
  const subFg = isDarkMode ? "text-gray-400" : "text-gray-600";
  const border = isDarkMode ? "border-orange-900/60" : "border-orange-200";
  const cardBg = isDarkMode ? "bg-gray-950/50" : "bg-gray-50";
  const inputBg = isDarkMode ? "bg-gray-950" : "bg-gray-50";
  const inputBorder = isDarkMode ? "border-gray-800" : "border-gray-300";
  const btnSecondary = isDarkMode
    ? "bg-gray-900 hover:bg-gray-800 text-orange-300 border border-gray-800"
    : "bg-white hover:bg-gray-100 text-gray-800 border border-gray-300";
  const hairline = isDarkMode ? "bg-orange-900/50" : "bg-orange-200";

  const s = data?.scorecard;

  const SectionTitle = ({ n, title, sub }: { n: string; title: string; sub?: string }) => (
    <div className="flex items-center gap-2 mt-5 mb-2">
      <span className={`text-[11px] font-bold ${fg} tracking-widest`}>
        {n}. {title}
      </span>
      {sub && <span className={`text-[10px] ${subFg}`}>{sub}</span>}
      <div className={`flex-1 h-px ${hairline}`} />
    </div>
  );

  // SMALL-N HONESTY: under the threshold a bucket shows "INSUFFICIENT DATA — n" in
  // place of a headline number. The raw figures still render, demoted and muted, so
  // nothing is hidden — but no PF gets to look like a result off a handful of trades.
  const insufficient = (n: number) => (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-400 border border-red-600 bg-red-950/30 rounded px-1.5 py-0.5">
      <AlertTriangle size={10} /> INSUFFICIENT DATA — {n} trade{n === 1 ? "" : "s"}
    </span>
  );
  const nBadge = (st: RStat) =>
    st.lowSample ? insufficient(st.n) : <span className="text-[10px] font-bold text-green-400">n={st.n} ✓</span>;

  /** Headline stat card with the frozen reference beside each metric. */
  const StatCard = ({
    label,
    st,
    ref: reference,
    extra,
  }: {
    label: string;
    st: RStat;
    ref?: RefStat | null;
    extra?: React.ReactNode;
  }) => (
    <div className={`rounded border ${border} ${cardBg} p-2.5 min-w-[190px] flex-1`}>
      <div className={`text-[10px] uppercase tracking-widest ${subFg} mb-1`}>{label}</div>
      <div className="mb-1.5">{nBadge(st)}</div>
      <div className="grid grid-cols-3 gap-x-2 text-[11px]">
        <div>
          <div className={subFg}>win</div>
          <div className={`font-bold ${st.lowSample ? "opacity-50" : ""} ${fg}`}>{fmtPct(st.winRate)}</div>
          {reference && <div className={`text-[9px] ${subFg}`}>ref {fmtPct(reference.winRate)}</div>}
        </div>
        <div>
          <div className={subFg}>avg R</div>
          <div className={`font-bold ${st.lowSample ? "opacity-50" : ""} ${rColor(st.avgR)}`}>{fmtR(st.avgR)}</div>
          {reference && <div className={`text-[9px] ${subFg}`}>ref {fmtR(reference.avgR)}</div>}
        </div>
        <div>
          <div className={subFg}>PF</div>
          <div className={`font-bold ${st.lowSample ? "opacity-50" : ""} ${fg}`}>{fmtPf(st.pf)}</div>
          {reference && <div className={`text-[9px] ${subFg}`}>ref {reference.pf.toFixed(2)}</div>}
        </div>
      </div>
      {extra}
    </div>
  );

  /** One row of a cut table — muted when under-sampled, with the gate label inline. */
  const cutRow = (key: string, st: RStat, reference?: RefStat | null) => (
    <tr key={key} className={`border-t ${border} ${st.lowSample ? "opacity-60" : ""}`}>
      <td className={`px-1.5 py-0.5 ${fg}`}>{key}</td>
      <td className="px-1.5 py-0.5 text-right">{st.n}</td>
      <td className="px-1.5 py-0.5 text-right">{fmtPct(st.winRate)}</td>
      <td className={`px-1.5 py-0.5 text-right font-bold ${rColor(st.avgR)}`}>{fmtR(st.avgR)}</td>
      <td className="px-1.5 py-0.5 text-right">{fmtPf(st.pf)}</td>
      <td className={`px-1.5 py-0.5 text-right text-[10px] ${subFg}`}>
        {reference ? `${fmtPct(reference.winRate)} / ${fmtR(reference.avgR)} / ${reference.pf.toFixed(2)}` : "—"}
      </td>
      <td className="px-1.5 py-0.5 text-[10px]">
        {st.n === 0 ? (
          <span className={subFg}>no trades</span>
        ) : st.lowSample ? (
          <span className="text-red-400 font-bold">INSUFFICIENT DATA — {st.n}</span>
        ) : (
          <span className="text-green-400">✓</span>
        )}
      </td>
    </tr>
  );

  const cutHead = (first: string, refLabel = "reference (OOS)") => (
    <thead>
      <tr className={subFg}>
        <th className="text-left px-1.5 py-0.5 font-normal">{first}</th>
        <th className="text-right px-1.5 py-0.5 font-normal">n</th>
        <th className="text-right px-1.5 py-0.5 font-normal">win</th>
        <th className="text-right px-1.5 py-0.5 font-normal">avg R</th>
        <th className="text-right px-1.5 py-0.5 font-normal">PF</th>
        <th className="text-right px-1.5 py-0.5 font-normal">{refLabel}</th>
        <th className="text-left px-1.5 py-0.5 font-normal">sample</th>
      </tr>
    </thead>
  );

  return (
    <div
      className={`flex flex-col w-full ${bg} ${fg} font-mono text-sm overflow-hidden`}
      style={{ height: "calc(100vh - 4rem)" }}
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${border} flex-shrink-0`}>
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btnSecondary}`}>
              <ArrowLeft size={14} /> BACK
            </button>
          )}
          <div className="flex items-center gap-2">
            <Gauge size={16} />
            <span className="font-bold tracking-wider">JACK SCORECARD</span>
            <span className={`text-xs ${subFg}`}>live realized edge · AI overlay value</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className={`text-[11px] ${subFg} flex items-center gap-1`}>
            risk/trade
            <input
              type="number"
              min={1}
              step={50}
              value={riskPerTrade}
              onChange={(e) => handleRisk(Number(e.target.value))}
              title="Rescales the $ equity curve only — all R math is risk-independent. Sticky, shared with the JACK view."
              className={`w-24 px-1.5 py-0.5 rounded ${inputBg} ${inputBorder} border ${fg} font-mono text-[11px] focus:outline-none focus:border-orange-500`}
            />
          </label>
          {onAnalyticsClick && (
            <button onClick={onAnalyticsClick} className={`px-2 py-1 rounded text-xs ${btnSecondary}`}>
              JANLY →
            </button>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btnSecondary} disabled:opacity-50`}
          >
            {isFetching ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> …
              </>
            ) : (
              <>
                <RefreshCw size={12} /> REFRESH
              </>
            )}
          </button>
          {s && <span className={`text-xs ${subFg}`}>as of {s.generatedAt}</span>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 min-w-0">
        {isLoading && (
          <div className={`text-center ${subFg} py-12`}>
            <RotateCcw size={28} className="animate-spin mx-auto mb-2" /> Loading scorecard…
          </div>
        )}

        {!isLoading && data && !data.persistenceAvailable && (
          <div className="text-yellow-400 text-sm p-3 rounded bg-yellow-950/20 border border-yellow-900">
            <b>Scorecard disabled</b> — {data.reason ?? "persistence unavailable"} (runs on the VPS/localhost only).
          </div>
        )}
        {!isLoading && data?.error && (
          <div className="text-red-400 text-sm p-3 rounded bg-red-950/20 border border-red-900">Error: {data.error}</div>
        )}

        {!isLoading && s && (
          <>
            {/* Universe counts */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] mb-2">
              <span className={subFg}>
                setups w/ outcome <b className={fg}>{s.totals.withOutcome}</b>
              </span>
              <span className={subFg}>
                resolved <b className={fg}>{s.totals.resolved}</b>
              </span>
              <span className={subFg}>
                never-fired <b className={fg}>{s.totals.neverFired}</b>
              </span>
              <span className={subFg}>
                open (excluded) <b className={fg}>{s.totals.open}</b>
              </span>
              <span className={subFg}>
                closed live trades <b className={fg}>{s.totals.realizedTrades}</b>
              </span>
            </div>

            {/* THE metric warning — two different PFs, never comparable */}
            <div className={`text-[10px] ${subFg} border ${border} ${cardBg} rounded px-2.5 py-1.5 mb-2 leading-relaxed`}>
              <Info size={11} className="inline mr-1" />
              <b className={fg}>Two different PFs — do not compare them.</b> Live realized R is measured against the{" "}
              <b>raw-R reference</b> (PF {s.reference.rawR.overall.pf.toFixed(2)}, avg{" "}
              {fmtR(s.reference.rawR.overall.avgR)}, win {fmtPct(s.reference.rawR.overall.winRate)}) — basis:{" "}
              {s.reference.rawR.basis}. The headline{" "}
              <b>
                PF {s.reference.capacitySim.is.toFixed(2)} IS / {s.reference.capacitySim.oos.toFixed(2)} OOS
              </b>{" "}
              is the {s.reference.capacitySim.label} — a different computation. {s.reference.capacitySim.note}
            </div>

            {/* ================= (A) LIVE REALIZED ================= */}
            <SectionTitle n="A" title="LIVE REALIZED" sub="your closed trades, realized R — open positions excluded" />

            {s.totals.realizedTrades === 0 ? (
              <div className={`text-[11px] ${subFg}`}>
                No closed live trades yet. Record an exit on a TRADED position and it lands here.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <StatCard
                    label="realized (your fills)"
                    st={s.live.realized}
                    ref={s.reference.rawR.overall}
                    extra={
                      <div className={`mt-1.5 pt-1.5 border-t ${border} grid grid-cols-2 gap-x-2 text-[10px]`}>
                        <div>
                          <div className={subFg}>total</div>
                          <div className={`font-bold ${rColor(s.live.totalR)}`}>
                            {fmtR(s.live.totalR)} · {fmtUsd(s.live.totalUsd)}
                          </div>
                        </div>
                        <div>
                          <div className={subFg}>expectancy/trade</div>
                          <div className={`font-bold ${rColor(s.live.expectancyR)}`}>
                            {fmtR(s.live.expectancyR)} · {fmtUsd(s.live.expectancyUsd)}
                          </div>
                        </div>
                      </div>
                    }
                  />
                  <StatCard
                    label="same trades, theoretical R"
                    st={s.live.theoretical}
                    extra={
                      <div className={`mt-1.5 text-[9px] ${subFg} leading-snug`}>
                        what the setups offered vs what you got — the gap is execution, not edge.
                      </div>
                    }
                  />
                  <div className={`rounded border ${border} ${cardBg} p-2.5 min-w-[150px]`}>
                    <div className={`text-[10px] uppercase tracking-widest ${subFg} mb-1`}>drawdown</div>
                    <div className="text-[11px] mt-2">
                      <div className={subFg}>max</div>
                      <div className="font-bold text-red-400">-{s.live.maxDrawdownR.toFixed(2)}R</div>
                      <div className={`${subFg} mt-1`}>current</div>
                      <div className={`font-bold ${s.live.currentDrawdownR > 0 ? "text-red-400" : "text-green-400"}`}>
                        -{s.live.currentDrawdownR.toFixed(2)}R
                      </div>
                    </div>
                  </div>
                </div>

                {/* Equity curve — cumulative R, $ on the tooltip */}
                <div className="h-48 w-full mt-3 relative">
                  {s.live.realized.lowSample && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                      <span className="text-red-400/70 text-[11px] font-bold tracking-widest border border-red-700/60 rounded px-2 py-1 bg-black/40">
                        n={s.live.realized.n} — NOT STATISTICALLY MEANINGFUL
                      </span>
                    </div>
                  )}
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={s.live.curve} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#3f2d17" : "#f0e0c0"} />
                      <XAxis dataKey="date" tick={{ fill: isDarkMode ? "#9ca3af" : "#6b7280", fontSize: 10 }} />
                      <YAxis tick={{ fill: isDarkMode ? "#9ca3af" : "#6b7280", fontSize: 10 }} />
                      <ReferenceLine y={0} stroke={isDarkMode ? "#6b7280" : "#9ca3af"} />
                      <Tooltip
                        contentStyle={{
                          background: isDarkMode ? "#0a0a0a" : "#fff",
                          border: "1px solid #7c2d12",
                          fontSize: 11,
                        }}
                        formatter={(v: number, _n, p: { payload?: { ticker?: string; r?: number; cumUsd?: number } }) => [
                          `${v?.toFixed?.(2)}R (${fmtUsd(p?.payload?.cumUsd)}) · ${p?.payload?.ticker} ${fmtR(p?.payload?.r)}`,
                          "cumulative",
                        ]}
                      />
                      <Line type="monotone" dataKey="cumR" stroke="#fb923c" strokeWidth={2} dot={{ r: 3, fill: "#fb923c" }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className={`text-[10px] ${subFg} mt-1`}>
                  Cumulative realized R by exit date · $ at {fmtUsd(riskPerTrade)} risk/trade.
                </div>

                {/* By tier */}
                <div className="overflow-x-auto mt-3">
                  <table className="text-[11px] w-full">
                    {cutHead("tier")}
                    <tbody>
                      {s.live.byTier.map((t) => cutRow(t.key, t.stat, t.reference))}
                    </tbody>
                  </table>
                </div>
                <div className={`text-[10px] ${subFg} mt-1`}>
                  Does live preserve the backtest's tier ordering (Q5 &gt; Q4 &gt; Q3)? Reference column is the OOS bar.
                </div>

                {/* By P-rank */}
                <div className="overflow-x-auto mt-3">
                  <table className="text-[11px] w-full">
                    {cutHead("P-rank", "—")}
                    <tbody>{s.live.byPRank.map((p) => cutRow(p.key, p.stat, null))}</tbody>
                  </table>
                </div>
                <div className={`text-[10px] ${subFg} mt-1`}>
                  P-rank is <b>recomputed</b> from each run's priority values (rank 1 = highest priority). The live board
                  additionally skipped rows already marked TRADED, so a rank here can sit one or two above what was on
                  screen at the time. No backtest reference exists for P-rank.
                </div>
              </>
            )}

            {/* ================= (B) AI OVERLAY ================= */}
            <SectionTitle
              n="B"
              title="AI DECISION OVERLAY"
              sub="paper outcomes over ALL validated setups, grouped by the AI's latest LIVE call"
            />

            <div className="overflow-x-auto">
              <table className="text-[11px] w-full">
                <thead>
                  <tr className={subFg}>
                    <th className="text-left px-1.5 py-0.5 font-normal">AI call</th>
                    <th className="text-right px-1.5 py-0.5 font-normal">n resolved</th>
                    <th className="text-right px-1.5 py-0.5 font-normal">win</th>
                    <th className="text-right px-1.5 py-0.5 font-normal">avg R</th>
                    <th className="text-right px-1.5 py-0.5 font-normal">PF</th>
                    <th className="text-right px-1.5 py-0.5 font-normal">never fired</th>
                    <th className="text-left px-1.5 py-0.5 font-normal">sample</th>
                  </tr>
                </thead>
                <tbody>
                  {s.ai.buckets.map((b) => (
                    <tr key={b.key} className={`border-t ${border} ${b.stat.lowSample ? "opacity-60" : ""}`}>
                      <td className={`px-1.5 py-0.5 ${fg}`}>{b.key}</td>
                      <td className="px-1.5 py-0.5 text-right">{b.stat.n}</td>
                      <td className="px-1.5 py-0.5 text-right">{fmtPct(b.stat.winRate)}</td>
                      <td className={`px-1.5 py-0.5 text-right font-bold ${rColor(b.stat.avgR)}`}>{fmtR(b.stat.avgR)}</td>
                      <td className="px-1.5 py-0.5 text-right">{fmtPf(b.stat.pf)}</td>
                      <td className={`px-1.5 py-0.5 text-right ${subFg}`}>{b.neverFired}</td>
                      <td className="px-1.5 py-0.5 text-[10px]">
                        {b.stat.n === 0 ? (
                          <span className={subFg}>no data</span>
                        ) : b.stat.lowSample ? (
                          <span className="text-red-400 font-bold">INSUFFICIENT DATA — {b.stat.n}</span>
                        ) : (
                          <span className="text-green-400">✓</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* The read — or the reason there isn't one */}
            <div className="mt-2">
              {s.ai.readSuppressed ? (
                <div className="text-[11px] text-red-300 border border-red-700 bg-red-950/30 rounded px-2.5 py-1.5">
                  <AlertTriangle size={11} className="inline mr-1" />
                  <b>No read yet.</b> The TRADE-vs-SKIP comparison stays suppressed until both arms clear n≥
                  {LOW_SAMPLE_THRESHOLD}
                  {s.ai.insufficient.length > 0 && <> — still short: {s.ai.insufficient.join(", ")}</>}. Numbers above are
                  raw, directional at best.
                </div>
              ) : (
                <div className={`text-[11px] border ${border} ${cardBg} rounded px-2.5 py-1.5 ${fg}`}>{s.ai.read}</div>
              )}
            </div>

            {/* Signals-disagree cut */}
            <div className="overflow-x-auto mt-3">
              <table className="text-[11px] w-full">
                {cutHead("signals-disagree cut", "—")}
                <tbody>
                  {cutRow("flagged (hard conflict)", s.ai.disagree.flagged, null)}
                  {cutRow("agreed", s.ai.disagree.agreed, null)}
                  {cutRow("AI TRADE + handle SKIP", s.ai.disagree.tradeVsHandleSkip, null)}
                  {cutRow("AI SKIP + handle FULL", s.ai.disagree.skipVsHandleFull, null)}
                </tbody>
              </table>
            </div>
            <div className={`text-[10px] ${subFg} mt-1`}>
              Only hard contradictions are flagged (analysis TRADE vs handle SKIP, analysis SKIP vs handle FULL) — the
              same rule the board renders the ⚠ with.
            </div>

            {/* Pending-section calls — informational */}
            {s.ai.pendingBuckets.length > 0 && (
              <>
                <div className={`text-[10px] ${subFg} mt-4 mb-1`}>
                  PENDING-section calls (watchlist states, not trade verdicts — kept out of the comparison above):
                </div>
                <div className="overflow-x-auto">
                  <table className="text-[11px] w-full">
                    {cutHead("pending call", "—")}
                    <tbody>{s.ai.pendingBuckets.map((b) => cutRow(b.key, b.stat, null))}</tbody>
                  </table>
                </div>
              </>
            )}

            {/* Assumptions — the paper numbers are only as good as these */}
            <SectionTitle n="C" title="PAPER-OUTCOME ASSUMPTIONS" sub="what the (B) numbers actually model" />
            <ul className={`text-[10px] ${subFg} space-y-0.5 list-disc pl-4`}>
              {s.paperAssumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            <div className={`text-[10px] ${subFg} mt-2 mb-4`}>
              A setup validated in several runs is counted ONCE, under the AI's most recent call. Read-only view — nothing
              here changes strategy, sizing, selection, alerts, or a validation run.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
