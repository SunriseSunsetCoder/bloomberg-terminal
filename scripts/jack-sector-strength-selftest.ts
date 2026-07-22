/*
 * Sector-strength board self-test — the PURE ranking logic (no network/Redis).
 *
 * Proves: pctBack over each window; per-sector today/1w/1m/3m; RS = sector − SPY;
 * PRIMARY rank = rs3m descending, nulls last; insufficient-history sinks to the
 * bottom; and the SPY-missing fallback (rank by raw 3-month, rsAvailable=false).
 *
 * Run:  npx tsx scripts/jack-sector-strength-selftest.ts
 */
import { computeSectorBoard, pctBack } from "../lib/sector-strength";

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
const approx = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 1e-6;

// Build a 64-bar close series (len=64 → 3-month lookback n=63 reads index 0).
// Only the lookback reference indices matter: 0 (3m), 42 (1m, 63−21), 58 (1w, 63−5),
// 62 (today, 63−1), 63 (last). Unread indices are filled with `last`.
function series(o: { d0: number; d42: number; d58: number; d62: number; last: number }): number[] {
  const arr = new Array<number>(64).fill(o.last);
  arr[0] = o.d0;
  arr[42] = o.d42;
  arr[58] = o.d58;
  arr[62] = o.d62;
  arr[63] = o.last;
  return arr;
}
// Sector where only the 3-month move matters (1m/1w/today ≈ 0).
const sec3m = (m3pct: number): number[] => series({ d0: 100, d42: 100 + m3pct, d58: 100 + m3pct, d62: 100 + m3pct, last: 100 + m3pct });

// ---- 1. pctBack over windows ----
console.log("\n[1] pctBack");
check("pctBack([100,110],1) === +10", approx(pctBack([100, 110], 1), 10), String(pctBack([100, 110], 1)));
check("pctBack([100],1) === null (len < 2)", pctBack([100], 1) === null);
check("pctBack(len 3, n=5) === null (insufficient)", pctBack([100, 110, 120], 5) === null);
check("pctBack ref 0 → null", pctBack([0, 110], 1) === null);

// ---- 2. Full board: rank by rs3m, windows compute, RS = sector − SPY ----
console.log("\n[2] Board ranked by 3-month RS vs SPY");
{
  const board = computeSectorBoard({
    SPY: series({ d0: 100, d42: 104, d58: 104.5, d62: 105, last: 105 }), // 3m +5%
    XLK: series({ d0: 100, d42: 110, d58: 115, d62: 117, last: 118 }), // 3m +18% → rs +13 (TOP)
    XLF: sec3m(10), // 3m +10% → rs +5
    XLV: sec3m(6),
    XLI: sec3m(6),
    XLY: sec3m(6),
    XLP: sec3m(6),
    XLB: sec3m(6),
    XLRE: sec3m(6),
    XLC: sec3m(6), // 7 "rest" @ 3m +6 → rs +1
    XLU: sec3m(1), // 3m +1% → rs −4 (last among data)
    XLE: [100], // insufficient history → null metrics → absolute last
  });

  check("rsAvailable true (SPY 3m present)", board.rsAvailable === true);
  check("SPY m3 === +5", approx(board.spy?.m3, 5), String(board.spy?.m3));
  check("11 sector rows", board.sectors.length === 11, String(board.sectors.length));

  const top = board.sectors[0];
  check("rank 1 = XLK", top.ticker === "XLK", top.ticker);
  check("XLK m3 === +18", approx(top.m3, 18), String(top.m3));
  check("XLK rs3m === +13 (18 − 5)", approx(top.rs3m, 13), String(top.rs3m));
  check("XLK windows all computed (today/1w/1m non-null)", top.today != null && top.w1 != null && top.m1 != null);
  check("XLK m1 ≈ +7.27 ((118−110)/110)", approx(top.m1, ((118 - 110) / 110) * 100), String(top.m1));

  check("rank 2 = XLF, rs3m +5", board.sectors[1].ticker === "XLF" && approx(board.sectors[1].rs3m, 5), board.sectors[1].ticker);
  check("rank 10 = XLU, rs3m −4 (last among data)", board.sectors[9].ticker === "XLU" && approx(board.sectors[9].rs3m, -4), board.sectors[9].ticker);
  check("rank 11 = XLE, m3/rs3m null (insufficient sinks last)", board.sectors[10].ticker === "XLE" && board.sectors[10].m3 === null && board.sectors[10].rs3m === null);
}

// ---- 3. SPY-missing fallback: rank by RAW 3-month, rsAvailable false ----
console.log("\n[3] SPY 3m missing → fallback to raw 3-month ranking");
{
  const board = computeSectorBoard({
    // No SPY → spy null → rsAvailable false.
    XLK: sec3m(18),
    XLF: sec3m(10),
    XLV: sec3m(6),
    XLI: sec3m(6),
    XLY: sec3m(6),
    XLP: sec3m(6),
    XLB: sec3m(6),
    XLRE: sec3m(6),
    XLC: sec3m(6),
    XLE: sec3m(3),
    XLU: sec3m(1),
  });
  check("rsAvailable false (no SPY baseline)", board.rsAvailable === false);
  check("rs3m null when SPY missing", board.sectors.every((s) => s.rs3m === null));
  check("ranked by RAW 3m → rank 1 XLK (+18)", board.sectors[0].ticker === "XLK" && approx(board.sectors[0].m3, 18));
  check("ranked by RAW 3m → last XLU (+1)", board.sectors[board.sectors.length - 1].ticker === "XLU" && approx(board.sectors[board.sectors.length - 1].m3, 1));
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
