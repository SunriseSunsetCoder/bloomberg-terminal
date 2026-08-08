/*
 * JACK decision-merge self-test — combineJackDecisions routing + the exactly-one-
 * section invariant (branch jack-priority-owned-routing).
 *
 * Rule under test: a setup whose LATEST mark is TRADED routes to CURRENT POSITIONS
 * ("open"), never LIVE/PENDING; PASSED/WATCHING/unmarked stay in LIVE/PENDING; and
 * NO setup ever vanishes or double-renders — even if the open-positions fetch is
 * empty (fall-through guard re-sections the TRADED run row to "open").
 *
 * Run:  npx tsx scripts/jack-combine-decisions-selftest.ts
 */
import { combineJackDecisions, computeSectionRanks, rankKey, sortByRank } from "../lib/jack/combine-decisions";
import type { JackDecisionClient } from "../components/bloomberg/hooks/useJackValidation";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function mk(overrides: Partial<JackDecisionClient>): JackDecisionClient {
  return {
    decisionId: null, setupId: null, ticker: "X", handleLowDate: "2026-07-10",
    section: "live", decision: "TRADE", entry: null, stop: null, target: null,
    shares: null, breakout: null, currentPrice: null, note: null, newsClass: null,
    sectorRs: null, crossAsset: null, earningsFlag: null, pctToBreakout: null,
    userAction: null, userEntryPrice: null, userEntryDate: null, userExitPrice: null,
    userExitDate: null, jackDecisionAtMark: null, sharesAtMark: null,
    ...overrides,
  } as JackDecisionClient;
}
const bySetup = (rows: JackDecisionClient[], id: number) => rows.filter((r) => r.setupId === id);

// ---- 1. Full routing: TRADED → open; PASSED/unmarked → live; pending → pending ----
console.log("\n[1] TRADED routes to CURRENT POSITIONS, others stay put");
{
  const run = [
    mk({ setupId: 1, ticker: "TRADIN", section: "live", userAction: "TRADED" }), // traded + in this week's scan
    mk({ setupId: 2, ticker: "PASS", section: "live", userAction: "PASSED" }),
    mk({ setupId: 3, ticker: "UNMARK", section: "live", userAction: null }),
    mk({ setupId: 4, ticker: "PEND", section: "pending", userAction: null }),
  ];
  const open = [
    mk({ setupId: 1, ticker: "TRADIN", section: "open", userAction: "TRADED" }), // owned view of #1 (from getOpenPositions)
    mk({ setupId: 5, ticker: "TRADOUT", section: "open", userAction: "TRADED" }), // owned, NOT in this week's scan
  ];
  const out = combineJackDecisions(run, open);

  const sec = (id: number) => bySetup(out, id).map((r) => r.section);
  check("TRADED-in-scan (#1) → open only (not live)", sec(1).length === 1 && sec(1)[0] === "open", sec(1).join(","));
  check("PASSED (#2) → live", sec(2).length === 1 && sec(2)[0] === "live", sec(2).join(","));
  check("unmarked (#3) → live", sec(3).length === 1 && sec(3)[0] === "live", sec(3).join(","));
  check("pending (#4) → pending", sec(4).length === 1 && sec(4)[0] === "pending", sec(4).join(","));
  check("TRADED-not-in-scan (#5) → open", sec(5).length === 1 && sec(5)[0] === "open", sec(5).join(","));
}

// ---- 2. Exactly-one-section invariant: no vanish, no double-render ----
console.log("\n[2] Every setup appears in exactly one section");
{
  const run = [
    mk({ setupId: 1, section: "live", userAction: "TRADED" }),
    mk({ setupId: 2, section: "live", userAction: "PASSED" }),
    mk({ setupId: 3, section: "pending", userAction: null }),
  ];
  const open = [
    mk({ setupId: 1, section: "open", userAction: "TRADED" }),
    mk({ setupId: 5, section: "open", userAction: "TRADED" }),
  ];
  const out = combineJackDecisions(run, open);
  const ids = out.map((r) => r.setupId);
  const uniq = new Set(ids);
  check("no setupId appears twice", ids.length === uniq.size, `ids=${ids.join(",")}`);
  check("all input setups present (1,2,3,5)", [1, 2, 3, 5].every((id) => uniq.has(id)), [...uniq].join(","));
  check("total rows = 4 (no vanish, no dupe)", out.length === 4, String(out.length));
}

// ---- 3. Fall-through guard: TRADED run row with EMPTY open fetch still surfaces ----
console.log("\n[3] Open fetch empty → TRADED run row re-sectioned to open (never vanishes)");
{
  const out = combineJackDecisions(
    [mk({ setupId: 9, ticker: "RACE", section: "live", userAction: "TRADED" })],
    [] // open-positions fetch hasn't returned yet
  );
  check("single row returned", out.length === 1, String(out.length));
  check("TRADED row re-sectioned to open (not lost, not left in live)", out[0]?.section === "open", out[0]?.section);
}

// ---- 4. No open rows + no traded → passthrough unchanged ----
console.log("\n[4] Plain passthrough (no owned rows)");
{
  const run = [
    mk({ setupId: 1, section: "live", userAction: null }),
    mk({ setupId: 2, section: "pending", userAction: "PASSED" }),
  ];
  const out = combineJackDecisions(run, []);
  check("both run rows kept, sections unchanged", out.length === 2 && out.every((r) => r.section !== "open"));
}

// ---- 5. RECORDED EXIT = closed → routes to LIVE, not Current Positions ----
console.log("\n[5] Exited-but-firing setup routes to LIVE (not owned)");
{
  const run = [
    // #1: marked TRADED, but a recorded exit (userExitPrice set) + still firing this week.
    mk({ setupId: 1, ticker: "EXITED", section: "live", userAction: "TRADED", userExitPrice: 42, userExitDate: "2026-07-20" }),
    // #2: marked TRADED, NO exit → still owned + firing.
    mk({ setupId: 2, ticker: "OWNED", section: "live", userAction: "TRADED", userExitPrice: null }),
  ];
  const open = [
    // getOpenPositions excludes the exited one (WHERE user_exit_price IS NULL); returns only the owned one.
    mk({ setupId: 2, ticker: "OWNED", section: "open", userAction: "TRADED", userExitPrice: null }),
  ];
  const out = combineJackDecisions(run, open);
  const sec = (id: number) => bySetup(out, id).map((r) => r.section);
  check("exited+firing (#1) → live only, NOT open", sec(1).length === 1 && sec(1)[0] === "live", sec(1).join(","));
  check("still-owned (#2) → open only", sec(2).length === 1 && sec(2)[0] === "open", sec(2).join(","));
  const ids = out.map((r) => r.setupId);
  check("exactly one section each (no dupe/vanish)", ids.length === new Set(ids).size && new Set(ids).size === 2, ids.join(","));
}

// ---- 5b. Stale open fetch STILL lists the exited setup → dropped, routed to LIVE ----
// (the instant-after-save path: open fetch hasn't refreshed, but the run row shows
// the fresh exit; the nonOwnedIds filter drops the stale open row.)
console.log("\n[5b] Stale open fetch lists the exited setup → still routes to LIVE");
{
  const run = [mk({ setupId: 1, ticker: "EXITED", section: "live", userAction: "TRADED", userExitPrice: 42 })];
  const open = [mk({ setupId: 1, ticker: "EXITED", section: "open", userAction: "TRADED", userExitPrice: null })]; // stale (pre-exit)
  const out = combineJackDecisions(run, open);
  const sec = bySetup(out, 1).map((r) => r.section);
  check("stale open row dropped; exited setup → live only", sec.length === 1 && sec[0] === "live", sec.join(","));
}

// ---- 6. FIRED display re-section (Phase 2) --------------------------------
// A close-confirmed fire moves the row into the LIVE display group WITHOUT the DB's
// decisions.section ever changing — that column is the scoping key for the price
// refresh + alert passes and must keep saying 'pending'.
console.log("\n[6] FIRED rows re-section to LIVE for display only");
{
  const run = [
    mk({ setupId: 1, ticker: "CONF", section: "pending", firedStatus: "confirmed", firedAt: "2026-08-07", fireClose: 101.5, fireBar: 3 }),
    mk({ setupId: 2, ticker: "LATE", section: "pending", firedStatus: "late", firedAt: "2026-08-04" }),
    mk({ setupId: 3, ticker: "RESOLV", section: "pending", firedStatus: "resolved", firedAt: "2026-08-03" }),
    mk({ setupId: 4, ticker: "QUIET", section: "pending" }),
    mk({ setupId: 5, ticker: "ALREADYLIVE", section: "live", firedStatus: "confirmed", firedAt: "2026-08-07" }),
  ];
  const out = combineJackDecisions(run, []);
  const sec = (id: number) => bySetup(out, id).map((r) => r.section).join(",");

  check("fired 'confirmed' pending -> live", sec(1) === "live", sec(1));
  check("fired 'late' pending -> live", sec(2) === "live", sec(2));
  check("fired 'resolved' -> STAYS pending (not actionable)", sec(3) === "pending", sec(3));
  check("unfired pending -> unchanged", sec(4) === "pending", sec(4));
  check("already-live fired row -> still live (no double move)", sec(5) === "live", sec(5));

  const conf = bySetup(out, 1)[0];
  check("re-sectioned row keeps its flag payload for the badge", conf.firedStatus === "confirmed" && conf.fireClose === 101.5 && conf.fireBar === 3);
  check("re-sectioned row keeps ticker/geometry", conf.ticker === "CONF");

  const ids = out.map((r) => r.setupId);
  check("every setup in exactly one section", ids.length === new Set(ids).size && new Set(ids).size === 5, ids.join(","));
  check("nothing vanished", out.length === 5, String(out.length));
}

// ---- 6b. OWNED WINS over a fire ------------------------------------------
console.log("\n[6b] Owned still wins over a fired flag");
{
  const run = [mk({ setupId: 1, ticker: "OWNEDFIRE", section: "pending", userAction: "TRADED", userExitPrice: null, firedStatus: "confirmed", firedAt: "2026-08-07" })];
  const open = [mk({ setupId: 1, ticker: "OWNEDFIRE", section: "open", userAction: "TRADED", userExitPrice: null })];
  const out = combineJackDecisions(run, open);
  const sec = bySetup(out, 1).map((r) => r.section);
  check("owned + fired -> open only, never live", sec.length === 1 && sec[0] === "open", sec.join(","));
}
{
  // Owned but the open fetch hasn't caught up: the fall-through guard must still send
  // it to "open", not let the fire re-section it to live.
  const run = [mk({ setupId: 1, ticker: "RACE", section: "pending", userAction: "TRADED", userExitPrice: null, firedStatus: "late", firedAt: "2026-08-05" })];
  const out = combineJackDecisions(run, []);
  const sec = bySetup(out, 1).map((r) => r.section);
  check("owned+fired with a lagging open fetch -> open (guard beats the fire)", sec.length === 1 && sec[0] === "open", sec.join(","));
}
{
  // A traded-then-EXITED setup is NOT owned; if it fired again it should route live.
  const run = [mk({ setupId: 1, ticker: "REFIRE", section: "pending", userAction: "TRADED", userExitPrice: 42, userExitDate: "2026-08-01", firedStatus: "confirmed", firedAt: "2026-08-07" })];
  const out = combineJackDecisions(run, []);
  const sec = bySetup(out, 1).map((r) => r.section);
  check("exited + fired again -> live (exit means not owned)", sec.length === 1 && sec[0] === "live", sec.join(","));
}

// ---- 7. P-RANK: two independent sequences, immune to a fire ---------------
// LIVE rows and PENDING rows are ranked in SEPARATE populations, each from P1, both
// taken from the DB section (dbSection ?? section) so a display move can't reshuffle
// them. Blend = priority DESC -> size bucket -> handle_score DESC.
console.log("\n[7] P-rank: independent LIVE and PENDING sequences");
{
  const board = (firedTicker: string | null) => [
    mk({ setupId: 1, ticker: "L1", section: "live", priority: 9.0, sizeBucket: "full", handleScore: 0.8 }),
    mk({ setupId: 2, ticker: "L2", section: "live", priority: 6.0, sizeBucket: "full", handleScore: 0.7 }),
    mk({ setupId: 3, ticker: "L3", section: "live", priority: 3.0, sizeBucket: "full", handleScore: 0.6 }),
    mk({
      setupId: 4, ticker: "P1T", section: "pending", priority: 8.0, sizeBucket: "full", handleScore: 0.75,
      ...(firedTicker === "P1T" ? { firedStatus: "confirmed" as const, firedAt: "2026-08-07" } : {}),
    }),
    mk({ setupId: 5, ticker: "P2T", section: "pending", priority: 5.0, sizeBucket: "full", handleScore: 0.65 }),
  ];

  const ranksOf = (firedTicker: string | null) => {
    const out = combineJackDecisions(board(firedTicker), []);
    const r = computeSectionRanks(out);
    const byTicker = new Map(out.map((d) => [d.ticker, d]));
    const rank = (t: string) => {
      const d = byTicker.get(t)!;
      const from = d.dbSection ?? d.section;
      return (from === "live" ? r.live : r.pending).get(rankKey(d)) ?? null;
    };
    return { out, rank, byTicker };
  };

  // (2) pending rows carry their OWN sequence starting at P1
  {
    const { rank } = ranksOf(null);
    check("live rows rank P1..P3 by priority", rank("L1") === 1 && rank("L2") === 2 && rank("L3") === 3, `${rank("L1")},${rank("L2")},${rank("L3")}`);
    check("pending rows rank from P1 among THEMSELVES", rank("P1T") === 1 && rank("P2T") === 2, `${rank("P1T")},${rank("P2T")}`);
    check("pending P1 is not the live P1 (separate populations)", rank("P1T") === 1 && rank("L1") === 1);
  }

  // (1) live ranks identical with and without a fire
  {
    const before = ranksOf(null);
    const after = ranksOf("P1T");
    const seq = (r: ReturnType<typeof ranksOf>) => ["L1", "L2", "L3"].map(r.rank).join(",");
    check("live P-ranks are UNCHANGED when a pending row fires", seq(before) === seq(after), `${seq(before)} vs ${seq(after)}`);
    check("  and are still 1,2,3", seq(after) === "1,2,3", seq(after));
  }

  // (3) a fired row displays in the live group but keeps its PENDING rank
  {
    const { out, rank, byTicker } = ranksOf("P1T");
    check("fired pending row is displayed in the LIVE group", byTicker.get("P1T")!.section === "live");
    check("  but its dbSection still says pending", byTicker.get("P1T")!.dbSection === "pending");
    check("  and it shows its PENDING rank (P1), not a live rank", rank("P1T") === 1, String(rank("P1T")));
    check("  the other pending row keeps P2", rank("P2T") === 2, String(rank("P2T")));
    const liveGroup = out.filter((d) => d.section === "live").map((d) => d.ticker);
    check("  live display group now holds 4 rows", liveGroup.length === 4, liveGroup.join(","));
    check("  no live rank was consumed by the fired row", computeSectionRanks(out).live.size === 3, String(computeSectionRanks(out).live.size));
  }

  // TRADED and priority-less rows consume no number (prior behaviour preserved)
  {
    const rows = [
      mk({ setupId: 1, ticker: "A", section: "live", priority: 9, userAction: "TRADED", userExitPrice: null }),
      mk({ setupId: 2, ticker: "B", section: "live", priority: 8 }),
      mk({ setupId: 3, ticker: "C", section: "live", priority: null }),
      mk({ setupId: 4, ticker: "D", section: "live", priority: 7 }),
    ];
    const r = computeSectionRanks(rows).live;
    check("owned row consumes no P-number", !r.has("A|2026-07-10"));
    check("priority-less row consumes no P-number", !r.has("C|2026-07-10"));
    check("remaining rows number 1,2", r.get("B|2026-07-10") === 1 && r.get("D|2026-07-10") === 2, `${r.get("B|2026-07-10")},${r.get("D|2026-07-10")}`);
  }

  // Tie on priority falls through to bucket then handle_score
  {
    const rows = [
      mk({ setupId: 1, ticker: "TIEA", section: "pending", priority: 5, sizeBucket: "half", handleScore: 0.9 }),
      mk({ setupId: 2, ticker: "TIEB", section: "pending", priority: 5, sizeBucket: "full", handleScore: 0.4 }),
      mk({ setupId: 3, ticker: "TIEC", section: "pending", priority: 5, sizeBucket: "full", handleScore: 0.8 }),
    ];
    const r = computeSectionRanks(rows).pending;
    check("priority tie -> bucket then score decides", r.get("TIEC|2026-07-10") === 1 && r.get("TIEB|2026-07-10") === 2 && r.get("TIEA|2026-07-10") === 3, [r.get("TIEC|2026-07-10"), r.get("TIEB|2026-07-10"), r.get("TIEA|2026-07-10")].join(","));
  }
}

// ---- 8. PENDING list order matches its P-rank chips -----------------------
// The pending group is sorted by the SAME map that renders its chips: P1 first,
// unranked (null priority / owned) last, stable within ties.
console.log("\n[8] PENDING sorts by its own P-rank");
{
  // Deliberately scrambled input order.
  const rows = [
    mk({ setupId: 1, ticker: "MID", section: "pending", priority: 5, sizeBucket: "full", handleScore: 0.6 }),
    mk({ setupId: 2, ticker: "NOPRIO_A", section: "pending", priority: null }),
    mk({ setupId: 3, ticker: "BEST", section: "pending", priority: 9, sizeBucket: "full", handleScore: 0.9 }),
    mk({ setupId: 4, ticker: "NOPRIO_B", section: "pending", priority: null }),
    mk({ setupId: 5, ticker: "WORST", section: "pending", priority: 1, sizeBucket: "full", handleScore: 0.3 }),
  ];
  const ranks = computeSectionRanks(rows).pending;
  const sortedRows = sortByRank(rows, ranks);
  const order = sortedRows.map((d) => d.ticker);

  check("pending list is in P-rank order", order.slice(0, 3).join(",") === "BEST,MID,WORST", order.join(","));
  check("unranked rows sort LAST", order.slice(3).join(",") === "NOPRIO_A,NOPRIO_B", order.join(","));
  check("unranked keep their input order (stable)", order.indexOf("NOPRIO_A") < order.indexOf("NOPRIO_B"));
  check("nothing added or dropped by the sort", sortedRows.length === rows.length);

  // The list position and the chip must agree for every ranked row.
  const positionsMatchChips = sortedRows
    .filter((d) => ranks.has(rankKey(d)))
    .every((d, idx) => ranks.get(rankKey(d)) === idx + 1);
  check("row N in the list carries chip P(N)", positionsMatchChips, sortedRows.map((d) => `${d.ticker}:${ranks.get(rankKey(d)) ?? "-"}`).join(" "));

  // Already-sorted input is a no-op (idempotent).
  check("sorting an already-ordered list changes nothing", sortByRank(sortedRows, ranks).map((d) => d.ticker).join(",") === order.join(","));
}
{
  // A fired row leaves the pending group; the rest keep ascending rank order (with a
  // gap where the fired row's number was), and LIVE order is untouched.
  const rows = [
    mk({ setupId: 1, ticker: "L1", section: "live", priority: 9 }),
    mk({ setupId: 2, ticker: "L2", section: "live", priority: 4 }),
    mk({ setupId: 3, ticker: "PB", section: "pending", priority: 3 }),
    mk({ setupId: 4, ticker: "PA", section: "pending", priority: 8, firedStatus: "confirmed", firedAt: "2026-08-07" }),
    mk({ setupId: 5, ticker: "PC", section: "pending", priority: 1 }),
  ];
  const out = combineJackDecisions(rows, []);
  const ranks = computeSectionRanks(out);
  const pendingOrder = sortByRank(out.filter((d) => d.section === "pending"), ranks.pending).map((d) => d.ticker);
  const liveOrder = out.filter((d) => d.section === "live").map((d) => d.ticker);

  check("fired row left the pending list", !pendingOrder.includes("PA"), pendingOrder.join(","));
  check("remaining pending stay in rank order", pendingOrder.join(",") === "PB,PC", pendingOrder.join(","));
  check("their chips keep the ORIGINAL pending numbers (P2, P3)", ranks.pending.get(rankKey(out.find((d) => d.ticker === "PB")!)) === 2 && ranks.pending.get(rankKey(out.find((d) => d.ticker === "PC")!)) === 3);
  check("live order undisturbed, fired row appended after native live rows", liveOrder.join(",") === "L1,L2,PA", liveOrder.join(","));
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
