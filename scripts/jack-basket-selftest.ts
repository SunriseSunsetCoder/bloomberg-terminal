/*
 * JACK Basket Sizer self-test — PURE (lib/jack/basket.ts). No DB, no network, no React.
 *
 * The point of this page is the COMBINED BOOK: every capacity check has to count the
 * positions you already hold, not just the new week. Most of these cases exist to prove
 * an open position is actually being counted.
 *
 * Run:  npx tsx scripts/jack-basket-selftest.ts
 */
import {
  computeBasket,
  selectBasketCandidates,
  isBasketEligible,
  trimToFit,
  buildOrderList,
  computeRR,
  riskPctFor,
  defaultBasketOptions,
  MAX_SLOTS,
  MAX_PER_SECTOR,
  Q5_RISK_CAP_PCT,
  TIER_RISK_PCT,
  DEFAULT_ACCOUNT_SIZE,
  DEFAULT_RR_FLOOR,
  type BasketCandidate,
  type BasketOptions,
  type OpenHolding,
} from "../lib/jack/basket";
import { isTradeableSetup } from "../lib/jack/handle-score";
import { isInLiveDisplayGroup } from "../lib/jack/combine-decisions";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string | null): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const near = (a: number | null | undefined, b: number, eps = 0.01) => a != null && Math.abs(a - b) < eps;

const HLD = "2026-08-10";
let seq = 0;
const cand = (p: Partial<BasketCandidate> & { ticker: string }): BasketCandidate => ({
  setupId: ++seq,
  handleLowDate: HLD,
  entry: 100,
  stop: 95,
  target: 115,
  tier: "Q5",
  sector: "Technology",
  priority: 5,
  sizeBucket: "full",
  handleScore: 0.7,
  ...p,
});
const hold = (p: Partial<OpenHolding> & { ticker: string }): OpenHolding => ({
  setupId: ++seq,
  entry: 50,
  stop: 45,
  shares: 100,
  sector: "Energy",
  ...p,
});
const opts = (o: Partial<BasketOptions> = {}): BasketOptions => ({ ...defaultBasketOptions(), ...o });

// ===========================================================================
console.log("\n[1] Tier-risk map + the Q5 hard cap");
// ===========================================================================
{
  check("balanced Q3 0.30%", riskPctFor("Q3", "balanced") === 0.3);
  check("balanced Q4 0.50%", riskPctFor("Q4", "balanced") === 0.5);
  check("balanced Q5 0.75%", riskPctFor("Q5", "balanced") === 0.75);
  check("aggressive Q3 0.35%", riskPctFor("Q3", "aggressive") === 0.35);
  check("aggressive Q4 0.55%", riskPctFor("Q4", "aggressive") === 0.55);
  check("aggressive Q5 0.85%", riskPctFor("Q5", "aggressive") === 0.85);
  check("lowercase tier normalizes", riskPctFor("q5", "balanced") === 0.75);
  check("unknown tier falls back to the conservative Q3", riskPctFor(null, "balanced") === 0.3);
  check("every scheme's Q5 sits under the 1.0% cap", Object.values(TIER_RISK_PCT).every((t) => t.Q5 <= Q5_RISK_CAP_PCT));
  check(
    "the Q5 cap is enforced, not merely respected by the table",
    riskPctFor("Q5", "aggressive") === Math.min(TIER_RISK_PCT.aggressive.Q5, Q5_RISK_CAP_PCT)
  );
}

// ===========================================================================
console.log("\n[2] Per-row sizing math");
// ===========================================================================
{
  // $70k × 0.75% = $525 risk; stop distance 5 → floor(525/5) = 105 shares.
  const t = computeBasket([cand({ ticker: "AAA" })], [], opts());
  const r = t.rows[0];
  check("risk$ = account × risk%", near(r.riskDollars, 525), String(r.riskDollars));
  check("shares = floor(risk$ / stop distance)", r.shares === 105, String(r.shares));
  check("position$ = shares × entry", near(r.positionDollars, 10_500), String(r.positionDollars));
  check("reward$ = shares × (target − entry)", near(r.rewardDollars, 1575), String(r.rewardDollars));
  check("R:R = (target − entry)/(entry − stop) = 3.00", near(r.rr, 3));
  check("stop% = (entry − stop)/entry", near(r.stopPct, 5));
  check("%acct = position$/account", near(r.pctOfAccount, 15));
  check("totals mirror the single row", near(t.positionDollars, 10_500) && near(t.riskDollars, 525));
  check("reward:risk on the basket = 3.00×", near(t.rewardToRisk, 3));
}
{
  check("computeRR null when stop ≥ entry", computeRR(100, 100, 115) === null);
  check("computeRR null on missing geometry", computeRR(null, 95, 115) === null);
  const t = computeBasket([cand({ ticker: "BAD", stop: 105 })], [], opts());
  check("stop above entry is flagged", t.rows[0].flags.includes("stop_above_entry"));
  check("  and the row is excluded from totals", t.rows[0].hidden && t.included.length === 0);
  check("  with zero shares, never a negative size", t.rows[0].shares === 0);
}
{
  // Per-row risk% override wins over the tier default.
  const key = `AAA|${HLD}`;
  const t = computeBasket([cand({ ticker: "AAA" })], [], opts({ riskPctOverrides: { [key]: 0.25 } }));
  check("per-row risk% override applies", near(t.rows[0].riskDollars, 175), String(t.rows[0].riskDollars));
  check("  and re-sizes the shares", t.rows[0].shares === 35, String(t.rows[0].shares));
}

// ===========================================================================
console.log("\n[3] Filters — R:R floor, $5, Q1/Q2");
// ===========================================================================
{
  // The floor is a CAPACITY dial, not an edge filter: PF is flat across R:R bands, so
  // a below-floor row is FLAGGED but must stay in the basket and in every total.
  check(`default R:R floor is 0.75 (not 1.0)`, DEFAULT_RR_FLOOR === 0.75, String(DEFAULT_RR_FLOOR));
  check("  and defaultBasketOptions carries it", defaultBasketOptions().rrFloor === 0.75);
  check("  with hide-below-floor OFF by default", defaultBasketOptions().hideBelowFloor === false);

  // target 102 → R:R = 2/5 = 0.4, below the 0.75 default floor.
  const rows = [cand({ ticker: "LOWRR", target: 102 }), cand({ ticker: "GOODRR", target: 115 })];
  const t = computeBasket(rows, [], opts());
  const low = t.rows.find((r) => r.ticker === "LOWRR")!;
  check("R:R below floor is flagged", low.flags.includes("rr_below_floor"));
  check("  but NOT hidden", !low.hidden);
  check("  and stays in the basket", t.included.length === 2);
  check("  Σ risk$ still counts it", near(t.riskDollars, 1050), String(t.riskDollars));
  check("  Σ shares still counts it", t.shares === 210, String(t.shares));
  check("  Σ reward$ still counts it", near(t.rewardDollars, 1575 + 210), String(t.rewardDollars));

  // A row at exactly 0.75 is NOT below the floor (strict <).
  const atFloor = computeBasket([cand({ ticker: "EXACT", target: 103.75 })], [], opts());
  check("R:R exactly at the floor is not flagged", !atFloor.rows[0].flags.includes("rr_below_floor"), String(atFloor.rows[0].rr));

  // Opt-in hide reproduces the old behaviour, explicitly.
  const hidden = computeBasket(rows, [], opts({ hideBelowFloor: true }));
  check("hideBelowFloor=true drops it from the basket", hidden.included.length === 1 && hidden.included[0].ticker === "GOODRR");
  check("  and from the totals", near(hidden.riskDollars, 525));
  check("  the flag is still reported on the hidden row", hidden.rows.find((r) => r.ticker === "LOWRR")!.flags.includes("rr_below_floor"));
}
{
  // Floor 0 = off: nothing is flagged, nothing is excluded, whatever the geometry.
  const rows = [
    cand({ ticker: "TINY", target: 100.5 }), // R:R 0.1
    cand({ ticker: "SMALL", target: 102 }), // R:R 0.4
    cand({ ticker: "BIG", target: 115 }), // R:R 3.0
  ];
  const t = computeBasket(rows, [], opts({ rrFloor: 0 }));
  check("floor 0 flags nothing", t.rows.every((r) => !r.flags.includes("rr_below_floor")));
  check("  keeps every row", t.included.length === 3, String(t.included.length));
  check("  excludes none from the totals", t.hidden.length === 0);
  check("  Σ risk$ covers all three", near(t.riskDollars, 1575), String(t.riskDollars));
  check("  and even hideBelowFloor can drop nothing at floor 0",
    computeBasket(rows, [], opts({ rrFloor: 0, hideBelowFloor: true })).included.length === 3);

  const raised = computeBasket(rows, [], opts({ rrFloor: 2 }));
  check("raising the floor to 2.0 flags the two low rows", raised.rows.filter((r) => r.flags.includes("rr_below_floor")).length === 2);
  check("  but STILL keeps them in the totals (flag-only)", raised.included.length === 3);
}
{
  const t = computeBasket([cand({ ticker: "CHEAP", entry: 4, stop: 3.5, target: 6 })], [], opts());
  check("price < $5 is flagged", t.rows[0].flags.includes("below_min_price"));
  check("  and hidden", t.rows[0].hidden && t.included.length === 0);
  const off = computeBasket([cand({ ticker: "CHEAP", entry: 4, stop: 3.5, target: 6 })], [], opts({ minPrice: false }));
  check("toggling the $5 floor off includes it", off.included.length === 1);
}
{
  const rows = [
    cand({ ticker: "Q1X", tier: "Q1", sizeBucket: "skip" }),
    cand({ ticker: "Q2X", tier: "Q2", sizeBucket: null }),
    cand({ ticker: "Q5X", tier: "Q5", sizeBucket: "full" }),
  ];
  const t = computeBasket(rows, [], opts());
  check("Q1 is flagged skip-tier", t.rows.find((r) => r.ticker === "Q1X")!.flags.includes("skip_tier"));
  check("Q2 is flagged skip-tier", t.rows.find((r) => r.ticker === "Q2X")!.flags.includes("skip_tier"));
  check("both hidden by default", t.included.length === 1 && t.included[0].ticker === "Q5X");
  check("hidden rows contribute nothing to totals", near(t.riskDollars, 525) && near(t.positionDollars, 10_500));
  const shown = computeBasket(rows, [], opts({ hideSkipTier: false }));
  check("un-hiding shows them but keeps the flag", shown.included.length === 3 && shown.rows[0].flags.includes("skip_tier") === shown.rows[0].flags.includes("skip_tier"));
}

// ===========================================================================
console.log("\n[4] Sector counts INCLUDE open positions");
// ===========================================================================
{
  // 2 open Energy + 2 new Energy = 4 → over the cap of 3.
  const open = [hold({ ticker: "OPEN1", sector: "Energy" }), hold({ ticker: "OPEN2", sector: "Energy" })];
  const rows = [
    cand({ ticker: "NEW1", sector: "Energy", priority: 9 }),
    cand({ ticker: "NEW2", sector: "Energy", priority: 8 }),
  ];
  const t = computeBasket(rows, open, opts());
  const energy = t.sectors.find((s) => s.sector === "Energy")!;
  check("sector total counts open + new", energy.total === 4, String(energy.total));
  check("  open leg is 2", energy.open === 2);
  check("  basket leg is 2", energy.basket === 2);
  check("  and it is over cap", energy.overCap && t.sectorBreaches.includes("Energy"));
  check("the row that breaches the cap is flagged", t.rows.some((r) => r.flags.includes("sector_cap")));
  check("the cap is claimed in P-rank order (NEW1 first)", t.rows[0].ticker === "NEW1" && !t.rows[0].flags.includes("sector_cap"));
  check("  so the WORSE row takes the flag", t.rows[1].ticker === "NEW2" && t.rows[1].flags.includes("sector_cap"));
  check("sector panel lists the tickers", energy.openTickers.join(",") === "OPEN1,OPEN2" && energy.basketTickers.join(",") === "NEW1,NEW2");
}
{
  // The same 3 new names in a sector are FINE when nothing is open there.
  const rows = ["A", "B", "C"].map((tk, i) => cand({ ticker: tk, sector: "Health Care", priority: 9 - i }));
  const t = computeBasket(rows, [], opts());
  check("3 new names with no open position is exactly at cap, not over", t.sectors[0].total === MAX_PER_SECTOR && !t.sectors[0].overCap);
  // One open name in that sector tips it over.
  const t2 = computeBasket(rows, [hold({ ticker: "HELD", sector: "Health Care" })], opts());
  check("one OPEN name in the sector tips the same basket over", t2.sectors[0].total === 4 && t2.sectors[0].overCap);
}
{
  const t = computeBasket([cand({ ticker: "NOSEC", sector: null })], [], opts());
  check("a null sector buckets as 'Unclassified' rather than crashing", t.sectors[0].sector === "Unclassified");
}

// ===========================================================================
console.log("\n[5] Buying power = account − open notional");
// ===========================================================================
{
  // 2 holdings × 100 sh × $50 = $10,000 open notional.
  const open = [hold({ ticker: "H1" }), hold({ ticker: "H2" })];
  const t = computeBasket([], open, opts());
  check("open notional summed from shares × fill", near(t.openNotional, 10_000), String(t.openNotional));
  check("buying power = account − open notional", near(t.buyingPower, 60_000), String(t.buyingPower));
  check("nothing in the basket → nothing consumed", near(t.buyingPowerRemaining, 60_000));
  check("not over buying power", !t.overBuyingPower);
}
{
  // Open notional uses the ACTUAL fill when present, not the setup entry.
  const t = computeBasket([], [hold({ ticker: "H1", entry: 50, userEntryPrice: 60, shares: 100 })], opts());
  check("open notional prefers the user fill", near(t.openNotional, 6000), String(t.openNotional));
}
{
  // 6 × $10,500 = $63,000 of basket against $60,000 available → over.
  const open = [hold({ ticker: "H1" }), hold({ ticker: "H2" })];
  const rows = Array.from({ length: 6 }, (_, i) => cand({ ticker: `T${i}`, sector: `S${i}`, priority: 9 - i }));
  const t = computeBasket(rows, open, opts());
  check("basket over available buying power is flagged", t.overBuyingPower, `${t.positionDollars} vs ${t.buyingPower}`);
  check("  remaining goes negative by the overage", near(t.buyingPowerRemaining, -3000), String(t.buyingPowerRemaining));
}

// ===========================================================================
console.log("\n[6] Heat and slots count the open book too");
// ===========================================================================
{
  // Open risk: 100 sh × (50 − 45) = $500 each → $1,000. New: 1 × $525.
  const open = [hold({ ticker: "H1" }), hold({ ticker: "H2" })];
  const t = computeBasket([cand({ ticker: "NEW1" })], open, opts());
  check("open risk$ summed", near(t.openRiskDollars, 1000), String(t.openRiskDollars));
  check("heat = (open risk + new risk)/account", near(t.heatPct, ((1000 + 525) / DEFAULT_ACCOUNT_SIZE) * 100), String(t.heatPct));
  check("slots used = open + new", t.slotsUsed === 3, String(t.slotsUsed));
  check("slots remaining counts down from 12", t.slotsRemaining === MAX_SLOTS - 3);
  check("not over slots", !t.overSlots);
}
{
  const open = Array.from({ length: 10 }, (_, i) => hold({ ticker: `H${i}`, sector: `S${i}` }));
  const rows = Array.from({ length: 4 }, (_, i) => cand({ ticker: `N${i}`, sector: `X${i}`, priority: 9 - i }));
  const t = computeBasket(rows, open, opts());
  check("10 open + 4 new exceeds the 12-slot cap", t.overSlots && t.slotsUsed === 14, String(t.slotsUsed));
  check("  slots remaining goes negative", t.slotsRemaining === -2);
}

// ===========================================================================
console.log("\n[7] Duplicate-of-open guard");
// ===========================================================================
{
  const open = [hold({ ticker: "DUPE", sector: "Technology" })];
  const t = computeBasket([cand({ ticker: "DUPE" }), cand({ ticker: "FRESH" })], open, opts());
  const dupe = t.rows.find((r) => r.ticker === "DUPE")!;
  check("a ticker already held is flagged", dupe.flags.includes("duplicate_of_open"));
  check("  and surfaces in totals.duplicates", t.duplicates.includes("DUPE"));
  check("  but is NOT auto-hidden (the operator decides)", !dupe.hidden);
  check("case-insensitive match against the open book", computeBasket([cand({ ticker: "dupe" })], open, opts()).rows[0].flags.includes("duplicate_of_open"));
}

// ===========================================================================
console.log("\n[8] Trim to fit — sheds the LOWEST P-rank first");
// ===========================================================================
{
  // 6 rows × $10,500 = $63,000 against $60,000 available.
  const open = [hold({ ticker: "H1" }), hold({ ticker: "H2" })];
  const rows = Array.from({ length: 6 }, (_, i) => cand({ ticker: `T${i}`, sector: `S${i}`, priority: 100 - i }));
  const before = computeBasket(rows, open, opts());
  check("precondition: over buying power", before.overBuyingPower);

  const res = trimToFit(rows, open, opts());
  check("trim makes it fit", res.fits, JSON.stringify(res.reasons));
  check("  exactly one row was dropped", res.trimmed.length === 1, String(res.trimmed.length));
  check("  and it was the WORST P-rank (T5, P6)", res.trimmed[0].ticker === "T5", res.trimmed[0].ticker);
  check("  the survivors are the best five", res.totals.included.map((r) => r.ticker).join(",") === "T0,T1,T2,T3,T4");
  check("  and now inside buying power", !res.totals.overBuyingPower);
  check("  the reason is reported", res.reasons.some((r) => r.includes("buying power")));
}
{
  // Trim also resolves a SECTOR breach, still worst-first.
  const open = [hold({ ticker: "E1", sector: "Energy" })];
  const rows = [
    cand({ ticker: "BEST", sector: "Energy", priority: 99 }),
    cand({ ticker: "MID", sector: "Energy", priority: 50 }),
    cand({ ticker: "WORST", sector: "Energy", priority: 1 }),
  ];
  const res = trimToFit(rows, open, opts());
  check("sector breach is trimmed away", res.fits && res.totals.sectorBreaches.length === 0);
  check("  the lowest P-rank went first", res.trimmed[0].ticker === "WORST", res.trimmed[0].ticker);
  check("  1 open + 2 new = exactly at cap", res.totals.sectors[0].total === MAX_PER_SECTOR);
  check("  reason names the sector cap", res.reasons.some((r) => r.includes("Energy")));
}
{
  // Over the slot cap only.
  const open = Array.from({ length: 11 }, (_, i) => hold({ ticker: `H${i}`, sector: `S${i}`, shares: 1, entry: 1 }));
  const rows = Array.from({ length: 3 }, (_, i) => cand({ ticker: `N${i}`, sector: `X${i}`, priority: 9 - i }));
  const res = trimToFit(rows, open, opts());
  check("slot overflow trims to exactly 12", res.fits && res.totals.slotsUsed === MAX_SLOTS, String(res.totals.slotsUsed));
  check("  dropped the two worst", res.trimmed.map((r) => r.ticker).join(",") === "N2,N1", res.trimmed.map((r) => r.ticker).join(","));
}
{
  // Unranked rows are the worst of all — they go first.
  const open = [hold({ ticker: "H1" }), hold({ ticker: "H2" })];
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => cand({ ticker: `R${i}`, sector: `S${i}`, priority: 50 - i })),
    cand({ ticker: "NOPRIO", sector: "SX", priority: null }),
  ];
  const res = trimToFit(rows, open, opts());
  check("an unranked row is shed before any ranked one", res.trimmed[0].ticker === "NOPRIO", res.trimmed[0].ticker);
}
{
  const t = trimToFit([cand({ ticker: "ONE" })], [], opts());
  check("a basket that already fits is left alone", t.trimmed.length === 0 && t.fits);
}

// ===========================================================================
console.log("\n[9] Order list + P-rank ordering");
// ===========================================================================
{
  const rows = [
    cand({ ticker: "LOW", priority: 1, sector: "A" }),
    cand({ ticker: "HIGH", priority: 99, sector: "B" }),
    cand({ ticker: "MID", priority: 50, sector: "C" }),
  ];
  const t = computeBasket(rows, [], opts());
  check("rows come out in P-rank order", t.rows.map((r) => r.ticker).join(",") === "HIGH,MID,LOW", t.rows.map((r) => r.ticker).join(","));
  check("P1 is the highest priority", t.rows[0].pRank === 1 && t.rows[0].ticker === "HIGH");

  const list = buildOrderList(t);
  const lines = list.split("\n");
  check("order list has a header + one line per included row", lines.length === 4, String(lines.length));
  check("  header is tab-separated", lines[0] === "TICKER\tSHARES\tSTOP\tENTRY\tTARGET");
  check("  first data line is the best setup", lines[1].startsWith("HIGH\t105\t95.00\t100.00\t115.00"), lines[1]);
  check("  hidden rows are excluded from the order list", !buildOrderList(computeBasket([cand({ ticker: "CHEAP", entry: 4, stop: 3.5, target: 6 })], [], opts())).includes("CHEAP"));
}

// ===========================================================================
console.log("\n[10] Empty / degenerate inputs");
// ===========================================================================
{
  const t = computeBasket([], [], opts());
  check("empty basket → zeroed totals, no NaN", t.shares === 0 && t.positionDollars === 0 && t.riskDollars === 0);
  check("  reward:risk is null, not NaN", t.rewardToRisk === null);
  check("  heat 0, all slots free", t.heatPct === 0 && t.slotsRemaining === MAX_SLOTS);
  check("  buying power = the whole account", near(t.buyingPower, DEFAULT_ACCOUNT_SIZE));
  check("  no sectors, no breaches", t.sectors.length === 0 && t.sectorBreaches.length === 0);
}
{
  const t = computeBasket([cand({ ticker: "NOGEO", entry: null, stop: null })], [], opts());
  check("missing geometry is flagged and hidden", t.rows[0].flags.includes("missing_geometry") && t.rows[0].hidden);
  check("  contributes nothing", t.included.length === 0 && t.positionDollars === 0);
}

// ===========================================================================
console.log("\n[11] Basket sources the board's LIVE DISPLAY GROUP");
// ===========================================================================
{
  // A board row as getCurrentBoard() returns it: `section` is the DB section, and a
  // fired pending row is promoted for display. The basket must mirror that grouping.
  const board = (p: Partial<BasketCandidate> & { ticker: string; section: "live" | "pending" } & Record<string, unknown>) => ({
    ...cand({ ticker: p.ticker }),
    ...p,
  });

  const rows = [
    // THE REGRESSION: validated-LIVE, no fired_at at all. Must appear.
    board({ ticker: "UMBF", section: "live", firedStatus: null, firedAt: null }),
    board({ ticker: "THC", section: "live", firedStatus: null, firedAt: null }),
    board({ ticker: "TRGP", section: "live", firedStatus: null, firedAt: null }),
    // A fired-promoted PENDING row — also in the LIVE group.
    board({ ticker: "MDLZ", section: "pending", firedStatus: "confirmed", firedAt: "2026-08-14" }),
    board({ ticker: "LATEFIRE", section: "pending", firedStatus: "late", firedAt: "2026-08-12" }),
    // Not in the group: un-fired pending, and a fired-but-resolved one.
    board({ ticker: "STILLPENDING", section: "pending", firedStatus: null }),
    board({ ticker: "RESOLVED", section: "pending", firedStatus: "resolved", firedAt: "2026-08-10" }),
    // Excluded by the basket's own gates even though they ARE in the LIVE group.
    board({ ticker: "OWNEDLIVE", section: "live", userAction: "TRADED", userExitPrice: null }),
    board({ ticker: "Q1LIVE", section: "live", tier: "Q1", sizeBucket: "skip" }),
    board({ ticker: "Q2LIVE", section: "live", tier: "Q2", sizeBucket: null }),
    board({ ticker: "RETIRED", section: "live", retiredAt: "2026-08-01" }),
    // Traded-then-EXITED is not owned — buyable again.
    board({ ticker: "REENTRY", section: "live", userAction: "TRADED", userExitPrice: 130 }),
  ] as unknown as BasketCandidate[];

  const picked = selectBasketCandidates(rows as never).map((r) => (r as unknown as { ticker: string }).ticker).sort();

  check("a validated-LIVE setup with fired_at NULL IS in the basket (the exact miss)",
    picked.includes("UMBF") && picked.includes("THC") && picked.includes("TRGP"), picked.join(","));
  check("a fired-promoted PENDING setup is also in the basket",
    picked.includes("MDLZ") && picked.includes("LATEFIRE"), picked.join(","));
  check("un-fired pending is NOT", !picked.includes("STILLPENDING"));
  check("fired-but-RESOLVED is NOT", !picked.includes("RESOLVED"));
  check("an owned live setup is NOT (it belongs in OPEN POSITIONS)", !picked.includes("OWNEDLIVE"));
  check("Q1 SKIP is NOT", !picked.includes("Q1LIVE"));
  check("Q2 SKIP is NOT", !picked.includes("Q2LIVE"));
  check("a retired setup is NOT", !picked.includes("RETIRED"));
  check("a traded-then-EXITED live setup IS (re-entry is buyable)", picked.includes("REENTRY"));
  check("the basket set is exactly the expected six",
    picked.join(",") === "LATEFIRE,MDLZ,REENTRY,THC,TRGP,UMBF", picked.join(","));

  // Per-row predicate, matching the board's grouping rule.
  check("isBasketEligible: validated-live, no fire -> true",
    isBasketEligible({ section: "live", sizeBucket: "full", tier: "Q5" }));
  check("isBasketEligible: pending + confirmed -> true",
    isBasketEligible({ section: "pending", firedStatus: "confirmed", sizeBucket: "full", tier: "Q5" }));
  check("isBasketEligible: pending, no fire -> false",
    !isBasketEligible({ section: "pending", firedStatus: null, sizeBucket: "full", tier: "Q5" }));
  check("isBasketEligible: pending + resolved -> false",
    !isBasketEligible({ section: "pending", firedStatus: "resolved", sizeBucket: "full", tier: "Q5" }));
  check("isBasketEligible: already-promoted row (dbSection pending, section live) -> true",
    isBasketEligible({ section: "live", dbSection: "pending", firedStatus: "confirmed", sizeBucket: "full", tier: "Q5" }));
  check("isBasketEligible: owned -> false",
    !isBasketEligible({ section: "live", sizeBucket: "full", userAction: "TRADED", userExitPrice: null }));
  check("isBasketEligible: retired -> false",
    !isBasketEligible({ section: "live", sizeBucket: "full", retiredAt: "2026-08-01" }));

  // ACCEPTANCE: basket row count == board LIVE-group count, minus owned and SKIP.
  const liveGroup = (rows as unknown as Array<Parameters<typeof isInLiveDisplayGroup>[0]>).filter(isInLiveDisplayGroup);
  const ownedOrSkip = liveGroup.filter((r) => {
    const x = r as { userAction?: string | null; userExitPrice?: number | null; tier?: string | null; sizeBucket?: string | null; retiredAt?: string | null };
    return (x.userAction === "TRADED" && x.userExitPrice == null) || x.retiredAt != null ||
      !isTradeableSetup({ sizeBucket: x.sizeBucket, tier: x.tier });
  }).length;
  check("basket count == LIVE-group count minus owned/SKIP/retired",
    picked.length === liveGroup.length - ownedOrSkip, `${picked.length} vs ${liveGroup.length} - ${ownedOrSkip}`);

  // And the sized basket actually produces numbers for a validated-live row.
  const sized = computeBasket(selectBasketCandidates(rows as never) as unknown as BasketCandidate[], [], opts());
  const umbf = sized.rows.find((r) => r.ticker === "UMBF")!;
  check("a validated-live row is fully sized", umbf.shares > 0 && umbf.riskDollars > 0 && umbf.rr != null,
    JSON.stringify({ shares: umbf.shares, risk: umbf.riskDollars, rr: umbf.rr }));
  check("  and the basket is NOT the empty state", sized.rows.length === 6, String(sized.rows.length));
}

// ===========================================================================
console.log("\n[12] Open positions are run-INDEPENDENT and all roll in");
// ===========================================================================
{
  // Open positions are owned + un-exited; they persist across validation runs, so a
  // holding opened weeks ago must still count toward every capacity check.
  const openBook = [
    hold({ ticker: "OLD1", sector: "Energy" }),
    hold({ ticker: "OLD2", sector: "Energy" }),
    hold({ ticker: "OLD3", sector: "Financials" }),
    hold({ ticker: "OLD4", sector: "Health Care" }),
    hold({ ticker: "OLD5", sector: "Technology" }),
  ];
  const liveRow = { ...cand({ ticker: "NEW", sector: "Utilities" }), firedStatus: "confirmed" };
  const t = computeBasket([liveRow], openBook, opts());

  check("ALL open positions are counted, not just one", t.openCount === 5, String(t.openCount));
  check("  open notional sums every holding", near(t.openNotional, 25_000), String(t.openNotional));
  check("  buying power subtracts all of them", near(t.buyingPower, 45_000), String(t.buyingPower));
  check("  open risk sums every holding", near(t.openRiskDollars, 2500), String(t.openRiskDollars));
  check("  slots count all open + new", t.slotsUsed === 6, String(t.slotsUsed));
  check("  heat includes all open risk", near(t.heatPct, ((2500 + 525) / DEFAULT_ACCOUNT_SIZE) * 100), String(t.heatPct));

  const secNames = t.sectors.map((x) => x.sector).sort().join(",");
  check("every open sector appears in the panel",
    secNames === "Energy,Financials,Health Care,Technology,Utilities", secNames);
  check("  the 2-name Energy sector keeps BOTH tickers",
    t.sectors.find((x) => x.sector === "Energy")!.openTickers.join(",") === "OLD1,OLD2");
  check("  a same-sector holding pair counts 2, not 1",
    t.sectors.find((x) => x.sector === "Energy")!.open === 2);

  const other = { ...cand({ ticker: "OTHER", sector: "Materials" }), firedStatus: "confirmed" };
  const t2 = computeBasket([other], openBook, opts());
  check("re-validating does not change the open count", t2.openCount === t.openCount);
  check("  nor open notional / buying power",
    near(t2.openNotional, t.openNotional) && near(t2.buyingPower, t.buyingPower));
  check("an empty basket still carries the whole open book",
    computeBasket([], openBook, opts()).openCount === 5);
}

// ===========================================================================
console.log("\n[13] Account size is a live parameter, not a constant");
// ===========================================================================
{
  const rows = [cand({ ticker: "AAA" })];
  const at70 = computeBasket(rows, [], opts({ accountSize: 70_000 }));
  const at35 = computeBasket(rows, [], opts({ accountSize: 35_000 }));
  const at140 = computeBasket(rows, [], opts({ accountSize: 140_000 }));

  check("default account size is $70,000",
    defaultBasketOptions().accountSize === DEFAULT_ACCOUNT_SIZE && DEFAULT_ACCOUNT_SIZE === 70_000);
  check("halving the account halves risk$", near(at35.riskDollars, at70.riskDollars / 2),
    at35.riskDollars + " vs " + at70.riskDollars);
  check("  and halves the share count", at35.rows[0].shares === Math.floor(at70.rows[0].shares / 2), String(at35.rows[0].shares));
  // NOT exactly half: shares are FLOORED, so $262.50 / $5 = 52 shares, not 52.5.
  check("  position$ follows the floored share count", near(at35.positionDollars, 52 * 100), String(at35.positionDollars));
  check("  which is within one share of half", Math.abs(at35.positionDollars - at70.positionDollars / 2) <= 100);
  check("  reward$ likewise follows the floored shares", near(at35.rewardDollars, 52 * 15), String(at35.rewardDollars));
  check("doubling the account doubles risk$", near(at140.riskDollars, at70.riskDollars * 2));

  const openBook = [hold({ ticker: "H1" })];
  const bp70 = computeBasket(rows, openBook, opts({ accountSize: 70_000 }));
  const bp35 = computeBasket(rows, openBook, opts({ accountSize: 35_000 }));
  check("buying power = account - open notional, at 70k", near(bp70.buyingPower, 65_000), String(bp70.buyingPower));
  check("  and tracks the account down to 35k", near(bp35.buyingPower, 30_000), String(bp35.buyingPower));
  // Heat RISES as the account shrinks, but not by exactly 2x: the OPEN risk is a fixed
  // dollar amount while the new-basket risk scales with the account.
  check("heat rises when the account halves", bp35.heatPct > bp70.heatPct, bp35.heatPct + " vs " + bp70.heatPct);
  check("  heat at 70k = (525 new + 500 open)/70k", near(bp70.heatPct, (1025 / 70_000) * 100), String(bp70.heatPct));
  check("  heat at 35k = (262.50 new + 500 open)/35k", near(bp35.heatPct, (762.5 / 35_000) * 100), String(bp35.heatPct));

  const odd = computeBasket(rows, [], opts({ accountSize: 12_345 }));
  check("an arbitrary account size flows through", near(odd.riskDollars, 12_345 * 0.0075), String(odd.riskDollars));
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
