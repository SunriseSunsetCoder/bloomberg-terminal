/*
 * JACK Basket Sizer RENDER self-test — the guard the pure selftests can't give.
 *
 * basket.ts being green says nothing about whether the PAGE renders: a null deref or a
 * bad field access in the view blanks the whole thing while every pure test still
 * passes. This renders the REAL JackBasketView to HTML against a populated feed and
 * asserts the sections are actually present — rows, tiles, sector panel, and Current
 * Positions.
 *
 * The view's data comes from useJackBasket (react-query), so the fetch is stubbed here
 * and the component is wrapped in a QueryClientProvider, exactly as the app wraps it.
 *
 * Run:  npx tsx scripts/jack-basket-render-selftest.tsx
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JackBasketView } from "../components/bloomberg/views/jack-basket-view";

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

const HLD = "2026-08-05";
const FEED = {
  ok: true,
  persistenceAvailable: true,
  pendingTotal: 5,
  candidates: [
    {
      setupId: 1, ticker: "FIREDA", handleLowDate: HLD, entry: 100, stop: 95, target: 115,
      tier: "Q5", sector: "Technology", priority: 9.5, sizeBucket: "full", handleScore: 0.7,
    },
    {
      setupId: 2, ticker: "FIREDB", handleLowDate: HLD, entry: 50, stop: 47, target: 60,
      tier: "Q4", sector: "Energy", priority: 6, sizeBucket: "full", handleScore: 0.6,
    },
  ],
  open: [
    // NOTE: one row deliberately has a NULL share count — the real accessor returns
    // decisions.shares, which is null whenever the marked row carried none. The table
    // must still render it, flagged rather than dropped.
    { setupId: 6, ticker: "HELD1", sector: "Energy", tier: "Q5", entry: 100, stop: 95, shares: 50, userEntryPrice: 101 },
    { setupId: 7, ticker: "HELD2", sector: "Health Care", tier: "Q4", entry: 80, stop: 76, shares: null, userEntryPrice: 81 },
    { setupId: 8, ticker: "HELD3", sector: "Energy", tier: "Q5", entry: 40, stop: 37, shares: 120, userEntryPrice: 40.5 },
    { setupId: 9, ticker: "HELD4", sector: "Financials", tier: "Q3", entry: 25, stop: 23.5, shares: 200, userEntryPrice: 25.2 },
    { setupId: 10, ticker: "HELD5", sector: "Technology", tier: "Q4", entry: 60, stop: 56, shares: 80, userEntryPrice: 61 },
  ],
};

/** Render the view with a stubbed fetch, awaiting the query so data is present. */
async function renderWithFeed(feed: unknown): Promise<string> {
  const originalFetch = globalThis.fetch;
  // @ts-expect-error — minimal stub, only the JSON body is read.
  globalThis.fetch = async () => ({ ok: true, json: async () => feed });

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  try {
    // Prime the cache so the synchronous SSR render sees the data.
    await qc.prefetchQuery({ queryKey: ["jack-basket"], queryFn: async () => feed });
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <JackBasketView isDarkMode />
      </QueryClientProvider>
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  // =========================================================================
  console.log("\n[1] Populated feed — the page renders every section");
  // =========================================================================
  let html = "";
  let threw: unknown = null;
  try {
    html = await renderWithFeed(FEED);
  } catch (err) {
    threw = err;
  }
  check("the view renders without throwing", threw === null, threw instanceof Error ? threw.stack : String(threw));
  if (threw) {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }

  check("page chrome is present", html.includes("BASKET SIZER"));
  check("the ACCOUNT input renders", html.includes("ACCOUNT $"));

  // The actual regression: rows.
  check("LIVE row FIREDA renders", html.includes("FIREDA"), "basket rows missing");
  check("LIVE row FIREDB renders", html.includes("FIREDB"));

  // Tiles.
  for (const tile of ["setups", "shares", "position $", "risk $", "reward $", "slots", "buying power"]) {
    check(`tile "${tile}" renders`, html.toLowerCase().includes(tile), "tiles missing");
  }

  // Sector panel — must include the OPEN book's sectors, not just the basket's.
  check("sector panel renders", html.includes("SECTORS"));
  check("  open-book sector Health Care appears", html.includes("Health Care"));
  check("  basket sector Technology appears", html.includes("Technology"));

  // Current Positions — the run-independent section.
  check("OPEN POSITIONS section renders", html.includes("OPEN POSITIONS"), "open book missing");
  check("  header carries the count (5)", html.includes(">(5)<") || html.includes("(5)"), "count missing");
  check("  it is labelled as counted in every cap", html.includes("counted in every cap"));
  check("  renders as a TABLE, not an inline run", html.includes("Entry/Fill") && html.includes("Position $"));
  for (const col of ["Ticker", "Tier", "Sector", "Shares", "Entry/Fill", "Stop", "Position $", "Risk $", "%Acct"]) {
    check(`  column "${col}" present`, html.includes(col));
  }
  for (const tk of ["HELD1", "HELD2", "HELD3", "HELD4", "HELD5"]) {
    check(`  row ${tk} renders`, html.includes(tk));
  }
  {
    // One <tr> per position + header row + TOTAL row, inside the open-positions table.
    const section = html.slice(html.indexOf("OPEN POSITIONS"));
    const rows = (section.match(/<tr/g) ?? []).length;
    check("  one row per position (+ header + TOTAL)", rows === 7, String(rows));
    check("  a TOTAL row is present", section.includes("TOTAL"));
  }
  check("  the null-share row is flagged, not dropped", html.includes("unknown"));
  check("  tier values render", html.includes("Q3") && html.includes("Q5"));

  // =========================================================================
  console.log("\n[2] Open positions render even when the LIVE feed is empty");
  // =========================================================================
  const onlyOpen = await renderWithFeed({ ...FEED, candidates: [], pendingTotal: 4 });
  check("empty-state copy is shown", onlyOpen.includes("No setups in the board&#x27;s LIVE group right now"));
  check("  it names the waiting pipeline", onlyOpen.includes("4 setups still pending"));
  check("open positions STILL render with no basket rows", onlyOpen.includes("HELD1") && onlyOpen.includes("HELD2"));
  check("  and the tiles still render", onlyOpen.includes("buying power"));
  check("  the unknown-size warning is surfaced", onlyOpen.includes("UNDERSTATED"));

  // =========================================================================
  console.log("\n[3] Failure modes never blank the page");
  // =========================================================================
  const errored = await renderWithFeed({ ok: false, persistenceAvailable: true, error: "boom" });
  check("a route error renders an error state, not a blank page", errored.includes("boom"), "error not surfaced");
  check("  page chrome survives the error", errored.includes("BASKET SIZER"));

  const disabled = await renderWithFeed({ ok: false, persistenceAvailable: false, reason: "disabled (running on Vercel)" });
  check("persistence-off renders its notice", disabled.includes("Live pull disabled"));

  const empty = await renderWithFeed({ ok: true, persistenceAvailable: true, candidates: [], open: [], pendingTotal: 0 });
  check("a genuinely empty feed renders the empty state", empty.includes("No setups in the board&#x27;s LIVE group right now"));
  check("  and still renders the tiles", empty.includes("buying power"));
  check("  OPEN POSITIONS still renders its header when there are none", empty.includes("OPEN POSITIONS"));
  check("  labelled (0) — none held", empty.includes("(0)") && empty.includes("none held"));
  check("  with an explanation, never a silent blank", empty.includes("Nothing marked TRADED"));

  // The two feeds are independent: one failing must not blank the other.
  const liveBroke = await renderWithFeed({
    ok: false, persistenceAvailable: true, candidates: [], open: FEED.open,
    candidatesError: "no such column: s.sector", pendingTotal: 0,
  });
  check("LIVE feed failure is named on screen", liveBroke.includes("LIVE feed failed"));
  check("  and open positions STILL render", liveBroke.includes("HELD1") && liveBroke.includes("HELD2"));

  const openBroke = await renderWithFeed({
    ok: false, persistenceAvailable: true, candidates: FEED.candidates, open: [],
    openError: "database is locked", pendingTotal: 5,
  });
  check("open-feed failure is named on screen", openBroke.includes("Open-position feed failed"));
  check("  and it warns the caps are understated", openBroke.includes("UNDERSTATED"));
  check("  while the LIVE rows STILL render", openBroke.includes("FIREDA"));

  console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.stack : String(err), "\n");
  process.exit(1);
});
