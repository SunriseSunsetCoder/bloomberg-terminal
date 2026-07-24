// =============================================================================
// Finnhub earnings calendar (free tier: /calendar/earnings, ~1-month forward window
// — plenty, we only look ~5 trading days out). Plain HTTPS via fetch, NO npm
// dependency. Graceful disable: FINNHUB_API_KEY unset → warn ONCE, return disabled;
// every other alert is unaffected. NEVER throws.
// =============================================================================

let warnedDisabled = false;

export function earningsEnabled(): boolean {
  return !!process.env.FINNHUB_API_KEY;
}

export interface EarningsFetchResult {
  ok: boolean;
  disabled?: boolean;
  map?: Record<string, string>; // SYMBOL -> earliest upcoming earnings date (YYYY-MM-DD)
  error?: string;
}

interface EarningsCalendarJson {
  earningsCalendar?: Array<{ symbol?: string; date?: string }>;
}

/**
 * Pure: earningsCalendar[] → { SYMBOL: earliest upcoming date >= fromISO }. Past
 * dates are ignored; when a symbol has several upcoming rows we keep the earliest.
 */
export function parseEarningsCalendar(
  json: EarningsCalendarJson | null,
  fromISO: string
): Record<string, string> {
  const map: Record<string, string> = {};
  const rows = json?.earningsCalendar ?? [];
  for (const r of rows) {
    if (!r?.symbol || !r?.date) continue;
    if (r.date < fromISO) continue; // ignore already-passed dates
    const sym = r.symbol.toUpperCase();
    if (!map[sym] || r.date < map[sym]) map[sym] = r.date;
  }
  return map;
}

/**
 * ONE calendar call for the whole window (fromISO..toISO, YYYY-MM-DD). Returns a
 * symbol→date map. {disabled:true} when the key is unset; {ok:false,error} on any
 * non-2xx / network failure (caller fires a health alert, never throws).
 */
export async function fetchEarningsMap(fromISO: string, toISO: string): Promise<EarningsFetchResult> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    if (!warnedDisabled) {
      console.warn("JACK earnings alerts disabled — FINNHUB_API_KEY unset (other alerts unaffected).");
      warnedDisabled = true;
    }
    return { ok: false, disabled: true };
  }
  try {
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromISO}&to=${toISO}&token=${key}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 150)}` };
    }
    const data = (await res.json().catch(() => null)) as EarningsCalendarJson | null;
    return { ok: true, map: parseEarningsCalendar(data, fromISO) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
