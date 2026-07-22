// =============================================================================
// Sector-strength board — PURE ranking logic (no network, no Redis, no time).
// The API route fetches the ETF closes and stamps the timestamp; everything here
// is a deterministic function of the closes, so it is unit-testable in isolation
// (see scripts/jack-sector-strength-selftest.ts).
//
// Universe: the 11 SPDR sector ETFs, ranked by 3-month RELATIVE strength vs SPY
// (sector 3m% − SPY 3m%), strongest → weakest. GICS names deliberately match the
// `sector` tags already on JACK setups so the panel ties to them visually.
// =============================================================================

export interface SectorMeta {
  ticker: string;
  name: string; // GICS sector name (matches JACK setup sector tags)
}

// XL* order here is just the source list; the board is re-sorted by rs3m.
export const SECTOR_UNIVERSE: SectorMeta[] = [
  { ticker: "XLV", name: "Health Care" },
  { ticker: "XLK", name: "Information Technology" },
  { ticker: "XLF", name: "Financials" },
  { ticker: "XLI", name: "Industrials" },
  { ticker: "XLY", name: "Consumer Discretionary" },
  { ticker: "XLP", name: "Consumer Staples" },
  { ticker: "XLE", name: "Energy" },
  { ticker: "XLU", name: "Utilities" },
  { ticker: "XLB", name: "Materials" },
  { ticker: "XLRE", name: "Real Estate" },
  { ticker: "XLC", name: "Communication Services" },
];

// SPY is the relative-strength baseline (fetched alongside the 11, not shown as a row).
export const SECTOR_BASELINE = "SPY";

// Lookback windows in TRADING bars.
export const LOOKBACK = { today: 1, w1: 5, m1: 21, m3: 63 } as const;

export interface Perf {
  today: number | null;
  w1: number | null;
  m1: number | null;
  m3: number | null;
}

export interface SectorRow extends Perf {
  ticker: string;
  name: string;
  rsToday: number | null; // sector − SPY, per window
  rs1w: number | null;
  rs1m: number | null;
  rs3m: number | null; // PRIMARY rank key
}

export interface SectorBoard {
  spy: Perf | null;
  sectors: SectorRow[]; // sorted by rs3m desc, nulls last
  rsAvailable: boolean; // false when SPY's 3-month is missing (rank falls back to raw 3m)
}

/**
 * Trailing % change over `n` trading bars: (last − closes[len-1-n]) / ref × 100.
 * Honest, NOT clamped: returns null when there isn't enough history (len < n+1) or
 * the reference close is 0 — a data-short ticker sinks to the bottom rather than
 * showing a misleading partial-window number.
 */
export function pctBack(closes: number[], n: number): number | null {
  const len = closes.length;
  if (len < n + 1) return null;
  const ref = closes[len - 1 - n];
  const last = closes[len - 1];
  if (!Number.isFinite(ref) || !Number.isFinite(last) || ref === 0) return null;
  return ((last - ref) / ref) * 100;
}

function perf(closes: number[]): Perf {
  return {
    today: pctBack(closes, LOOKBACK.today),
    w1: pctBack(closes, LOOKBACK.w1),
    m1: pctBack(closes, LOOKBACK.m1),
    m3: pctBack(closes, LOOKBACK.m3),
  };
}

const rel = (a: number | null, b: number | null): number | null =>
  a != null && b != null ? a - b : null;

/**
 * Build the ranked board from close-price series keyed by ticker. Pure and
 * time-free (the caller stamps `generatedAt`).
 *
 * Rank: rs3m (sector 3m − SPY 3m) descending, nulls last. If SPY's 3-month is
 * missing (rsAvailable=false), rank by the sector's RAW 3-month instead so the
 * board still orders sensibly.
 */
export function computeSectorBoard(closesByTicker: Record<string, number[]>): SectorBoard {
  const spyCloses = closesByTicker[SECTOR_BASELINE] ?? [];
  const spy: Perf | null = spyCloses.length > 0 ? perf(spyCloses) : null;
  const rsAvailable = spy?.m3 != null;

  const sectors: SectorRow[] = SECTOR_UNIVERSE.map((meta) => {
    const p = perf(closesByTicker[meta.ticker] ?? []);
    return {
      ticker: meta.ticker,
      name: meta.name,
      ...p,
      rsToday: rel(p.today, spy?.today ?? null),
      rs1w: rel(p.w1, spy?.w1 ?? null),
      rs1m: rel(p.m1, spy?.m1 ?? null),
      rs3m: rel(p.m3, spy?.m3 ?? null),
    };
  });

  // Primary sort key: rs3m when SPY 3m exists, else raw sector m3. Nulls last.
  const key = (r: SectorRow) => (rsAvailable ? r.rs3m : r.m3);
  sectors.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka == null && kb == null) return 0;
    if (ka == null) return 1; // nulls last
    if (kb == null) return -1;
    return kb - ka; // strongest first
  });

  return { spy, sectors, rsAvailable };
}
