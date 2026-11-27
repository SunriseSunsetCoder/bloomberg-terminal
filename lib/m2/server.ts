/**
 * M2 panel data — server only (fs + Tiingo). Feeds GET /api/m2.
 *
 * SAME SOURCES AS strategies/m2/m2_alert.py, request for request:
 *   history : GET https://api.tiingo.com/tiingo/daily/SPY/prices?startDate=<ET today − 420d>
 *             → adjClose, only bars dated BEFORE today (ET)
 *   today   : GET https://api.tiingo.com/iex/SPY → tngoLast (else last), timed by
 *             QUOTE_TS_FIELDS in order
 * and the same decision code (lib/m2/signal.ts, fixture-checked against the Python).
 *
 * READ-ONLY on data/m2/: the alert script is the only writer of m2_state.json and
 * m2_trades.csv. Nothing here is copied into the DB. Paths resolve from process.cwd()
 * exactly like data/jack.db (lib/db/init.ts); M2_DATA_DIR overrides, as in the script.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HISTORY_DAYS,
  STALE_MINUTES,
  etNowIso,
  evaluate,
  holdDay,
  isEarlyClose,
  isSession,
  quoteFromRow,
  type AlertKind,
  type Bar,
  type M2State,
} from "./signal";

const TICKER = "SPY";

export type M2Mode = "LIVE" | "STALE" | "AFTER_CLOSE" | "CLOSED";

export interface M2LedgerRow {
  logged_at: string;
  event: string;
  session_date: string;
  time: string;
  spy_px: number | null;
  strike: number | null;
  hold_day: number | null;
  reason: string;
  price_source: string;
  /** EXIT rows only: SPY % change from the matching entry row's SPY price. */
  spy_delta_pct: number | null;
  /** EXIT rows only: SPY (the 15:45 IEX proxy) below the put strike at exit. */
  below_strike: boolean | null;
}

export interface M2Payload {
  ok: boolean;
  error?: string;
  nowEt: string;
  live: null | {
    mode: M2Mode;
    asOf: string; // the session the numbers are for
    px: number;
    pxSource: "iex" | "official_close";
    quoteEt: string | null; // "HH:MM"
    quoteAgeMin: number | null;
    sma200: number;
    sma5: number;
    filterOn: boolean;
    streak: number;
    strikeIfEntered: number;
    rulesNow: AlertKind[]; // what the 15:45 rules say for these numbers + the current state
    holdDay: number | null;
    note?: string;
  };
  state: { present: boolean; path: string; value: M2State | null; error?: string };
  ledger: { present: boolean; path: string; rows: M2LedgerRow[]; error?: string };
}

const FLAT: M2State = {
  in_trade: false,
  entry_date: null,
  entry_px: null,
  strike: null,
  hold_day: 0,
  last_entry_streak_id: null,
};

function dataDir(): string {
  return process.env.M2_DATA_DIR || join(process.cwd(), "data", "m2");
}

// ---------------------------------------------------------------------------
// Tiingo (cached: history per ET day, quote 30s)
// ---------------------------------------------------------------------------

let historyCache: { day: string; bars: Bar[]; at: number } | null = null;
let quoteCache: { row: Record<string, unknown>; at: number } | null = null;

/** Test hook: drop both caches. */
export function resetM2Caches(): void {
  historyCache = null;
  quoteCache = null;
}

async function tiingo(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split("?")[0]}`);
  return res.json();
}

function minusDays(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

async function getHistory(today: string, token: string): Promise<Bar[]> {
  if (historyCache && historyCache.day === today && Date.now() - historyCache.at < 6 * 3600_000) {
    return historyCache.bars;
  }
  const rows = (await tiingo(
    `https://api.tiingo.com/tiingo/daily/${TICKER}/prices?startDate=${minusDays(today, HISTORY_DAYS)}`,
    token
  )) as Array<{ date?: string; adjClose?: number | null }>;
  if (!Array.isArray(rows)) throw new Error("daily history was not a list");
  const bars: Bar[] = [];
  for (const r of rows) {
    const d = String(r.date ?? "").slice(0, 10);
    if (d && r.adjClose != null && d < today) bars.push([d, Number(r.adjClose)]);
  }
  bars.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  historyCache = { day: today, bars, at: Date.now() };
  return bars;
}

async function getQuoteRow(token: string): Promise<Record<string, unknown>> {
  if (!quoteCache || Date.now() - quoteCache.at > 30_000) {
    const rows = await tiingo(`https://api.tiingo.com/iex/${TICKER}`, token);
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("IEX quote empty");
    quoteCache = { row: rows[0] as Record<string, unknown>, at: Date.now() };
  }
  return quoteCache.row;
}

// ---------------------------------------------------------------------------
// files (read-only)
// ---------------------------------------------------------------------------

async function readState(): Promise<M2Payload["state"]> {
  const path = join(dataDir(), "m2_state.json");
  try {
    const raw = (await readFile(path, "utf-8")).replace(/^\uFEFF/, "");
    return { present: true, path, value: { ...FLAT, ...JSON.parse(raw) } };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return { present: false, path, value: null, error: missing ? undefined : String(err) };
  }
}

/** RFC-4180-ish: quoted fields, doubled quotes, CRLF. Enough for Python's csv module. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) out.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) out.push(row);
  return out;
}

const num = (s: string | undefined): number | null => {
  if (s == null || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

async function readLedger(): Promise<M2Payload["ledger"]> {
  const path = join(dataDir(), "m2_trades.csv");
  let text: string;
  try {
    text = (await readFile(path, "utf-8")).replace(/^\uFEFF/, "");
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return { present: false, path, rows: [], error: missing ? undefined : String(err) };
  }
  const [header, ...body] = parseCsv(text);
  if (!header) return { present: true, path, rows: [] };
  const rows: M2LedgerRow[] = [];
  let lastEntryPx: number | null = null;
  for (const cells of body) {
    const r: Record<string, string> = {};
    header.forEach((h, i) => {
      r[h] = cells[i] ?? "";
    });
    const spy = num(r.spy_px);
    const strike = num(r.strike);
    const isExit = r.event === "EXIT";
    const delta =
      isExit && spy != null && lastEntryPx ? ((spy - lastEntryPx) / lastEntryPx) * 100 : null;
    rows.push({
      logged_at: r.logged_at,
      event: r.event,
      session_date: r.session_date,
      time: /^\d\d:\d\d/.exec(r.price_source ?? "")?.[0] ?? (r.logged_at ?? "").slice(11, 16),
      spy_px: spy,
      strike,
      hold_day: num(r.hold_day),
      reason: r.reason,
      price_source: r.price_source,
      spy_delta_pct: delta,
      below_strike: isExit && spy != null && strike != null ? spy < strike : null,
    });
    if (r.event === "ENTER" || r.event === "MANUAL_SET_IN_TRADE") lastEntryPx = spy;
    if (isExit || r.event === "MANUAL_SET_FLAT") lastEntryPx = null;
  }
  rows.reverse(); // newest first
  return { present: true, path, rows };
}

// ---------------------------------------------------------------------------
// the payload
// ---------------------------------------------------------------------------

const hhmm = (iso: string) => iso.slice(11, 16);
const minutesBetween = (a: string, b: string) =>
  (Date.parse(`${b}Z`) - Date.parse(`${a}Z`)) / 60_000;

/** `now` is injectable for tests; production calls it with no argument. */
export async function buildM2Payload(now: Date = new Date()): Promise<M2Payload> {
  const nowEt = etNowIso(now);
  const today = nowEt.slice(0, 10);
  const [state, ledger] = await Promise.all([readState(), readLedger()]);
  const base = { nowEt, state, ledger };

  const token = process.env.TIINGO_API_KEY;
  if (!token) return { ...base, ok: false, error: "TIINGO_API_KEY not set", live: null };

  let history: Bar[];
  try {
    history = await getHistory(today, token);
  } catch (err) {
    return { ...base, ok: false, error: `Tiingo history: ${(err as Error).message}`, live: null };
  }

  let quote: { px: number; etIso: string } | null = null;
  let quoteErr: string | undefined;
  try {
    quote = quoteFromRow(await getQuoteRow(token));
  } catch (err) {
    quoteErr = `IEX unavailable (${(err as Error).message})`;
  }

  const closeHM = isEarlyClose(today) ? "13:00" : "16:00";
  const hm = hhmm(nowEt);
  const useLive =
    isSession(today) && quote != null && quote.etIso.slice(0, 10) === today && hm >= "09:30";

  let mode: M2Mode;
  let px: number;
  let hist: Bar[];
  let asOf: string;
  const note = quoteErr;
  let quoteAgeMin: number | null = null;
  if (useLive && quote) {
    px = quote.px;
    hist = history;
    asOf = today;
    quoteAgeMin = minutesBetween(quote.etIso, nowEt);
    if (hm >= closeHM) mode = "AFTER_CLOSE";
    else if (quoteAgeMin > STALE_MINUTES) mode = "STALE";
    else mode = "LIVE";
  } else {
    // Weekend / holiday / pre-open / IEX down: the last OFFICIAL close, as of that session.
    if (history.length === 0) return { ...base, ok: false, error: "no SPY history", live: null };
    const last = history[history.length - 1];
    px = last[1];
    hist = history.slice(0, -1);
    asOf = last[0];
    mode = "CLOSED";
  }

  const st = state.value ?? FLAT;
  let ev: ReturnType<typeof evaluate>;
  try {
    ev = evaluate(hist, px, asOf, st, false);
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message, live: null };
  }
  const dates = [...hist.map((b) => b[0]), asOf];

  return {
    ...base,
    ok: true,
    live: {
      mode,
      asOf,
      px,
      pxSource: mode === "CLOSED" ? "official_close" : "iex",
      quoteEt: mode === "CLOSED" || !quote ? null : hhmm(quote.etIso),
      quoteAgeMin,
      sma200: ev.sma200,
      sma5: ev.sma5,
      filterOn: ev.filterOn,
      streak: ev.streak,
      strikeIfEntered: ev.strike,
      rulesNow: ev.kinds.filter((k) => k !== "weekly"),
      holdDay: st.in_trade && st.entry_date ? holdDay(dates, st.entry_date) : null,
      note,
    },
  };
}
