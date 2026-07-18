"use client";

import { ArrowLeft, BarChart3, RotateCcw, RefreshCw, AlertTriangle } from "lucide-react";
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
import { useJackAnalytics } from "@/components/bloomberg/hooks/useJackAnalytics";
import { LOW_SAMPLE_THRESHOLD, type RStat } from "@/lib/jack/analytics";

interface Props {
  isDarkMode?: boolean;
  onBack?: () => void;
}

const fmtR = (x: number | null | undefined) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`);
const fmtPct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
const fmtPf = (x: number | null | undefined) => (x == null ? "∞" : x.toFixed(2)); // null = no losers
const rColor = (x: number | null | undefined) => (x == null ? "" : x >= 0 ? "text-green-400" : "text-red-400");

export function JackAnalyticsView({ isDarkMode = true, onBack }: Props) {
  const { data, isLoading, isFetching, refetch } = useJackAnalytics();

  const bg = isDarkMode ? "bg-black" : "bg-white";
  const fg = isDarkMode ? "text-orange-400" : "text-orange-700";
  const subFg = isDarkMode ? "text-gray-400" : "text-gray-600";
  const border = isDarkMode ? "border-orange-900/60" : "border-orange-200";
  const cardBg = isDarkMode ? "bg-gray-950/50" : "bg-gray-50";
  const btnSecondary = isDarkMode
    ? "bg-gray-900 hover:bg-gray-800 text-orange-300 border border-gray-800"
    : "bg-white hover:bg-gray-100 text-gray-800 border border-gray-300";
  const hairline = isDarkMode ? "bg-orange-900/50" : "bg-orange-200";

  const a = data?.analytics;

  const lowSampleBadge = (lowSample: boolean, n: number) =>
    lowSample ? (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-400 border border-red-600 bg-red-950/30 rounded px-1.5 py-0.5">
        <AlertTriangle size={10} /> LOW SAMPLE n={n} &lt;{LOW_SAMPLE_THRESHOLD} — not reliable
      </span>
    ) : (
      <span className="text-[10px] font-bold text-green-400">n={n} ✓</span>
    );

  const StatCard = ({ label, s, accent }: { label: string; s: RStat; accent?: string }) => (
    <div className={`rounded border ${border} ${cardBg} p-2.5 min-w-[150px]`}>
      <div className={`text-[10px] uppercase tracking-widest ${accent ?? subFg} mb-1`}>{label}</div>
      <div className="mb-1.5">{lowSampleBadge(s.lowSample, s.n)}</div>
      <div className="grid grid-cols-3 gap-x-2 text-[11px]">
        <div>
          <div className={subFg}>win</div>
          <div className={`font-bold ${fg}`}>{fmtPct(s.winRate)}</div>
        </div>
        <div>
          <div className={subFg}>avg R</div>
          <div className={`font-bold ${rColor(s.avgR)}`}>{fmtR(s.avgR)}</div>
        </div>
        <div>
          <div className={subFg}>PF</div>
          <div className={`font-bold ${fg}`}>{fmtPf(s.pf)}</div>
        </div>
      </div>
    </div>
  );

  const SectionTitle = ({ n, title, sub }: { n: number; title: string; sub?: string }) => (
    <div className="flex items-center gap-2 mt-5 mb-2">
      <span className={`text-[11px] font-bold ${fg} tracking-widest`}>
        {n}. {title}
      </span>
      {sub && <span className={`text-[10px] ${subFg}`}>{sub}</span>}
      <div className={`flex-1 h-px ${hairline}`} />
    </div>
  );

  return (
    <div className={`flex flex-col w-full ${bg} ${fg} font-mono text-sm overflow-hidden`} style={{ height: "calc(100vh - 4rem)" }}>
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${border} flex-shrink-0`}>
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btnSecondary}`}>
              <ArrowLeft size={14} /> BACK
            </button>
          )}
          <div className="flex items-center gap-2">
            <BarChart3 size={16} />
            <span className="font-bold tracking-wider">JACK ANALYTICS</span>
            <span className={`text-xs ${subFg}`}>edge-decay · selection value · execution quality</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => refetch()} disabled={isFetching} className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btnSecondary} disabled:opacity-50`}>
            {isFetching ? <><RefreshCw size={12} className="animate-spin" /> …</> : <><RefreshCw size={12} /> REFRESH</>}
          </button>
          {a && <span className={`text-xs ${subFg}`}>as of {a.generatedAt}</span>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 min-w-0">
        {isLoading && (
          <div className={`text-center ${subFg} py-12`}>
            <RotateCcw size={28} className="animate-spin mx-auto mb-2" /> Loading analytics…
          </div>
        )}

        {!isLoading && data && !data.persistenceAvailable && (
          <div className="text-yellow-400 text-sm p-3 rounded bg-yellow-950/20 border border-yellow-900">
            <b>Analytics disabled</b> — {data.reason ?? "persistence unavailable"} (runs on the VPS/localhost only).
          </div>
        )}
        {!isLoading && data?.error && (
          <div className="text-red-400 text-sm p-3 rounded bg-red-950/20 border border-red-900">Error: {data.error}</div>
        )}

        {!isLoading && a && (
          <>
            {/* Totals + global low-sample warning */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] mb-2">
              <span className={subFg}>setups w/ outcome <b className={fg}>{a.totals.withOutcome}</b></span>
              <span className={subFg}>resolved <b className={fg}>{a.totals.resolved}</b></span>
              <span className={subFg}>never-fired <b className={fg}>{a.totals.neverFired}</b></span>
              <span className={subFg}>open <b className={fg}>{a.totals.open}</b></span>
            </div>
            {a.totals.resolved < LOW_SAMPLE_THRESHOLD && (
              <div className="text-[11px] text-red-300 border border-red-700 bg-red-950/30 rounded px-2.5 py-1.5 mb-2">
                <AlertTriangle size={11} className="inline mr-1" />
                <b>LOW SAMPLE across the board</b> — only {a.totals.resolved} resolved trade(s) (need ≥{LOW_SAMPLE_THRESHOLD}).
                Every stat below is directional at best; verdicts are suppressed. First trustworthy read is many months out.
              </div>
            )}

            {/* View 1 — Edge over time */}
            <SectionTitle n={1} title="EDGE OVER TIME" sub="all resolved setups, theoretical R, quarterly by setup date" />
            {a.edgeOverTime.length === 0 ? (
              <div className={`text-[11px] ${subFg}`}>No resolved setups yet.</div>
            ) : (
              <>
                <div className="h-44 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={a.edgeOverTime.map((b) => ({ bucket: b.bucket, avgR: b.avgR, n: b.n }))} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#3f2d17" : "#f0e0c0"} />
                      <XAxis dataKey="bucket" tick={{ fill: isDarkMode ? "#9ca3af" : "#6b7280", fontSize: 10 }} />
                      <YAxis tick={{ fill: isDarkMode ? "#9ca3af" : "#6b7280", fontSize: 10 }} />
                      <ReferenceLine y={0} stroke={isDarkMode ? "#6b7280" : "#9ca3af"} />
                      <Tooltip
                        contentStyle={{ background: isDarkMode ? "#0a0a0a" : "#fff", border: "1px solid #7c2d12", fontSize: 11 }}
                        formatter={(v: number, _n, p: { payload?: { n?: number } }) => [`${v?.toFixed?.(2)}R (n=${p?.payload?.n})`, "avg R"]}
                      />
                      <Line type="monotone" dataKey="avgR" stroke="#fb923c" strokeWidth={2} dot={{ r: 3, fill: "#fb923c" }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-x-auto mt-1">
                  <table className="text-[11px] w-full">
                    <thead>
                      <tr className={subFg}>
                        <th className="text-left px-1.5 py-0.5 font-normal">Quarter</th>
                        <th className="text-right px-1.5 py-0.5 font-normal">n</th>
                        <th className="text-right px-1.5 py-0.5 font-normal">win</th>
                        <th className="text-right px-1.5 py-0.5 font-normal">avg R</th>
                        <th className="text-right px-1.5 py-0.5 font-normal">PF</th>
                        <th className="text-left px-1.5 py-0.5 font-normal">flag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.edgeOverTime.map((b) => (
                        <tr key={b.bucket} className={`border-t ${border}`}>
                          <td className={`px-1.5 py-0.5 ${fg}`}>{b.bucket}</td>
                          <td className="px-1.5 py-0.5 text-right">{b.n}</td>
                          <td className="px-1.5 py-0.5 text-right">{fmtPct(b.winRate)}</td>
                          <td className={`px-1.5 py-0.5 text-right font-bold ${rColor(b.avgR)}`}>{fmtR(b.avgR)}</td>
                          <td className="px-1.5 py-0.5 text-right">{fmtPf(b.pf)}</td>
                          <td className="px-1.5 py-0.5">{b.lowSample && <span className="text-red-400 text-[10px]">⚠ low</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* View 2 — Handle-score forward test (spec Part D) */}
            <SectionTitle
              n={2}
              title="HANDLE-SCORE FORWARD TEST"
              sub="does full > half > skip hold on REAL resolved trades? (closing the backtest→live loop)"
            />
            {(() => {
              const ft = a.handleScoreForwardTest;
              const bucketColor = (b: string) =>
                b === "full" ? "text-green-400" : b === "half" ? "text-amber-400" : "text-gray-400";
              return (
                <>
                  <div className="overflow-x-auto">
                    <table className="text-[11px] w-full">
                      <thead>
                        <tr className={subFg}>
                          <th className="text-left px-1.5 py-0.5 font-normal">Bucket</th>
                          <th className="text-right px-1.5 py-0.5 font-normal">n (resolved)</th>
                          <th className="text-right px-1.5 py-0.5 font-normal">win</th>
                          <th className="text-right px-1.5 py-0.5 font-normal">avg R</th>
                          <th className="text-right px-1.5 py-0.5 font-normal">PF (theo)</th>
                          <th className="text-right px-1.5 py-0.5 font-normal">n traded</th>
                          <th className="text-right px-1.5 py-0.5 font-normal">PF (actual)</th>
                          <th className="text-right px-1.5 py-0.5 font-normal">backtest PF (IS/OOS)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ft.buckets.map((b) => {
                          const ref = ft.backtestReference.filter((r) => r.bucket === b.bucket);
                          const refStr =
                            ref.length > 0
                              ? ref.map((r) => `${r.quintile} ${r.isPf.toFixed(1)}/${r.oosPf.toFixed(1)}`).join(" · ")
                              : "—";
                          return (
                            <tr key={b.bucket} className={`border-t ${border}`}>
                              <td className={`px-1.5 py-0.5 font-bold uppercase ${bucketColor(b.bucket)}`}>{b.bucket}</td>
                              <td className="px-1.5 py-0.5 text-right">
                                <span className={b.n < LOW_SAMPLE_THRESHOLD ? "text-red-400 font-bold" : ""}>{b.n}</span>
                                {b.n < LOW_SAMPLE_THRESHOLD && <span className="text-red-400 text-[9px]"> ⚠</span>}
                              </td>
                              <td className="px-1.5 py-0.5 text-right">{fmtPct(b.winRate)}</td>
                              <td className={`px-1.5 py-0.5 text-right font-bold ${rColor(b.avgR)}`}>{fmtR(b.avgR)}</td>
                              <td className={`px-1.5 py-0.5 text-right font-bold ${fg}`}>{fmtPf(b.pf)}</td>
                              <td className="px-1.5 py-0.5 text-right">{b.actual.n}</td>
                              <td className="px-1.5 py-0.5 text-right">{b.actual.n > 0 ? fmtPf(b.actual.pf) : "—"}</td>
                              <td className={`px-1.5 py-0.5 text-right ${subFg}`}>{refStr}</td>
                            </tr>
                          );
                        })}
                        {ft.unbucketed.n > 0 && (
                          <tr className={`border-t ${border} opacity-70`}>
                            <td className={`px-1.5 py-0.5 ${subFg}`}>unscored</td>
                            <td className="px-1.5 py-0.5 text-right">{ft.unbucketed.n}</td>
                            <td className="px-1.5 py-0.5 text-right">{fmtPct(ft.unbucketed.winRate)}</td>
                            <td className={`px-1.5 py-0.5 text-right ${rColor(ft.unbucketed.avgR)}`}>{fmtR(ft.unbucketed.avgR)}</td>
                            <td className={`px-1.5 py-0.5 text-right ${fg}`}>{fmtPf(ft.unbucketed.pf)}</td>
                            <td className="px-1.5 py-0.5 text-right">—</td>
                            <td className="px-1.5 py-0.5 text-right">—</td>
                            <td className={`px-1.5 py-0.5 text-right ${subFg}`}>pre-signal history</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {ft.verdictSuppressed ? (
                    <div className="mt-2 text-[11px] text-red-300 border border-red-700 bg-red-950/30 rounded px-2.5 py-1.5">
                      <AlertTriangle size={11} className="inline mr-1" />
                      <b>INSUFFICIENT DATA — verdict suppressed.</b> Need n≥{LOW_SAMPLE_THRESHOLD} resolved trades in EVERY
                      bucket before confirming full &gt; half &gt; skip on live fills
                      {ft.insufficientBuckets.length > 0 && (
                        <> (still short: <b>{ft.insufficientBuckets.map((b) => b.toUpperCase()).join(", ")}</b>; smallest bucket n={ft.minBucketN})</>
                      )}
                      . Raw bucket numbers shown above; no conclusion drawn. The frozen backtest (Q5 PF 4.20 IS / 4.36 OOS,
                      Q1 breakeven) is the prior being tested — it is NOT live confirmation.
                    </div>
                  ) : (
                    <div className="mt-2 text-[11px] text-green-300 border border-green-800 bg-green-950/20 rounded px-2.5 py-1.5">
                      <b>Verdict (n≥{LOW_SAMPLE_THRESHOLD} per bucket):</b> {ft.verdict}
                    </div>
                  )}
                  <div className={`text-[10px] ${subFg} mt-1`}>
                    PF (theo) groups every resolved setup by its frozen sizing directive on theoretical R — the direct analog
                    of the validated quintile-PF table. PF (actual) re-cuts each bucket on your realized fills (TRADED rows).
                    A SKIP bucket only gets fills when you overrode it.
                  </div>
                </>
              );
            })()}

            {/* View 3 — Universe vs Selected */}
            <SectionTitle n={3} title="UNIVERSE vs SELECTED" sub="is my picking beating trading the whole universe?" />
            <div className="flex flex-wrap gap-2">
              <StatCard label="Universe (all resolved)" s={a.universeVsSelected.universe} />
              <StatCard label="Selected — theoretical" s={a.universeVsSelected.selectedTheoretical} accent={fg} />
              <StatCard label="Selected — actual fills" s={a.universeVsSelected.selectedActual} />
            </div>
            <div className="mt-2 text-[11px]">
              <span className={subFg}>Δ PF (selected−universe): </span>
              <b className={fg}>{a.universeVsSelected.deltaPf == null ? "—" : a.universeVsSelected.deltaPf.toFixed(2)}</b>
              <span className={`ml-3 ${subFg}`}>Δ avg R: </span>
              <b className={rColor(a.universeVsSelected.deltaAvgR)}>{fmtR(a.universeVsSelected.deltaAvgR)}</b>
            </div>
            {a.universeVsSelected.verdictSuppressed ? (
              <div className="mt-2 text-[11px] text-yellow-300 border border-yellow-700 bg-yellow-950/30 rounded px-2.5 py-1.5">
                <AlertTriangle size={11} className="inline mr-1" />
                <b>VERDICT SUPPRESSED — insufficient data.</b> Need n≥{LOW_SAMPLE_THRESHOLD} in BOTH arms (have universe
                n={a.universeVsSelected.universe.n}, selected n={a.universeVsSelected.selectedTheoretical.n}). Raw numbers
                shown above; no conclusion drawn.
              </div>
            ) : (
              <div className="mt-2 text-[11px] text-green-300 border border-green-800 bg-green-950/20 rounded px-2.5 py-1.5">
                <b>Verdict:</b> {a.universeVsSelected.verdict}
              </div>
            )}

            {/* View 4 — Execution quality */}
            <SectionTitle n={4} title="EXECUTION QUALITY" sub="actual fill R vs theoretical R (the EXPD divergence, generalized)" />
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
              <span>
                <span className={subFg}>mean Δ </span>
                <b className={rColor(a.execution.meanDelta)}>{fmtR(a.execution.meanDelta)}</b>
              </span>
              <span>
                <span className={subFg}>median Δ </span>
                <b className={rColor(a.execution.medianDelta)}>{fmtR(a.execution.medianDelta)}</b>
              </span>
              <span>{lowSampleBadge(a.execution.lowSample, a.execution.n)}</span>
              {a.execution.outlierDriven && (
                <span className="text-[10px] text-amber-400 border border-amber-600 rounded px-1.5 py-0.5">
                  ⚠ outlier-driven mean — trust the median
                </span>
              )}
            </div>
            {a.execution.trades.length > 0 && (
              <div className="overflow-x-auto mt-2">
                <table className="text-[11px] w-full">
                  <thead>
                    <tr className={subFg}>
                      <th className="text-left px-1.5 py-0.5 font-normal">Ticker</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">theo R</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">actual R</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">Δ</th>
                      <th className="text-left px-1.5 py-0.5 font-normal">cause</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.execution.trades.map((t) => (
                      <tr key={t.ticker} className={`border-t ${border}`}>
                        <td className={`px-1.5 py-0.5 font-bold ${fg}`}>{t.ticker}</td>
                        <td className="px-1.5 py-0.5 text-right">{fmtR(t.rRealized)}</td>
                        <td className={`px-1.5 py-0.5 text-right ${rColor(t.userR)}`}>{fmtR(t.userR)}</td>
                        <td className={`px-1.5 py-0.5 text-right font-bold ${rColor(t.delta)}`}>{fmtR(t.delta)}</td>
                        <td className={`px-1.5 py-0.5 ${subFg}`}>{t.cause}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* View 5 — Decision-type breakdown */}
            <SectionTitle n={5} title="DECISION-TYPE BREAKDOWN" sub="is my discrimination real signal? did overriding JACK help?" />
            <div className="flex flex-wrap gap-2">
              <StatCard label="TRADED (theoretical R)" s={a.decisionBreakdown.traded} accent="text-green-400" />
              <StatCard label="PASSED (theoretical R)" s={a.decisionBreakdown.passed} accent="text-gray-300" />
            </div>
            <div className="mt-2 space-y-1">
              {a.decisionBreakdown.overrides.map((o) => (
                <div key={o.label} className="text-[11px] flex flex-wrap items-center gap-x-3">
                  <span className={subFg}>{o.label}:</span>
                  {lowSampleBadge(o.lowSample, o.n)}
                  {o.n > 0 && (
                    <>
                      <span>win {fmtPct(o.winRate)}</span>
                      <span className={rColor(o.avgR)}>avg {fmtR(o.avgR)}</span>
                      <span>PF {fmtPf(o.pf)}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
            {a.decisionBreakdown.perTicker.length > 0 && (
              <div className="overflow-x-auto mt-2">
                <table className="text-[11px] w-full">
                  <thead>
                    <tr className={subFg}>
                      <th className="text-left px-1.5 py-0.5 font-normal">Ticker</th>
                      <th className="text-left px-1.5 py-0.5 font-normal">your action</th>
                      <th className="text-left px-1.5 py-0.5 font-normal">JACK @ mark</th>
                      <th className="text-left px-1.5 py-0.5 font-normal">exit</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">theo R</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">actual R</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.decisionBreakdown.perTicker.map((r) => (
                      <tr key={r.ticker} className={`border-t ${border}`}>
                        <td className={`px-1.5 py-0.5 font-bold ${fg}`}>{r.ticker}</td>
                        <td className="px-1.5 py-0.5">{r.userAction}</td>
                        <td className={`px-1.5 py-0.5 ${subFg}`}>{r.jackDecisionAtMark ?? "—"}</td>
                        <td className={`px-1.5 py-0.5 ${subFg}`}>{r.exitReason ?? "—"}</td>
                        <td className={`px-1.5 py-0.5 text-right ${rColor(r.rRealized)}`}>{fmtR(r.rRealized)}</td>
                        <td className={`px-1.5 py-0.5 text-right ${rColor(r.userR)}`}>{fmtR(r.userR)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Open exposure strip */}
            <SectionTitle n={6} title="OPEN EXPOSURE" sub="live positions — excluded from resolved stats above" />
            {a.openExposure.length === 0 ? (
              <div className={`text-[11px] ${subFg}`}>No open positions.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="text-[11px] w-full">
                  <thead>
                    <tr className={subFg}>
                      <th className="text-left px-1.5 py-0.5 font-normal">Ticker</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">entry</th>
                      <th className="text-left px-1.5 py-0.5 font-normal">entry date</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">stop</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">target</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">risk/sh</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">days</th>
                      <th className="text-right px-1.5 py-0.5 font-normal">MFE / MAE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.openExposure.map((p) => (
                      <tr key={p.ticker} className={`border-t ${border}`}>
                        <td className={`px-1.5 py-0.5 font-bold ${fg}`}>{p.ticker}</td>
                        <td className="px-1.5 py-0.5 text-right">{p.userEntryPrice?.toFixed(2) ?? "—"}</td>
                        <td className={`px-1.5 py-0.5 ${subFg}`}>{p.userEntryDate ?? "—"}</td>
                        <td className="px-1.5 py-0.5 text-right">{p.stop?.toFixed(2) ?? "—"}</td>
                        <td className="px-1.5 py-0.5 text-right">{p.target?.toFixed(2) ?? "—"}</td>
                        <td className="px-1.5 py-0.5 text-right">{p.riskPerShare?.toFixed(2) ?? "—"}</td>
                        <td className="px-1.5 py-0.5 text-right">{p.daysHeld ?? "—"}</td>
                        <td className={`px-1.5 py-0.5 text-right ${subFg}`}>
                          {p.maxFavorablePct == null && p.maxAdversePct == null
                            ? "n/a"
                            : `${p.maxFavorablePct?.toFixed(1) ?? "—"}% / ${p.maxAdversePct?.toFixed(1) ?? "—"}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className={`text-[10px] ${subFg} mt-1`}>
                  Unrealized mark-to-market needs a live price the outcome tracker doesn't persist for open positions —
                  geometry + days held shown; MFE/MAE shown when a partial replay recorded them.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
