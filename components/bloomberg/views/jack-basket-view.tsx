"use client";

import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, Calculator, RefreshCw, RotateCcw, Copy, Check, Scissors, Printer, AlertTriangle } from "lucide-react";
import { useJackBasket } from "@/components/bloomberg/hooks/useJackBasket";
import {
  computeBasket,
  trimToFit,
  buildOrderList,
  defaultBasketOptions,
  FLAG_LABEL,
  MAX_PER_SECTOR,
  MAX_SLOTS,
  DEFAULT_ACCOUNT_SIZE,
  DEFAULT_RR_FLOOR,
  type BasketOptions,
  type BasketRow,
  type RiskScheme,
} from "@/lib/jack/basket";

interface Props {
  isDarkMode?: boolean;
  onBack?: () => void;
}

const LS_ACCOUNT = "jack.basket.accountSize";
const LS_SCHEME = "jack.basket.scheme";
const LS_LIVE = "jack.basket.live";
const LS_HIDE_SKIP = "jack.basket.hideSkip";
const LS_RR_FLOOR = "jack.basket.rrFloor";
const LS_MIN_PRICE = "jack.basket.minPrice";
const LS_HIDE_BELOW_FLOOR = "jack.basket.hideBelowFloor";

const usd0 = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
const num2 = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(2));
const pct1 = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(1)}%`);

function readLS<T>(key: string, fallback: T, parse: (raw: string) => T): T {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw == null) return fallback;
  try {
    return parse(raw);
  } catch {
    return fallback;
  }
}
const writeLS = (key: string, v: string) => {
  if (typeof window !== "undefined") window.localStorage.setItem(key, v);
};

export function JackBasketView({ isDarkMode = true, onBack }: Props) {
  // ---- persisted controls --------------------------------------------------
  const [accountSize, setAccountSize] = useState<number>(() =>
    readLS(LS_ACCOUNT, DEFAULT_ACCOUNT_SIZE, (r) => {
      const n = Number(r);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_ACCOUNT_SIZE;
    })
  );
  const [scheme, setScheme] = useState<RiskScheme>(() =>
    readLS(LS_SCHEME, "balanced" as RiskScheme, (r) => (r === "aggressive" ? "aggressive" : "balanced"))
  );
  const [live, setLive] = useState<boolean>(() => readLS(LS_LIVE, true, (r) => r !== "false"));
  const [hideSkipTier, setHideSkipTier] = useState<boolean>(() => readLS(LS_HIDE_SKIP, true, (r) => r !== "false"));
  const [rrFloor, setRrFloor] = useState<number>(() =>
    readLS(LS_RR_FLOOR, DEFAULT_RR_FLOOR, (r) => {
      const n = Number(r);
      return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RR_FLOOR;
    })
  );
  const [minPrice, setMinPrice] = useState<boolean>(() => readLS(LS_MIN_PRICE, true, (r) => r !== "false"));
  // Defaults OFF: below-floor rows stay in the basket and in the totals unless the
  // operator explicitly asks to drop them.
  const [hideBelowFloor, setHideBelowFloor] = useState<boolean>(() =>
    readLS(LS_HIDE_BELOW_FLOOR, false, (r) => r === "true")
  );

  // Session-only: trim/deselect state and per-row risk% edits.
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [riskPctOverrides, setRiskPctOverrides] = useState<Record<string, number>>({});
  const [trimmedNote, setTrimmedNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isFetching, refetch } = useJackBasket(live);

  const opts: BasketOptions = useMemo(
    () => ({ accountSize, scheme, hideSkipTier, rrFloor, hideBelowFloor, minPrice, riskPctOverrides, excluded }),
    [accountSize, scheme, hideSkipTier, rrFloor, hideBelowFloor, minPrice, riskPctOverrides, excluded]
  );

  const candidates = useMemo(() => (live ? data?.candidates ?? [] : []), [live, data?.candidates]);
  const open = useMemo(() => data?.open ?? [], [data?.open]);
  const totals = useMemo(() => computeBasket(candidates, open, opts), [candidates, open, opts]);

  const setAccount = useCallback((n: number) => {
    const v = Number.isFinite(n) && n > 0 ? n : DEFAULT_ACCOUNT_SIZE;
    setAccountSize(v);
    writeLS(LS_ACCOUNT, String(v));
  }, []);

  const handleTrim = useCallback(() => {
    const res = trimToFit(candidates, open, opts);
    setExcluded(res.excluded);
    setTrimmedNote(
      res.trimmed.length === 0
        ? "Nothing to trim — the basket already fits."
        : `Trimmed ${res.trimmed.length}: ${res.trimmed.map((r) => `${r.ticker}${r.pRank != null ? ` (P${r.pRank})` : ""}`).join(", ")}` +
            (res.fits ? " — fits now." : " — still does not fit.") +
            (res.reasons.length ? `  [${res.reasons.join("; ")}]` : "")
    );
  }, [candidates, open, opts]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildOrderList(totals));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the printable view is the fallback */
    }
  }, [totals]);

  // ---- theme tokens (match the other JACK views) ---------------------------
  const bg = isDarkMode ? "bg-black" : "bg-white";
  const fg = isDarkMode ? "text-orange-400" : "text-orange-700";
  const subFg = isDarkMode ? "text-gray-400" : "text-gray-600";
  const border = isDarkMode ? "border-orange-900/60" : "border-orange-200";
  const cardBg = isDarkMode ? "bg-gray-950/50" : "bg-gray-50";
  const inputBg = isDarkMode ? "bg-gray-950" : "bg-gray-50";
  const inputBorder = isDarkMode ? "border-gray-800" : "border-gray-300";
  const btn = isDarkMode
    ? "bg-gray-900 hover:bg-gray-800 text-orange-300 border border-gray-800"
    : "bg-white hover:bg-gray-100 text-gray-800 border border-gray-300";
  const hairline = isDarkMode ? "bg-orange-900/50" : "bg-orange-200";

  const Tile = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) => (
    <div className={`rounded border ${border} ${cardBg} px-2.5 py-1.5 min-w-[120px]`}>
      <div className={`text-[9px] uppercase tracking-widest ${subFg}`}>{label}</div>
      <div className={`text-sm font-bold ${tone ?? fg}`}>{value}</div>
      {sub && <div className={`text-[10px] ${subFg}`}>{sub}</div>}
    </div>
  );

  const flagChips = (r: BasketRow) =>
    r.flags.length === 0 ? null : (
      <span className="inline-flex flex-wrap gap-1">
        {r.flags.map((f) => {
          const hard = f === "stop_above_entry" || f === "missing_geometry";
          const warn = f === "sector_cap" || f === "duplicate_of_open";
          return (
            <span
              key={f}
              className={`text-[9px] px-1 rounded border whitespace-nowrap ${
                hard ? "border-red-600 text-red-400" : warn ? "border-amber-600 text-amber-400" : `${border} ${subFg}`
              }`}
            >
              {FLAG_LABEL[f]}
            </span>
          );
        })}
      </span>
    );

  return (
    <div
      className={`flex flex-col w-full ${bg} ${fg} font-mono text-sm overflow-hidden`}
      style={{ height: "calc(100vh - 4rem)" }}
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${border} flex-shrink-0 print:hidden`}>
        <div className="flex items-center gap-3">
          {onBack && (
            <button type="button" onClick={onBack} className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btn}`}>
              <ArrowLeft size={14} /> BACK
            </button>
          )}
          <div className="flex items-center gap-2">
            <Calculator size={16} />
            <span className="font-bold tracking-wider">BASKET SIZER</span>
            <span className={`text-xs ${subFg}`}>whole-week sizing · combined book</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={!live || isFetching}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${btn} disabled:opacity-50`}
          >
            {isFetching ? <RefreshCw size={12} className="animate-spin" /> : <RefreshCw size={12} />} REFRESH
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 min-w-0">
        {/* Controls */}
        <div className={`flex flex-wrap items-center gap-3 text-[11px] mb-3 print:hidden`}>
          {/* Account size drives EVERY dollar figure below — risk$, position$, reward$,
              buying power, heat and all totals re-compute live from this one input. */}
          <label className={`flex items-center gap-1.5 ${fg} font-bold`}>
            ACCOUNT $
            <input
              type="number"
              min={1}
              step={1000}
              value={accountSize}
              onChange={(e) => setAccount(Number(e.target.value))}
              title="Account size — drives risk$, position$, reward$, buying power, heat and every total. Persisted."
              className={`w-28 px-1.5 py-1 rounded ${inputBg} border-2 border-orange-700 ${fg} font-mono text-[12px] font-bold focus:outline-none focus:border-orange-500`}
            />
          </label>
          <div className={`w-px h-5 ${hairline}`} />
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => {
                setLive(e.target.checked);
                writeLS(LS_LIVE, String(e.target.checked));
              }}
            />
            <span className={subFg}>LIVE pull</span>
          </label>
          <div className={`flex items-center gap-1 ${subFg}`}>
            scheme
            {(["balanced", "aggressive"] as RiskScheme[]).map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => {
                  setScheme(s);
                  writeLS(LS_SCHEME, s);
                }}
                className={`px-1.5 py-0.5 rounded border text-[10px] ${
                  scheme === s ? "border-orange-500 text-orange-400 font-bold" : `${border} ${subFg}`
                }`}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={hideSkipTier}
              onChange={(e) => {
                setHideSkipTier(e.target.checked);
                writeLS(LS_HIDE_SKIP, String(e.target.checked));
              }}
            />
            <span className={subFg}>hide Q1/Q2</span>
          </label>
          <label className={`flex items-center gap-1 ${subFg}`}>
            R:R floor
            <input
              type="number"
              min={0}
              step={0.1}
              value={rrFloor}
              onChange={(e) => {
                const n = Number(e.target.value);
                setRrFloor(n);
                writeLS(LS_RR_FLOOR, String(n));
              }}
              className={`w-16 px-1.5 py-0.5 rounded ${inputBg} ${inputBorder} border ${fg} font-mono text-[11px]`}
            />
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={hideBelowFloor}
              onChange={(e) => {
                setHideBelowFloor(e.target.checked);
                writeLS(LS_HIDE_BELOW_FLOOR, String(e.target.checked));
              }}
            />
            <span className={subFg}>hide below floor</span>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={minPrice}
              onChange={(e) => {
                setMinPrice(e.target.checked);
                writeLS(LS_MIN_PRICE, String(e.target.checked));
              }}
            />
            <span className={subFg}>price ≥ $5</span>
          </label>
          <div className="flex-1" />
          <button type="button" onClick={handleTrim} className={`flex items-center gap-1 px-2 py-1 rounded ${btn}`}>
            <Scissors size={12} /> TRIM TO FIT
          </button>
          <button
            type="button"
            onClick={() => {
              setExcluded({});
              setTrimmedNote(null);
            }}
            className={`px-2 py-1 rounded ${btn}`}
          >
            RESET
          </button>
          <button type="button" onClick={handleCopy} className={`flex items-center gap-1 px-2 py-1 rounded ${btn}`}>
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "COPIED" : "COPY ORDERS"}
          </button>
          <button type="button" onClick={() => window.print()} className={`flex items-center gap-1 px-2 py-1 rounded ${btn}`}>
            <Printer size={12} /> TICKET
          </button>
        </div>

        {/* R:R floor guidance — it is a capacity dial, not an edge filter. */}
        <div className={`text-[10px] ${subFg} mb-2 print:hidden`}>
          Floor is a capacity dial — PF is flat across R:R; low-R:R trades win more often. Use P-rank to choose.
        </div>

        {/* The standing caveat */}
        <div className={`text-[10px] ${subFg} border ${border} ${cardBg} rounded px-2.5 py-1.5 mb-3`}>
          Rows are the board's <b className={fg}>LIVE (fired)</b> new-entry group — close-confirmed above the rim,
          tradeable (Q3–Q5), not already held. Un-fired pending and already-resolved setups are excluded.
          <br />
          Frictionless — <b className={fg}>sizes are ceilings</b>, not instructions. Slippage, partial fills, and your own
          discretion all reduce them. Sector caps, buying power, heat and slots all include your OPEN positions.
        </div>

        {isLoading && live && (
          <div className={`text-center ${subFg} py-10`}>
            <RotateCcw size={24} className="animate-spin mx-auto mb-2" /> Loading the board…
          </div>
        )}
        {live && data && !data.persistenceAvailable && (
          <div className="text-yellow-400 text-sm p-3 rounded bg-yellow-950/20 border border-yellow-900">
            <b>Live pull disabled</b> — {data.reason ?? "persistence unavailable"} (VPS/localhost only).
          </div>
        )}
        {live && data?.error && (
          <div className="text-red-400 text-sm p-3 rounded bg-red-950/20 border border-red-900">Error: {data.error}</div>
        )}
        {!live && (
          <div className={`text-[11px] ${subFg} mb-3`}>
            LIVE pull is OFF — no rows are being pulled from the board. Turn it back on to size this week's setups.
          </div>
        )}

        {/* Totals tiles */}
        <div className="flex flex-wrap gap-2 mb-3">
          <Tile label="setups" value={String(totals.included.length)} sub={`${totals.hidden.length} filtered out`} />
          <Tile label="shares" value={totals.shares.toLocaleString()} />
          <Tile
            label="position $"
            value={usd0(totals.positionDollars)}
            sub={`${pct1(totals.grossExposurePct)} gross`}
            tone={totals.overBuyingPower ? "text-red-400" : undefined}
          />
          <Tile label="risk $" value={usd0(totals.riskDollars)} sub={`heat ${pct1(totals.heatPct)}`} />
          <Tile label="reward $" value={usd0(totals.rewardDollars)} />
          <Tile label="reward : risk" value={totals.rewardToRisk != null ? `${totals.rewardToRisk.toFixed(2)}×` : "—"} />
          <Tile
            label="slots"
            value={`${totals.slotsUsed} / ${MAX_SLOTS}`}
            sub={`${totals.openCount} open · ${totals.slotsRemaining} left`}
            tone={totals.overSlots ? "text-red-400" : undefined}
          />
          <Tile
            label="buying power"
            value={usd0(totals.buyingPowerRemaining)}
            sub={`of ${usd0(totals.buyingPower)} (open ${usd0(totals.openNotional)})`}
            tone={totals.overBuyingPower ? "text-red-400" : undefined}
          />
        </div>

        {/* Warnings */}
        {(totals.overBuyingPower || totals.overSlots || totals.sectorBreaches.length > 0 || totals.duplicates.length > 0) && (
          <div className="text-[11px] text-red-300 border border-red-700 bg-red-950/30 rounded px-2.5 py-1.5 mb-3">
            <AlertTriangle size={11} className="inline mr-1" />
            {totals.overBuyingPower && <span className="mr-3">Over buying power by {usd0(-totals.buyingPowerRemaining)} — needs margin.</span>}
            {totals.overSlots && <span className="mr-3">Over the {MAX_SLOTS}-slot cap.</span>}
            {totals.sectorBreaches.length > 0 && <span className="mr-3">Sector cap breached: {totals.sectorBreaches.join(", ")}.</span>}
            {totals.duplicates.length > 0 && <span>Already open: {totals.duplicates.join(", ")}.</span>}
          </div>
        )}
        {trimmedNote && (
          <div className={`text-[11px] ${subFg} border ${border} ${cardBg} rounded px-2.5 py-1.5 mb-3`}>{trimmedNote}</div>
        )}

        {/* Sector panel */}
        {totals.sectors.length > 0 && (
          <>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[11px] font-bold ${fg} tracking-widest`}>SECTORS (open + basket)</span>
              <div className={`flex-1 h-px ${hairline}`} />
            </div>
            <div className="flex flex-wrap gap-2 mb-3">
              {totals.sectors.map((s) => (
                <div
                  key={s.sector}
                  className={`rounded border px-2 py-1 text-[10px] ${
                    s.overCap ? "border-red-600 text-red-400" : s.total === MAX_PER_SECTOR ? "border-amber-600 text-amber-400" : `${border} ${subFg}`
                  }`}
                  title={`open: ${s.openTickers.join(", ") || "—"}\nbasket: ${s.basketTickers.join(", ") || "—"}`}
                >
                  <b>{s.sector}</b> {s.total}/{MAX_PER_SECTOR}
                  <span className="opacity-70">
                    {" "}
                    ({s.open} open + {s.basket} new)
                  </span>
                  {[...s.openTickers, ...s.basketTickers].length > 0 && (
                    <div className="opacity-70">{[...s.openTickers.map((t) => `${t}*`), ...s.basketTickers].join(" ")}</div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="text-[11px] w-full">
            <thead>
              <tr className={subFg}>
                <th className="text-left px-1.5 py-0.5 font-normal print:hidden" />
                <th className="text-left px-1.5 py-0.5 font-normal">Ticker</th>
                <th className="text-left px-1.5 py-0.5 font-normal">P</th>
                <th className="text-left px-1.5 py-0.5 font-normal">Tier</th>
                <th className="text-left px-1.5 py-0.5 font-normal">Sector</th>
                <th className="text-right px-1.5 py-0.5 font-normal">Risk%</th>
                <th className="text-right px-1.5 py-0.5 font-normal">Stop</th>
                <th className="text-right px-1.5 py-0.5 font-normal">Entry</th>
                <th className="text-right px-1.5 py-0.5 font-normal">Target</th>
                <th className="text-right px-1.5 py-0.5 font-normal">Risk $</th>
                <th className="text-right px-1.5 py-0.5 font-normal">Reward $</th>
                <th className="text-right px-1.5 py-0.5 font-normal">Shares</th>
                <th className="text-right px-1.5 py-0.5 font-normal">Position $</th>
                <th className="text-right px-1.5 py-0.5 font-normal">%Acct</th>
                <th className="text-right px-1.5 py-0.5 font-normal">Stop%</th>
                <th className="text-right px-1.5 py-0.5 font-normal">R:R</th>
                <th className="text-left px-1.5 py-0.5 font-normal">⚑</th>
              </tr>
            </thead>
            <tbody>
              {totals.rows.map((r) => (
                <tr
                  key={r.key}
                  className={`border-t ${border} ${r.hidden ? "opacity-40" : ""} ${
                    excluded[r.key] ? "line-through" : ""
                  }`}
                >
                  <td className="px-1.5 py-0.5 print:hidden">
                    <input
                      type="checkbox"
                      checked={!excluded[r.key]}
                      onChange={(e) =>
                        setExcluded((prev) => ({ ...prev, [r.key]: !e.target.checked }))
                      }
                      title="Include in the basket"
                    />
                  </td>
                  <td className={`px-1.5 py-0.5 font-bold ${fg}`}>{r.ticker}</td>
                  <td className={`px-1.5 py-0.5 ${subFg}`}>{r.pRank != null ? `P${r.pRank}` : "—"}</td>
                  <td className="px-1.5 py-0.5">{r.tier ?? "—"}</td>
                  <td className="px-1.5 py-0.5">{r.sector}</td>
                  <td className="px-1.5 py-0.5 text-right print:hidden">
                    <input
                      type="number"
                      min={0}
                      step={0.05}
                      value={r.riskPct}
                      onChange={(e) =>
                        setRiskPctOverrides((prev) => ({ ...prev, [r.key]: Number(e.target.value) }))
                      }
                      className={`w-14 px-1 py-0 rounded ${inputBg} ${inputBorder} border ${fg} font-mono text-[11px] text-right`}
                    />
                  </td>
                  <td className="px-1.5 py-0.5 text-right hidden print:table-cell">{r.riskPct.toFixed(2)}</td>
                  <td className="px-1.5 py-0.5 text-right">{num2(r.stop)}</td>
                  <td className="px-1.5 py-0.5 text-right">{num2(r.entry)}</td>
                  <td className="px-1.5 py-0.5 text-right">{num2(r.target)}</td>
                  <td className="px-1.5 py-0.5 text-right">{usd0(r.riskDollars)}</td>
                  <td className="px-1.5 py-0.5 text-right text-green-400">{usd0(r.rewardDollars)}</td>
                  <td className={`px-1.5 py-0.5 text-right font-bold ${fg}`}>{r.shares.toLocaleString()}</td>
                  <td className="px-1.5 py-0.5 text-right">{usd0(r.positionDollars)}</td>
                  <td className="px-1.5 py-0.5 text-right">{pct1(r.pctOfAccount)}</td>
                  <td className="px-1.5 py-0.5 text-right">{pct1(r.stopPct)}</td>
                  <td className="px-1.5 py-0.5 text-right">{r.rr != null ? `${r.rr.toFixed(2)}×` : "—"}</td>
                  <td className="px-1.5 py-0.5">{flagChips(r)}</td>
                </tr>
              ))}
              {totals.rows.length === 0 && (
                <tr>
                  <td colSpan={17} className={`px-1.5 py-4 text-center ${subFg}`}>
                    {!live ? (
                      "LIVE pull is off."
                    ) : (
                      <>
                        No live (fired) setups right now — the basket fills as setups fire and move to LIVE.
                        {data?.pendingTotal ? (
                          <div className="mt-1 opacity-80">
                            {data.pendingTotal} setup{data.pendingTotal === 1 ? "" : "s"} still pending, waiting on a
                            confirming close above the rim.
                          </div>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Open book, for context */}
        {open.length > 0 && (
          <>
            <div className="flex items-center gap-2 mt-5 mb-1">
              <span className={`text-[11px] font-bold ${fg} tracking-widest`}>OPEN POSITIONS (counted in every cap)</span>
              <div className={`flex-1 h-px ${hairline}`} />
            </div>
            <div className={`text-[11px] ${subFg}`}>
              {open.map((p) => (
                <span key={p.ticker} className="mr-3">
                  {p.ticker}
                  {p.sector ? ` · ${p.sector}` : ""} · {p.shares ?? 0} sh
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
