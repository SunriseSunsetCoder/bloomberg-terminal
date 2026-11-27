"use client";

import { useM2 } from "../hooks/useM2";
import type { M2LedgerRow, M2Payload } from "@/lib/m2/server";

/**
 * M2 — SELL SPY PUT (bullish dip). Status tile + trade history, bottom of the IV tab.
 *
 * Read-only view. The numbers come from lib/m2 (the fixture-checked port of the alert's
 * rules, on the alert's Tiingo sources); state + history come from the alert script's
 * own files in data/m2/. The script is the only writer of either.
 */
export function M2Panel() {
  const { data, isLoading, error, refetch } = useM2();

  return (
    <div className="border border-zinc-800 bg-zinc-950 p-4 mt-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-zinc-400 tracking-wider">M2 — SELL SPY PUT (bullish dip)</div>
        <div className="flex items-center gap-2">
          {data?.live && <ModeBadge live={data.live} />}
          <button
            type="button"
            onClick={() => refetch()}
            className="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-xs"
          >
            ↻
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-amber-400 text-xs">Loading M2…</div>
      ) : error && !data ? (
        <div className="text-red-400 text-xs">M2 unavailable: {(error as Error).message}</div>
      ) : data ? (
        <>
          <StatusTile data={data} />
          <History data={data} />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

type Live = NonNullable<M2Payload["live"]>;

function ModeBadge({ live }: { live: Live }) {
  const stamp = live.quoteEt ? `@${live.quoteEt} IEX` : "";
  if (live.mode === "LIVE") return <span className="text-xs text-green-400">LIVE {stamp}</span>;
  if (live.mode === "STALE")
    return (
      <span className="text-xs font-bold text-red-400 border border-red-700 px-1">
        ⚠ STALE {stamp} · {Math.round(live.quoteAgeMin ?? 0)} min old
      </span>
    );
  if (live.mode === "AFTER_CLOSE")
    return <span className="text-xs text-amber-400">AFTER CLOSE {stamp}</span>;
  return <span className="text-xs text-zinc-500">CLOSED · as of {live.asOf} official close</span>;
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-zinc-800 bg-black p-3">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

function StatusTile({ data }: { data: M2Payload }) {
  const live = data.live;
  const st = data.state.value;
  const inTrade = !!st?.in_trade;

  if (!live) {
    return (
      <div className="text-red-400 text-xs mb-3">
        Live status unavailable: {data.error ?? "unknown error"}
        <StateLine data={data} />
      </div>
    );
  }

  const distPct = ((live.px - live.sma200) / live.sma200) * 100;
  const streakHint = (() => {
    if (inTrade)
      return live.rulesNow.includes("exit") ? "EXIT condition met" : "in trade — entries paused";
    if (!live.filterOn) return "filter OFF — no entries";
    if (live.rulesNow.includes("enter"))
      return `ENTER condition met · strike ≈ ${live.strikeIfEntered}`;
    if (live.streak === 2) return "1 more lower close = ENTER";
    if (live.streak >= 3) return "already entered on this streak";
    return "needs 2 for setup, 3 for entry";
  })();

  return (
    <div className="mb-3">
      <div className="grid grid-cols-5 gap-3">
        <Cell
          label={
            live.pxSource === "iex"
              ? `SPY ${live.quoteEt ? `@${live.quoteEt} IEX` : ""}`
              : `SPY close ${live.asOf}`
          }
        >
          <div className="text-xl font-bold text-amber-300">{live.px.toFixed(2)}</div>
        </Cell>
        <Cell label="SMA200 / SMA5">
          <div className="text-xl font-bold text-amber-300">{live.sma200.toFixed(2)}</div>
          <div className="text-xs text-zinc-400">SMA5 {live.sma5.toFixed(2)}</div>
        </Cell>
        <Cell label="FILTER (px > SMA200)">
          <div className={`text-xl font-bold ${live.filterOn ? "text-green-400" : "text-red-400"}`}>
            {live.filterOn ? "ON" : "OFF"}
          </div>
          <div className="text-xs text-zinc-400">
            {distPct >= 0 ? "+" : ""}
            {distPct.toFixed(1)}% vs 200d
          </div>
        </Cell>
        <Cell label="LOWER-CLOSE STREAK">
          <div className="text-xl font-bold text-amber-300">
            {live.streak >= 3 ? `${live.streak} (3+)` : live.streak}
          </div>
          <div className="text-xs text-zinc-400">{streakHint}</div>
        </Cell>
        <Cell label="M2 STATE">
          {inTrade && st ? (
            <>
              <div className="text-xl font-bold text-green-400">IN TRADE</div>
              <div className="text-xs text-zinc-400">
                since {st.entry_date} · day {live.holdDay ?? st.hold_day}/5
                {st.strike != null ? ` · K ${st.strike}` : ""}
              </div>
            </>
          ) : (
            <>
              <div className="text-xl font-bold text-zinc-300">FLAT</div>
              <div className="text-xs text-zinc-500">
                {data.state.present ? "" : "no state file yet"}
              </div>
            </>
          )}
        </Cell>
      </div>
      <div className="text-[10px] text-zinc-600 mt-1">
        {live.pxSource === "iex"
          ? "Price is the IEX last print, not the broker close — the 15:45 alert uses the same quote."
          : "Market closed: numbers are from the last official adjusted close."}
        {live.note ? ` · ${live.note}` : ""}
        {data.state.error ? ` · state file unreadable: ${data.state.error}` : ""}
      </div>
    </div>
  );
}

function StateLine({ data }: { data: M2Payload }) {
  const st = data.state.value;
  return (
    <div className="text-zinc-400 mt-1">
      State:{" "}
      {st?.in_trade ? `IN TRADE since ${st.entry_date} (strike ${st.strike ?? "?"})` : "FLAT"}
    </div>
  );
}

const EVENT_COLOR: Record<string, string> = {
  SETUP: "text-amber-400",
  ENTER: "text-green-400",
  EXIT: "text-sky-400",
  MANUAL_SET_FLAT: "text-zinc-400",
  MANUAL_SET_IN_TRADE: "text-zinc-400",
};

function History({ data }: { data: M2Payload }) {
  const rows = data.ledger.rows;
  const filter = data.live ? (data.live.filterOn ? "ON" : "OFF") : "unknown";

  return (
    <div className="border-t border-zinc-800 pt-3">
      <div className="text-xs text-zinc-500 mb-2">HISTORY · data/m2/m2_trades.csv</div>
      {rows.length === 0 ? (
        <div className="text-xs text-zinc-400 py-3">
          No M2 trades yet — filter currently {filter}
          {!data.ledger.present && (
            <span className="text-zinc-600"> · ledger not created yet ({data.ledger.path})</span>
          )}
          {data.ledger.error && <span className="text-red-400"> · {data.ledger.error}</span>}
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-zinc-500 text-left">
              <th className="py-1 pr-3 font-normal">DATE</th>
              <th className="pr-3 font-normal">TIME</th>
              <th className="pr-3 font-normal">EVENT</th>
              <th className="pr-3 font-normal text-right">SPY</th>
              <th className="pr-3 font-normal text-right">STRIKE</th>
              <th className="pr-3 font-normal text-right">HOLD</th>
              <th className="pr-3 font-normal text-right">SPY Δ</th>
              <th className="pr-3 font-normal">BELOW STRIKE?</th>
              <th className="font-normal">REASON</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Row key={`${r.logged_at}-${i}`} r={r} />
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && (
        <div className="text-[10px] text-zinc-600 mt-1">
          SPY prices are the 15:45 IEX proxy the alert acted on, not official closes. No R: premiums
          are not recorded.
        </div>
      )}
    </div>
  );
}

function Row({ r }: { r: M2LedgerRow }) {
  return (
    <tr className="border-t border-zinc-900 text-zinc-300">
      <td className="py-1 pr-3">{r.session_date}</td>
      <td className="pr-3">{r.time}</td>
      <td className={`pr-3 ${EVENT_COLOR[r.event] ?? ""}`}>{r.event}</td>
      <td className="pr-3 text-right">{r.spy_px?.toFixed(2) ?? "—"}</td>
      <td className="pr-3 text-right">{r.strike ?? "—"}</td>
      <td className="pr-3 text-right">{r.hold_day ?? "—"}</td>
      <td
        className={`pr-3 text-right ${
          r.spy_delta_pct == null ? "" : r.spy_delta_pct >= 0 ? "text-green-400" : "text-red-400"
        }`}
      >
        {r.spy_delta_pct == null
          ? "—"
          : `${r.spy_delta_pct >= 0 ? "+" : ""}${r.spy_delta_pct.toFixed(2)}%`}
      </td>
      <td className={`pr-3 ${r.below_strike ? "text-red-400 font-bold" : ""}`}>
        {r.below_strike == null ? "—" : r.below_strike ? "YES" : "no"}
      </td>
      <td className="text-zinc-400">{r.reason}</td>
    </tr>
  );
}
