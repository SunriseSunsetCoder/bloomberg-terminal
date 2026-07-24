/**
 * Live Finnhub earnings-calendar test — fetches the ~2-week window and parses it,
 * printing the earnings date (if any) for a few sample tickers.
 *   npx tsx scripts/jack-finnhub-test.ts               # default sample tickers
 *   npx tsx scripts/jack-finnhub-test.ts AAPL NVDA HD  # custom
 * Requires FINNHUB_API_KEY. Exits non-zero if disabled or the fetch fails.
 */
import { fetchEarningsMap, earningsEnabled } from "../lib/jack/finnhub";
import { addCalendarDaysISO } from "../lib/jack/alerts";

async function main() {
  if (!earningsEnabled()) {
    console.error("DISABLED: set FINNHUB_API_KEY first.");
    process.exit(1);
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const to = addCalendarDaysISO(today, 14);
  const tickers = (process.argv.slice(2).length ? process.argv.slice(2) : ["AAPL", "MSFT", "NVDA", "TSLA", "JPM"]).map((t) =>
    t.toUpperCase()
  );

  console.log(`Fetching Finnhub earnings calendar ${today} .. ${to} …`);
  const r = await fetchEarningsMap(today, to);
  if (!r.ok || !r.map) {
    console.error("FAIL:", r.error ?? "(disabled)");
    process.exit(1);
  }
  console.log(`Calendar entries in window: ${Object.keys(r.map).length}`);
  for (const t of tickers) {
    console.log(`  ${t}: ${r.map[t] ?? "(no upcoming earnings in window)"}`);
  }
  console.log("OK: Finnhub reachable and calendar parsed.");
  process.exit(0);
}

main();
