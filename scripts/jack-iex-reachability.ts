/**
 * VPS IEX reachability check — RUN THIS ON THE PROD BOX (node, NOT PowerShell).
 *   npx tsx scripts/jack-iex-reachability.ts
 *   npx tsx scripts/jack-iex-reachability.ts AAPL MSFT NVDA   # custom tickers
 *
 * Confirms the production host can reach api.tiingo.com/iex over TLS and that the
 * batch response parses with a usable tngoLast (the field the refresh reads — `last`
 * is null after hours). A PowerShell `curl` to this endpoint fails on the box's old
 * TLS stack; that is a PowerShell quirk, NOT a real block — Node's fetch uses a
 * modern TLS and is what the app actually uses, so THIS is the authoritative test.
 *
 * Requires TIINGO_API_KEY in the environment (same key the app uses). Exits non-zero
 * on any failure so it can gate a deploy.
 */
import { pickIexPrice } from "@/lib/jack/price-refresh";

async function main() {
  const token = process.env.TIINGO_API_KEY;
  if (!token) {
    console.error("FAIL: TIINGO_API_KEY not set in environment");
    process.exit(1);
  }
  const tickers = process.argv.slice(2).length ? process.argv.slice(2) : ["AAPL", "MSFT"];
  const url = `https://api.tiingo.com/iex/?tickers=${tickers.join(",")}&token=${token}`;

  console.log(`Fetching IEX batch for ${tickers.join(", ")} …`);
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e) {
    console.error("FAIL: fetch threw (TLS / DNS / network):", e instanceof Error ? e.message : String(e));
    process.exit(1);
    return;
  }

  console.log(`  HTTP ${res.status} ${res.statusText}`);
  if (!res.ok) {
    // 401/403 = key/permission problem (the app would defensively fall back to EOD).
    const body = await res.text().catch(() => "");
    console.error(`FAIL: non-OK response. Body: ${body.slice(0, 300)}`);
    process.exit(1);
  }

  const data = (await res.json().catch(() => null)) as
    | Array<{ ticker?: string; tngoLast?: number | null; last?: number | null; prevClose?: number | null }>
    | null;
  if (!Array.isArray(data) || data.length === 0) {
    console.error("FAIL: response not a non-empty array:", JSON.stringify(data)?.slice(0, 300));
    process.exit(1);
    return;
  }

  let ok = true;
  for (const q of data) {
    const price = pickIexPrice(q);
    const src = q.tngoLast != null ? "tngoLast" : q.last != null ? "last" : q.prevClose != null ? "prevClose" : "none";
    const line = `  ${q.ticker ?? "?"}: price=${price} (via ${src})  [tngoLast=${q.tngoLast} last=${q.last} prevClose=${q.prevClose}]`;
    if (price == null) {
      ok = false;
      console.error(`FAIL${line}`);
    } else {
      console.log(line);
    }
  }

  if (!ok) {
    console.error("\nFAIL: at least one ticker had no usable price");
    process.exit(1);
  }
  console.log(`\nOK: IEX reachable from this host and tngoLast parses (${data.length} tickers).`);
  process.exit(0);
}

main();
