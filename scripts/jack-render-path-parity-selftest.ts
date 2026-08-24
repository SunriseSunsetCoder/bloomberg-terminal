/*
 * JACK RENDER-PATH PARITY — the standing guard that the two ways a board reaches
 * the terminal produce the SAME DATA.
 *
 * Run:  npx tsx scripts/jack-render-path-parity-selftest.ts
 *
 * WHY THIS EXISTS, AND WHY THE OLD CHECK WAS NOT ENOUGH
 *
 * There are two render paths. A live VALIDATE builds rows with
 * buildClientDecisions; a page load builds them with buildHydratedDecisions off
 * SQLite + the Redis price store. They have now diverged three times:
 *
 *   1. entry_status emitted by one path and not the other        (dc94942)
 *   2. currentPrice arriving as {price,source,asOf} from the price store while
 *      the client type promised a number — the price ladder called .toFixed on
 *      an object and every LIVE row crashed on expand
 *   3. LIVE ordered by priority from VALIDATE and ALPHABETICALLY from hydration,
 *      because the sort lived at the tail of buildClientDecisions
 *
 * The previous guard was an ad-hoc script that compared field VALUES with !=.
 * It passed while (2) and (3) shipped, for reasons worth stating plainly:
 *
 *   · it compared values, not TYPES — and it ran against a board where Redis was
 *     unavailable, so the one mistyped field was null on both sides and matched
 *   · it compared field-by-field per ticker, never the row ORDER
 *   · it was ad-hoc, so it only ran when somebody remembered to run it
 *
 * So this file asserts TYPE and ORDER, not just values, and lives with the other
 * selftests so it runs from `npm run selftest`.
 *
 * THE CONTRACT
 *   · identical ticker SEQUENCE (order is part of the payload)
 *   · identical runtime typeof for every field of every row
 *   · every numeric field is a finite number or null — never an object, never
 *     NaN, never a numeric string
 *   · NUMERIC_DECISION_FIELDS has no holes (a numeric field missing from the list
 *     would be silently uncoerced)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `   ${detail}` : ""}`); }
}

const tmp = mkdtempSync(join(tmpdir(), "jack-parity-"));
process.env.JACK_DB_PATH = join(tmp, "jack.db");

/** Runtime type tag that distinguishes null from object — typeof null === "object". */
function typeTag(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

async function main(): Promise<void> {
  const core = await import("../lib/jack/validation-core");
  const { applyFilters, buildClientDecisions, finalizeClientDecisions, toFiniteNumber,
          NUMERIC_DECISION_FIELDS } = core;
  const { buildHydratedDecisions, isPriceStoreFresh, etDateISO } =
    await import("../lib/jack/board-hydration");
  const write = await import("../lib/db/write");
  const read = await import("../lib/db/read");

  const iso = (d: number) => {
    const x = new Date(); x.setUTCDate(x.getUTCDate() - d); return x.toISOString().slice(0, 10);
  };
  const HL = iso(5), TODAY = iso(0);

  // ------------------------------------------------------------------------
  // A fixture built so the two orderings CANNOT accidentally agree.
  //
  // LIVE alphabetical  : ALPHA, BRAVO, DELTA, MIKE, ZEBRA
  // LIVE by priority   : ZEBRA(.95), MIKE(.70), BRAVO(.60), DELTA(.60), ALPHA(.40)
  // BRAVO/DELTA tie on priority AND bucket AND handle_score, so they exercise the
  // ticker-ASC tiebreak specifically.
  // ------------------------------------------------------------------------
  const HDR = "ticker,status,size_bucket,tier,sector,priority,handle_score,handle_low_date," +
    "days_since_handle_low,entry,stop,t05_target,breakout_level,cup_depth_pct," +
    "handle_retr_pct,confirmed_close_date,days_since_confirm,entry_status";
  const csv = [
    HDR,
    `ALPHA,just_fired,full,Q5,Energy,0.40,0.55,${HL},5,100,94,112,99,18.0,30.0,${TODAY},0,FRESH`,
    `ZEBRA,just_fired,full,Q5,Financials,0.95,0.81,${HL},5,50,46,58,49,17.0,29.0,${TODAY},0,FRESH`,
    `MIKE,recent_breakout,half,Q3,Utilities,0.70,0.60,${HL},5,80,74,92,79,19.0,31.0,${iso(2)},2,AGING`,
    `BRAVO,just_fired,full,Q4,Materials,0.60,0.66,${HL},5,30,27,36,29,20.0,25.0,${TODAY},0,FRESH`,
    `DELTA,just_fired,full,Q4,Industrials,0.60,0.66,${HL},5,40,36,48,39,20.0,25.0,${TODAY},0,FRESH`,
    `PENDCO,pending,full,Q5,Health Care,0.88,0.75,${HL},5,20,18,24,19.5,22.0,28.0,,,PENDING`,
    `WAITCO,pending,half,Q3,Real Estate,0.30,0.44,${HL},5,60,55,70,59,16.0,27.0,,,PENDING`,
  ].join("\n");

  const { sectioned } = applyFilters(csv);
  check("fixture parsed (5 live + 2 pending)",
    sectioned.live.length === 5 && sectioned.pending.length === 2,
    `${sectioned.live.length}/${sectioned.pending.length}`);

  // ---- persist exactly as the ingest route does ---------------------------
  const ts = `${TODAY}T23:00:00.000Z`;
  const idMap = new Map<string, number>();
  for (const s of [...sectioned.live, ...sectioned.pending]) {
    idMap.set(`${s.ticker}|${s.handleLowDate}`, write.upsertSetup({
      ticker: s.ticker, handleLowDate: s.handleLowDate, status: s.status,
      entry: s.entry, stop: s.stop, t05Target: s.t05Target, breakoutLevel: s.breakoutLevel,
      cupDepthPct: s.cupDepthPct, handleRetrPct: s.handleRetrPct,
      handleScore: s.handleScore, sizeBucket: s.sizeBucket, sector: s.sector,
      tier: s.tier, priority: s.priority,
      entryStatus: s.entryStatus, confirmedCloseDate: s.confirmedCloseDate,
      daysSinceConfirm: s.daysSinceConfirm,
      daysSinceHandleLow: Number.isFinite(s.daysSinceHandleLow) ? s.daysSinceHandleLow : undefined,
    }, ts));
  }
  const runId = write.insertValidationRun({
    timestamp: ts, inputRowCount: 7, totalFinalCount: 7, liveFinalCount: 5, pendingFinalCount: 2,
    liveDroppedStale: 0, pendingDroppedStale: 0, liveDroppedOverCap: 0, pendingDroppedOverCap: 0,
    tiingoAttempted: 0, tiingoSucceeded: 0, riskPerTrade: 2000, model: "claude-sonnet-4-5",
    rawMarkdown: "", parseSuccess: true,
  });
  const ins = write.insertDecisions(
    [...sectioned.live.map((s) => ({ s, section: "live" as const })),
     ...sectioned.pending.map((s) => ({ s, section: "pending" as const }))]
      .map(({ s, section }) => ({
        ticker: s.ticker, handleLowDate: s.handleLowDate, section,
        decision: "TRADE", notes: "clean handle", newsClass: "none",
        sectorRs: "in-line", crossAsset: "neutral", earningsFlag: "clear",
        pctToBreakout: 1.5, shares: 100, notional: 10000, // mirrors `commentary` below

      })),
    runId, idMap
  );
  check("decisions persisted", ins.inserted === 7, String(ins.inserted));

  // ------------------------------------------------------------------------
  // PATH A — VALIDATE. currentPrice comes from the Tiingo EOD close.
  // ------------------------------------------------------------------------
  const PRICE: Record<string, number> = {
    ALPHA: 101.25, ZEBRA: 51.5, MIKE: 81, BRAVO: 30.75, DELTA: 41.1,
    PENDCO: 19.9, WAITCO: 61.4,
  };
  const enrich = (list: typeof sectioned.live) =>
    list.map((s) => ({ ...s, tiingo: { eodClose: PRICE[s.ticker] } }));
  // The LLM block carries the same commentary insertDecisions persisted. In
  // production these ARE the same values — the row written to SQLite is built from
  // this payload — so anything else would be testing a fixture asymmetry rather
  // than a path divergence.
  const commentary = {
    decision: "TRADE", notes: "clean handle", news_class: "none",
    sector_rs: "in-line", cross_asset: "neutral", earnings_flag: "clear",
    pct_to_breakout: 1.5, shares: 100, notional: 10000,
  };
  const extracted = {
    live_decisions: sectioned.live.map((s) => ({
      ticker: s.ticker, handle_low_date: s.handleLowDate, ...commentary,
    })),
    pending_decisions: sectioned.pending.map((s) => ({
      ticker: s.ticker, handle_low_date: s.handleLowDate, ...commentary,
    })),
  };
  const marks = read.getUserMarksForSetups([...idMap.values()]);
  const validate = buildClientDecisions(
    extracted, enrich(sectioned.live), enrich(sectioned.pending), ins.ids, marks, 2000
  );

  // ------------------------------------------------------------------------
  // PATH B — HYDRATION. currentPrice comes from the Redis store, whose real
  // shape is { price, source, asOf } PER TICKER. Building the store the way
  // price-refresh actually writes it is the whole point: a test that hands this
  // mapper bare numbers re-creates the bug it is supposed to catch.
  // ------------------------------------------------------------------------
  const board = read.getCurrentBoard();
  const nowIso = new Date().toISOString();
  const priceStore = {
    asOf: nowIso,
    mode: "eod" as const,
    iexUnavailable: false,
    prices: Object.fromEntries(
      Object.entries(PRICE).map(([t, p]) => [t, { price: p, source: "eod" as const, asOf: nowIso }])
    ),
  };
  const hydrate = buildHydratedDecisions({
    rows: [...board.live, ...board.pending],
    riskPerTrade: 2000,
    marks,
    priceStore,
    etDay: etDateISO(new Date()),
  });

  // ========================================================================
  console.log("\n=== 1. ROW ORDER — the payload's order IS part of the payload ===\n");
  // ========================================================================
  const seq = (rows: typeof validate) => rows.map((d) => d.ticker).join(",");
  check("both paths return the same row count",
    validate.length === hydrate.length, `${validate.length}/${hydrate.length}`);
  check("IDENTICAL ticker sequence", seq(validate) === seq(hydrate),
    `\n         validate: ${seq(validate)}\n         hydrate : ${seq(hydrate)}`);

  const liveSeq = (rows: typeof validate) =>
    rows.filter((d) => d.section === "live").map((d) => d.ticker).join(",");
  check("LIVE is priority-ordered, not alphabetical (the regression)",
    liveSeq(hydrate) === "ZEBRA,MIKE,BRAVO,DELTA,ALPHA", liveSeq(hydrate));
  check("LIVE alphabetical order is NOT what we got",
    liveSeq(hydrate) !== "ALPHA,BRAVO,DELTA,MIKE,ZEBRA", liveSeq(hydrate));
  check("exact tie (BRAVO/DELTA: same priority, bucket, score) breaks ticker-ASC",
    liveSeq(hydrate).indexOf("BRAVO") < liveSeq(hydrate).indexOf("DELTA"), liveSeq(hydrate));
  check("PENDING follows LIVE and is priority-ordered",
    validate.filter((d) => d.section === "pending").map((d) => d.ticker).join(",") ===
      "PENDCO,WAITCO", seq(validate));

  // ========================================================================
  console.log("\n=== 2. TYPE PARITY — every field, every row ===\n");
  // ========================================================================
  const vByTicker = new Map(validate.map((d) => [d.ticker, d as unknown as Record<string, unknown>]));
  const hByTicker = new Map(hydrate.map((d) => [d.ticker, d as unknown as Record<string, unknown>]));
  const typeMismatches: string[] = [];
  let fieldsCompared = 0;
  for (const [ticker, v] of vByTicker) {
    const h = hByTicker.get(ticker);
    if (!h) { typeMismatches.push(`${ticker}: missing from hydration`); continue; }
    for (const k of new Set([...Object.keys(v), ...Object.keys(h)])) {
      fieldsCompared++;
      const tv = typeTag(v[k]);
      const th = typeTag(h[k]);
      // null vs undefined is a shape nit, not a render hazard: both are falsy and
      // both render as absent. Anything else differing IS a divergence.
      const norm = (t: string) => (t === "undefined" ? "null" : t);
      if (norm(tv) !== norm(th)) {
        typeMismatches.push(`${ticker}.${k}: validate=${tv} hydrate=${th}`);
      }
    }
  }
  check(`typeof identical across ${fieldsCompared} field comparisons`,
    typeMismatches.length === 0, `\n         ${typeMismatches.join("\n         ")}`);

  // ========================================================================
  console.log("\n=== 3. NUMERIC FIELDS — finite number or null, never anything else ===\n");
  // ========================================================================
  const badNumeric: string[] = [];
  for (const [label, rows] of [["validate", validate], ["hydrate", hydrate]] as const) {
    for (const d of rows) {
      const rec = d as unknown as Record<string, unknown>;
      for (const f of NUMERIC_DECISION_FIELDS) {
        const val = rec[f];
        if (val == null) continue;
        if (typeof val !== "number" || !Number.isFinite(val)) {
          badNumeric.push(`${label}.${d.ticker}.${f} = ${typeTag(val)} ${JSON.stringify(val)}`);
        }
      }
    }
  }
  check("no numeric field is an object, NaN, or a string on either path",
    badNumeric.length === 0, `\n         ${badNumeric.join("\n         ")}`);

  // The exact crash: jack-decisions-table.tsx priceLadder does p.v.toFixed(2)
  // after a `!= null` guard, which an object passes.
  const ladderErrors: string[] = [];
  for (const [label, rows] of [["validate", validate], ["hydrate", hydrate]] as const) {
    for (const d of rows) {
      for (const [f, v] of [["entry", d.entry], ["stop", d.stop], ["target", d.target],
                            ["currentPrice", d.currentPrice]] as const) {
        if (v == null) continue;
        try { (v as number).toFixed(2); } catch { ladderErrors.push(`${label}.${d.ticker}.${f}`); }
      }
    }
  }
  check("price-ladder fields survive .toFixed(2) on both paths",
    ladderErrors.length === 0, ladderErrors.join(", "));

  check("hydrated currentPrice is the NUMBER inside the store wrapper, not the wrapper",
    hByTicker.get("ZEBRA")!.currentPrice === 51.5,
    JSON.stringify(hByTicker.get("ZEBRA")!.currentPrice));

  // ---- the SAFETY NET, tested on its own -----------------------------------
  // The route now reads `.price` correctly, so a wrapper object never reaches
  // finalizeClientDecisions in the normal flow — which means the correct read
  // ALONE would make every assertion above pass even if the coercion were
  // removed. That is a hole: the net is what protects the NEXT path that gets
  // this wrong. So drive it directly with the shapes a bad reader produces.
  const seed = hydrate.find((d) => d.ticker === "ZEBRA")!;
  const forced = (v: unknown) =>
    finalizeClientDecisions([{ ...seed, currentPrice: v as number | null }])[0].currentPrice;
  check("NET: a raw {price,...} wrapper is unwrapped, not passed through",
    forced({ price: 77.25, source: "iex", asOf: nowIso }) === 77.25,
    JSON.stringify(forced({ price: 77.25, source: "iex", asOf: nowIso })));
  check("NET: a numeric string is coerced", forced("88.5") === 88.5, JSON.stringify(forced("88.5")));
  check("NET: NaN becomes null, never a silent NaN on the ladder",
    forced(Number.NaN) === null, JSON.stringify(forced(Number.NaN)));
  check("NET: an unrecognized object becomes null",
    forced({ close: 12 }) === null, JSON.stringify(forced({ close: 12 })));

  // And the same net over a MALFORMED store, end to end through the mapper —
  // e.g. a legacy writer that stored bare numbers instead of the wrapper.
  const bareNumberStore = {
    ...priceStore,
    prices: Object.fromEntries(Object.entries(PRICE).map(([t, p]) => [t, p])),
  } as unknown as typeof priceStore;
  const fromBare = buildHydratedDecisions({
    rows: [...board.live, ...board.pending], riskPerTrade: 2000, marks,
    priceStore: bareNumberStore, etDay: etDateISO(new Date()),
  });
  check("malformed store (bare numbers) still yields number|null, never an object",
    fromBare.every((d) => d.currentPrice === null || typeof d.currentPrice === "number"),
    JSON.stringify(fromBare.map((d) => d.currentPrice)));
  check("malformed store does not disturb row order",
    seq(fromBare) === seq(hydrate), seq(fromBare));

  // ========================================================================
  console.log("\n=== 4. NUMERIC_DECISION_FIELDS has no holes ===\n");
  // ========================================================================
  // A field that is a number at runtime but absent from the coercion list is an
  // uncoerced field — exactly how currentPrice slipped through.
  const known = new Set<string>(NUMERIC_DECISION_FIELDS);
  const uncovered = new Set<string>();
  for (const rows of [validate, hydrate]) {
    for (const d of rows) {
      for (const [k, v] of Object.entries(d as unknown as Record<string, unknown>)) {
        if (typeof v === "number" && !known.has(k)) uncovered.add(k);
      }
    }
  }
  check("every runtime-numeric field is in NUMERIC_DECISION_FIELDS",
    uncovered.size === 0, [...uncovered].join(", "));

  // ========================================================================
  console.log("\n=== 5. VALUE PARITY for persisted fields ===\n");
  // ========================================================================
  // currentPrice is EXCLUDED on purpose: the two paths read genuinely different
  // sources (Tiingo EOD close vs the jack:prices store), so they may legitimately
  // hold different numbers in production. The contract for it is TYPE, asserted
  // above — not value. Everything else comes from the same persisted row and must
  // match exactly.
  const VALUE_EXEMPT = new Set(["currentPrice"]);
  const valueMismatches: string[] = [];
  for (const [ticker, v] of vByTicker) {
    const h = hByTicker.get(ticker)!;
    for (const k of new Set([...Object.keys(v), ...Object.keys(h)])) {
      if (VALUE_EXEMPT.has(k)) continue;
      const a = v[k] ?? null;
      const b = h[k] ?? null;
      if (a !== b) valueMismatches.push(`${ticker}.${k}: validate=${JSON.stringify(a)} hydrate=${JSON.stringify(b)}`);
    }
  }
  check("persisted field values identical across paths",
    valueMismatches.length === 0, `\n         ${valueMismatches.join("\n         ")}`);

  // ========================================================================
  console.log("\n=== 6. toFiniteNumber — the coercion contract ===\n");
  // ========================================================================
  check("unwraps the price-store shape {price:n}", toFiniteNumber({ price: 101.5 }) === 101.5);
  check("object WITHOUT a numeric price -> null", toFiniteNumber({ source: "iex" }) === null);
  check("object with a non-finite price -> null", toFiniteNumber({ price: Number.NaN }) === null);
  check("NaN -> null (never a silent blank ladder)", toFiniteNumber(Number.NaN) === null);
  check("Infinity -> null", toFiniteNumber(Number.POSITIVE_INFINITY) === null);
  check("numeric string -> number", toFiniteNumber("101.5") === 101.5);
  check("empty string -> null", toFiniteNumber("") === null);
  check("non-numeric string -> null", toFiniteNumber("banana") === null);
  check("null -> null", toFiniteNumber(null) === null);
  check("undefined -> null", toFiniteNumber(undefined) === null);
  check("array -> null", toFiniteNumber([101]) === null);
  check("boolean -> null (not 1/0)", toFiniteNumber(true) === null);
  check("a plain number passes through", toFiniteNumber(42) === 42);

  // ========================================================================
  console.log("\n=== 7. STALE price store is not shown as NOW ===\n");
  // ========================================================================
  const staleIso = "2020-01-02T15:00:00.000Z";
  check("isPriceStoreFresh: today -> true",
    isPriceStoreFresh(priceStore, etDateISO(new Date())) === true);
  check("isPriceStoreFresh: old asOf -> false",
    isPriceStoreFresh({ ...priceStore, asOf: staleIso }, etDateISO(new Date())) === false);
  check("isPriceStoreFresh: null store -> false",
    isPriceStoreFresh(null, etDateISO(new Date())) === false);
  const staleBoard = buildHydratedDecisions({
    rows: [...board.live, ...board.pending],
    riskPerTrade: 2000,
    marks,
    priceStore: { ...priceStore, asOf: staleIso },
    etDay: etDateISO(new Date()),
  });
  check("a stale store yields currentPrice null, not yesterday's price",
    staleBoard.every((d) => d.currentPrice === null),
    JSON.stringify(staleBoard.map((d) => d.currentPrice)));
  check("row ORDER is unaffected by the price store",
    seq(staleBoard) === seq(hydrate), seq(staleBoard));

  // ========================================================================
  console.log("\n=== 8. finalizeClientDecisions is idempotent + total ===\n");
  // ========================================================================
  check("re-finalizing an already-final board is a no-op",
    seq(finalizeClientDecisions(hydrate)) === seq(hydrate));
  check("finalize drops no rows",
    finalizeClientDecisions(hydrate).length === hydrate.length);
  const withOpen = finalizeClientDecisions([
    ...hydrate,
    { ...hydrate[0], ticker: "OPENCO", section: "open" } as (typeof hydrate)[number],
  ]);
  check("an 'open' row is preserved, not dropped",
    withOpen.some((d) => d.ticker === "OPENCO"), String(withOpen.length));
  check("empty input -> empty output", finalizeClientDecisions([]).length === 0);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });
