// =============================================================================
// JACK Basket Sizer — PURE sizing + combined-book aggregation (no DB, no React).
//
// Sizes the whole week's tradeable setups at once and rolls them up WITH the
// operator's existing open positions, so every capacity check reflects the real book
// rather than just the new basket.
//
// READ-ONLY w.r.t. strategy state. Nothing here writes, and nothing here re-derives
// fire detection, run-scoping, or the size map — it consumes:
//   · getPendingSetups()  — the run-scoped, owned-excluded pending set
//   · getOpenPositions()  — what you already hold
//   · computeSizing()     — shares from risk$ and stop distance
//   · isTradeableSetup()  — the frozen SIZE_MAP (Q1/Q2 = skip, never traded)
//   · computePriorityRanks() — the board's own P-rank blend
//
// Sizes are CEILINGS: a frictionless plan, not an instruction to fill every share.
// =============================================================================

import { computeSizing, isTradeableSetup, normalizeSizeBucket } from "@/lib/jack/handle-score";
import {
  computePriorityRanks,
  isFiredActionable,
  isOwnedPosition,
  rankKey,
  sortByRank,
  type RankableRow,
} from "@/lib/jack/combine-decisions";

// ---- Frozen policy knobs ----------------------------------------------------

export const MAX_SLOTS = 12;
export const MAX_PER_SECTOR = 3;
export const DEFAULT_ACCOUNT_SIZE = 70_000;
/**
 * R:R floor default — a CAPACITY dial, not an edge filter.
 *
 * The R:R sweep showed profit factor is flat (~2.7–3.2) across every R:R band, and
 * low-R:R trades actually win MORE often. So a hard floor removes profitable trades;
 * it only controls how many names compete for the same buying power. 0.75 is a light
 * touch — set it to 0 to disable, or raise it to ration capital harder. Pick between
 * setups with P-rank, not with this.
 */
export const DEFAULT_RR_FLOOR = 0.75;
export const MIN_PRICE = 5;
/** Q5 may never be sized above this, whatever the scheme says. */
export const Q5_RISK_CAP_PCT = 1.0;

export type RiskScheme = "balanced" | "aggressive";

/** Conviction-tier risk, in PERCENT of account. */
export const TIER_RISK_PCT: Record<RiskScheme, Record<"Q3" | "Q4" | "Q5", number>> = {
  balanced: { Q3: 0.3, Q4: 0.5, Q5: 0.75 },
  aggressive: { Q3: 0.35, Q4: 0.55, Q5: 0.85 },
};

/**
 * Risk % for a tier under a scheme. Unknown/untiered rows fall back to the scheme's
 * Q3 (most conservative) rather than being skipped — they still need a number.
 * The Q5 cap is applied last and unconditionally.
 */
export function riskPctFor(tier: string | null | undefined, scheme: RiskScheme): number {
  const t = (tier ?? "").toUpperCase().trim();
  const table = TIER_RISK_PCT[scheme];
  const pct = t === "Q5" ? table.Q5 : t === "Q4" ? table.Q4 : table.Q3;
  return t === "Q5" ? Math.min(pct, Q5_RISK_CAP_PCT) : pct;
}

// ---- Candidate selection ----------------------------------------------------

/** The minimum needed to decide whether a board row belongs in the basket. */
export interface BasketEligibleInput {
  firedStatus?: string | null;
  sizeBucket?: string | null;
  tier?: string | null;
  userAction?: string | null;
  userExitPrice?: number | null;
}

/**
 * Does this board row belong in the basket?
 *
 * The basket sizes what you would BUY AT THE NEXT OPEN — i.e. the board's LIVE
 * (fired) new-entry group, not the whole pending pipeline. Three gates, every one of
 * them the board's own rule rather than a re-derivation:
 *
 *   · FIRED and still actionable — isFiredActionable: 'confirmed' or 'late'. A setup
 *     that has not closed above its rim yet is not buyable, and a 'resolved' one has
 *     already hit its stop or target, so neither can be sized.
 *   · TRADEABLE — isTradeableSetup: the frozen SIZE_MAP (Q1/Q2 = skip, never entered).
 *   · NOT OWNED — isOwnedPosition: something you already hold is a position to manage,
 *     not a new entry. getPendingSetups() already excludes these; this is the safety
 *     net that keeps the rule true even if the source changes.
 */
export function isBasketEligible(row: BasketEligibleInput): boolean {
  if (isOwnedPosition(row)) return false;
  if (!isFiredActionable(row)) return false;
  return isTradeableSetup(row);
}

/**
 * Narrow a board/pending row set down to the basket's LIVE (fired) candidates.
 * Generic so it can run on PendingSetupRow straight out of the accessor.
 */
export function selectBasketCandidates<T extends BasketEligibleInput>(rows: T[]): T[] {
  return rows.filter(isBasketEligible);
}

// ---- Inputs -----------------------------------------------------------------

/** A candidate setup — the shape getPendingSetups() returns (plus manual rows). */
export interface BasketCandidate extends RankableRow {
  setupId: number | null;
  ticker: string;
  handleLowDate: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  tier?: string | null;
  sector?: string | null;
  priority?: number | null;
  sizeBucket?: string | null;
  handleScore?: number | null;
  /** Live price when known — used for the ≥$5 liquidity floor, else entry. */
  currentPrice?: number | null;
}

/** An existing holding — the shape getOpenPositions() returns. */
export interface OpenHolding {
  setupId: number | null;
  ticker: string;
  sector?: string | null;
  entry: number | null;
  stop: number | null;
  /** Shares actually held (frozen at mark) — drives open notional + open risk. */
  shares?: number | null;
  userEntryPrice?: number | null;
}

export interface BasketOptions {
  accountSize: number;
  scheme: RiskScheme;
  hideSkipTier: boolean; // hide Q1/Q2 (isTradeableSetup)
  rrFloor: number;
  /**
   * OFF by default: a below-floor row is FLAGGED but stays in the basket and in every
   * total, so nothing drops out of Σ shares / Σ risk$ / Σ reward$ without the operator
   * asking for it. Turn on to actually remove them.
   */
  hideBelowFloor?: boolean;
  minPrice: boolean; // enforce >= $5
  /** Per-row risk% overrides, keyed by rankKey — an edited row keeps its number. */
  riskPctOverrides?: Record<string, number>;
  /** Rows the operator (or trim-to-fit) removed, keyed by rankKey. */
  excluded?: Record<string, boolean>;
}

export const defaultBasketOptions = (): BasketOptions => ({
  accountSize: DEFAULT_ACCOUNT_SIZE,
  scheme: "balanced",
  hideSkipTier: true,
  rrFloor: DEFAULT_RR_FLOOR,
  hideBelowFloor: false,
  minPrice: true,
});

// ---- Per-row output ---------------------------------------------------------

export type RowFlag =
  | "below_min_price"
  | "rr_below_floor"
  | "skip_tier"
  | "stop_above_entry"
  | "duplicate_of_open"
  | "sector_cap"
  | "missing_geometry";

export interface BasketRow {
  key: string;
  setupId: number | null;
  ticker: string;
  tier: string | null;
  sector: string | null;
  /** Pn ordinal within this basket (board blend). null when the row has no priority. */
  pRank: number | null;
  priority: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskPct: number;
  riskDollars: number;
  shares: number;
  positionDollars: number;
  rewardDollars: number;
  /** (target − entry) / (entry − stop). null when geometry is unusable. */
  rr: number | null;
  /** (entry − stop) / entry, as a percent. */
  stopPct: number | null;
  pctOfAccount: number;
  flags: RowFlag[];
  /** Excluded from every total: filtered out, errored, or deselected. */
  hidden: boolean;
  /** Counted in the totals (the actionable basket). */
  included: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** R:R from geometry. null when the inputs can't produce a meaningful ratio. */
export function computeRR(entry: number | null, stop: number | null, target: number | null): number | null {
  if (entry == null || stop == null || target == null) return null;
  const risk = entry - stop;
  if (risk <= 0) return null;
  return (target - entry) / risk;
}

// ---- Combined-book totals ---------------------------------------------------

export interface SectorCount {
  sector: string;
  open: number;
  basket: number;
  total: number;
  overCap: boolean;
  openTickers: string[];
  basketTickers: string[];
}

export interface BasketTotals {
  rows: BasketRow[];
  included: BasketRow[];
  hidden: BasketRow[];

  shares: number;
  positionDollars: number;
  riskDollars: number;
  rewardDollars: number;
  /** Σ reward$ / Σ risk$ across the included basket. */
  rewardToRisk: number | null;
  grossExposurePct: number;

  // ---- combined book (open + new) ----
  openCount: number;
  openNotional: number;
  openRiskDollars: number;
  /** account − Σ open notional. What the new basket may consume. */
  buyingPower: number;
  buyingPowerRemaining: number;
  overBuyingPower: boolean;

  slotsUsed: number;
  slotsRemaining: number;
  overSlots: boolean;

  /** Σ risk$ (open + new) / account, as a percent. */
  heatPct: number;

  sectors: SectorCount[];
  sectorBreaches: string[];
  duplicates: string[];
}

const sectorOf = (s: string | null | undefined): string => {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : "Unclassified";
};

/** Notional of an open holding — prefers the actual fill, falls back to the setup entry. */
export function openNotionalOf(p: OpenHolding): number {
  const px = p.userEntryPrice ?? p.entry;
  if (px == null || p.shares == null) return 0;
  return px * p.shares;
}

/** Risk still on the table for an open holding: shares × (fill − stop), floored at 0. */
export function openRiskOf(p: OpenHolding): number {
  const px = p.userEntryPrice ?? p.entry;
  if (px == null || p.stop == null || p.shares == null) return 0;
  return Math.max(0, (px - p.stop) * p.shares);
}

/**
 * Size one candidate. Pure: flags are computed, nothing is dropped silently.
 *
 * `sectorFull` is passed in because the cap depends on the OPEN book plus whatever
 * higher-ranked basket rows already claimed the sector — a per-row function can't know
 * that on its own.
 */
function sizeRow(
  c: BasketCandidate,
  opts: BasketOptions,
  pRank: number | null,
  openTickers: Set<string>,
  sectorFull: boolean
): BasketRow {
  const key = rankKey(c);
  const flags: RowFlag[] = [];

  const riskPct = opts.riskPctOverrides?.[key] ?? riskPctFor(c.tier, opts.scheme);
  const riskDollars = (opts.accountSize * riskPct) / 100;

  const rr = computeRR(c.entry, c.stop, c.target);
  const px = c.currentPrice ?? c.entry;

  // Geometry errors first — they make every downstream number meaningless.
  if (c.entry == null || c.stop == null) flags.push("missing_geometry");
  else if (c.stop >= c.entry) flags.push("stop_above_entry");

  if (opts.minPrice && px != null && px < MIN_PRICE) flags.push("below_min_price");
  if (rr != null && rr < opts.rrFloor) flags.push("rr_below_floor");
  if (!isTradeableSetup({ sizeBucket: c.sizeBucket, tier: c.tier })) flags.push("skip_tier");
  if (openTickers.has(c.ticker.toUpperCase())) flags.push("duplicate_of_open");
  if (sectorFull) flags.push("sector_cap");

  // computeSizing owns the shares math (floor(risk$ / stop distance)) and refuses a
  // non-positive stop distance.
  const sizing = computeSizing(riskDollars, c.entry, c.stop);
  const shares = sizing.fullShares ?? 0;
  const positionDollars = c.entry != null ? shares * c.entry : 0;
  const rewardDollars = c.entry != null && c.target != null ? shares * (c.target - c.entry) : 0;
  const stopPct = c.entry != null && c.stop != null && c.entry > 0 ? ((c.entry - c.stop) / c.entry) * 100 : null;

  // A row is HIDDEN when a filter or a hard error takes it out of the basket. The
  // sector cap, the duplicate guard and the R:R floor FLAG rather than hide: the
  // operator should see the conflict and decide (trim-to-fit is what removes them
  // mechanically).
  //
  // The R:R floor is opt-in to hide (hideBelowFloor) because it is a CAPACITY dial,
  // not an edge filter — PF is flat across R:R bands, so silently dropping low-R:R
  // rows would remove profitable trades from the plan AND from the totals.
  const excluded = opts.excluded?.[key] === true;
  const hidden =
    excluded ||
    flags.includes("missing_geometry") ||
    flags.includes("stop_above_entry") ||
    (opts.hideSkipTier && flags.includes("skip_tier")) ||
    flags.includes("below_min_price") ||
    (opts.hideBelowFloor === true && flags.includes("rr_below_floor"));

  return {
    key,
    setupId: c.setupId,
    ticker: c.ticker.toUpperCase(),
    tier: c.tier ?? null,
    sector: sectorOf(c.sector),
    pRank,
    priority: c.priority ?? null,
    entry: c.entry,
    stop: c.stop,
    target: c.target,
    riskPct,
    riskDollars: round2(riskDollars),
    shares,
    positionDollars: round2(positionDollars),
    rewardDollars: round2(rewardDollars),
    rr: rr != null ? round2(rr) : null,
    stopPct: stopPct != null ? round2(stopPct) : null,
    pctOfAccount: opts.accountSize > 0 ? round2((positionDollars / opts.accountSize) * 100) : 0,
    flags,
    hidden,
    included: !hidden,
  };
}

/**
 * Size the basket and roll it up with the open book.
 *
 * Candidates are processed in P-rank order so the sector cap is claimed by the BEST
 * setups first — a 4th Energy name is flagged, not the arbitrary one that happened to
 * sort last.
 */
export function computeBasket(
  candidates: BasketCandidate[],
  open: OpenHolding[],
  opts: BasketOptions
): BasketTotals {
  // Rank with the board's own blend (priority DESC → bucket → handle_score → stable).
  const ranks = computePriorityRanks(candidates);
  const ordered = sortByRank(candidates, ranks);

  const openTickers = new Set(open.map((p) => p.ticker.toUpperCase()));
  const openNotional = open.reduce((n, p) => n + openNotionalOf(p), 0);
  const openRiskDollars = open.reduce((n, p) => n + openRiskOf(p), 0);

  // Sector occupancy starts from the OPEN book — that is the whole point of the
  // combined view. Basket rows then claim seats in rank order.
  const sectorOpen = new Map<string, string[]>();
  for (const p of open) {
    const k = sectorOf(p.sector);
    sectorOpen.set(k, [...(sectorOpen.get(k) ?? []), p.ticker.toUpperCase()]);
  }
  const sectorClaimed = new Map<string, string[]>();

  const rows: BasketRow[] = [];
  for (const c of ordered) {
    const sec = sectorOf(c.sector);
    const taken = (sectorOpen.get(sec)?.length ?? 0) + (sectorClaimed.get(sec)?.length ?? 0);
    const row = sizeRow(c, opts, ranks.get(rankKey(c)) ?? null, openTickers, taken >= MAX_PER_SECTOR);
    // Only an INCLUDED row consumes a sector seat — a filtered-out row must not push a
    // later, valid one over the cap.
    if (row.included) sectorClaimed.set(sec, [...(sectorClaimed.get(sec) ?? []), row.ticker]);
    rows.push(row);
  }

  const included = rows.filter((r) => r.included);
  const hidden = rows.filter((r) => r.hidden);

  const shares = included.reduce((n, r) => n + r.shares, 0);
  const positionDollars = round2(included.reduce((n, r) => n + r.positionDollars, 0));
  const riskDollars = round2(included.reduce((n, r) => n + r.riskDollars, 0));
  const rewardDollars = round2(included.reduce((n, r) => n + r.rewardDollars, 0));

  const buyingPower = round2(opts.accountSize - openNotional);
  const buyingPowerRemaining = round2(buyingPower - positionDollars);

  const sectorNames = new Set<string>([...sectorOpen.keys(), ...included.map((r) => sectorOf(r.sector))]);
  const sectors: SectorCount[] = [...sectorNames]
    .map((sector) => {
      const openTk = sectorOpen.get(sector) ?? [];
      const basketTk = included.filter((r) => r.sector === sector).map((r) => r.ticker);
      const total = openTk.length + basketTk.length;
      return {
        sector,
        open: openTk.length,
        basket: basketTk.length,
        total,
        overCap: total > MAX_PER_SECTOR,
        openTickers: openTk,
        basketTickers: basketTk,
      };
    })
    .sort((a, b) => b.total - a.total || a.sector.localeCompare(b.sector));

  const slotsUsed = open.length + included.length;

  return {
    rows,
    included,
    hidden,
    shares,
    positionDollars,
    riskDollars,
    rewardDollars,
    rewardToRisk: riskDollars > 0 ? round2(rewardDollars / riskDollars) : null,
    grossExposurePct: opts.accountSize > 0 ? round2((positionDollars / opts.accountSize) * 100) : 0,
    openCount: open.length,
    openNotional: round2(openNotional),
    openRiskDollars: round2(openRiskDollars),
    buyingPower,
    buyingPowerRemaining,
    overBuyingPower: positionDollars > buyingPower,
    slotsUsed,
    slotsRemaining: MAX_SLOTS - slotsUsed,
    overSlots: slotsUsed > MAX_SLOTS,
    heatPct: opts.accountSize > 0 ? round2(((riskDollars + openRiskDollars) / opts.accountSize) * 100) : 0,
    sectors,
    sectorBreaches: sectors.filter((s) => s.overCap).map((s) => s.sector),
    duplicates: rows.filter((r) => r.flags.includes("duplicate_of_open")).map((r) => r.ticker),
  };
}

// ---- Trim to fit ------------------------------------------------------------

export interface TrimResult {
  /** Rows dropped, worst-first, in the order they were dropped. */
  trimmed: BasketRow[];
  /** `excluded` map to feed back into BasketOptions. */
  excluded: Record<string, boolean>;
  totals: BasketTotals;
  /** True when the basket fits every constraint after trimming. */
  fits: boolean;
  reasons: string[];
}

const fitsAll = (t: BasketTotals): boolean =>
  !t.overBuyingPower && !t.overSlots && t.sectorBreaches.length === 0;

/**
 * Drop the LOWEST-P-rank rows one at a time until the basket fits buying power, the
 * 12-slot cap, and every per-sector cap.
 *
 * Capital rationing always sheds your WORST setups first — never the highest-conviction
 * ones. A row with no P-rank sorts as worst (it carries no scanner pick-order, so it is
 * the first thing to go).
 *
 * Pure and non-mutating: returns the exclusion map for the caller to apply.
 */
export function trimToFit(
  candidates: BasketCandidate[],
  open: OpenHolding[],
  opts: BasketOptions
): TrimResult {
  const excluded: Record<string, boolean> = { ...(opts.excluded ?? {}) };
  const trimmed: BasketRow[] = [];
  const reasons: string[] = [];

  let totals = computeBasket(candidates, open, { ...opts, excluded });

  // Bounded by the row count — every pass removes exactly one row.
  for (let guard = 0; guard < candidates.length && !fitsAll(totals); guard++) {
    if (totals.overBuyingPower) reasons.push("over buying power");
    if (totals.overSlots) reasons.push("over the 12-slot cap");
    for (const s of totals.sectorBreaches) reasons.push(`${s} over the ${MAX_PER_SECTOR}-name sector cap`);

    // Worst = highest P-rank number; unranked (null) is worse than any ranked row.
    const worst = [...totals.included].sort((a, b) => {
      const ra = a.pRank ?? Number.POSITIVE_INFINITY;
      const rb = b.pRank ?? Number.POSITIVE_INFINITY;
      return rb - ra;
    })[0];
    if (!worst) break;

    excluded[worst.key] = true;
    trimmed.push(worst);
    totals = computeBasket(candidates, open, { ...opts, excluded });
  }

  return {
    trimmed,
    excluded,
    totals,
    fits: fitsAll(totals),
    reasons: [...new Set(reasons)],
  };
}

// ---- Execution bridge -------------------------------------------------------

/**
 * Tab-separated order list for the broker: ticker · shares · stop · entry · target.
 * Fidelity has no API, so this clipboard payload IS the execution path.
 */
export function buildOrderList(totals: BasketTotals): string {
  const lines = ["TICKER\tSHARES\tSTOP\tENTRY\tTARGET"];
  for (const r of totals.included) {
    lines.push(
      [
        r.ticker,
        r.shares,
        r.stop != null ? r.stop.toFixed(2) : "",
        r.entry != null ? r.entry.toFixed(2) : "",
        r.target != null ? r.target.toFixed(2) : "",
      ].join("\t")
    );
  }
  return lines.join("\n");
}

/** Human-readable flag labels for the UI + the printable ticket. */
export const FLAG_LABEL: Record<RowFlag, string> = {
  below_min_price: `< $${MIN_PRICE}`,
  rr_below_floor: "R:R below floor",
  skip_tier: "SKIP tier (Q1/Q2)",
  stop_above_entry: "stop ≥ entry",
  duplicate_of_open: "already open",
  sector_cap: `sector cap (${MAX_PER_SECTOR})`,
  missing_geometry: "missing entry/stop",
};

/** Normalized bucket for display — re-exported so the view doesn't reach into handle-score. */
export { normalizeSizeBucket };
