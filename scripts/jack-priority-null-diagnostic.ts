/*
 * JACK priority-null diagnostic — READ-ONLY. Why do some PENDING rows show no P-rank?
 *
 * A P-chip is only rendered for a row carrying a scanner `priority`; a NULL priority
 * consumes no P-number (computePriorityRanks in lib/jack/combine-decisions.ts).
 *
 * This is the CONCLUSIVE cross-check: the DB says which board setups lack a rank, the
 * weekly watchlist archive says whether the scanner ever emitted one. Neither half can
 * tell an upstream scanner gap from a bug in our own ingest; together they can.
 *
 *   (a) EXPECTED          — no priority in the CSV AND the tier is skip / non-Q3-Q5.
 *                           The scanner does not rank setups you would skip, so a blank
 *                           is the correct output.
 *   (b) SCANNER GAP       — no priority in the CSV, but tier Q3-Q5 with a tradeable
 *                           bucket. A tradeable setup shipped without a pick-order.
 *   (c) INGEST BUG        — the CSV HAS a priority for this ticker+handle_low_date and
 *                           the DB is NULL. WE dropped it. Loudest finding.
 *   (d) NO ARCHIVE MATCH  — not in any archive CSV, so unclassifiable. Expect this for
 *                           setups older than the archive's coverage.
 *
 * Run on the VPS, where jack.db and the archive live:
 *   npx tsx scripts/jack-priority-null-diagnostic.ts
 *   npx tsx scripts/jack-priority-null-diagnostic.ts "D:/other/archive"
 *   JACK_ARCHIVE_DIR=D:/other/archive npx tsx scripts/jack-priority-null-diagnostic.ts
 *
 * Reuses getCurrentRunId / getCurrentBoard / getPendingSetups so the run-scoping and the
 * owned/retired exclusions are exactly the board's — no hand-rolled query, and nothing
 * goes through /api/jack-validation. Archive matching reuses the SAME helpers as the rim
 * backfill (lib/jack/archive-csv.ts), so the two tools cannot disagree about which CSV
 * row is "the same setup".
 *
 * SELECTs only: no writes, no Tiingo, no network. (The read layer opens the DB via
 * getDb(), which applies the idempotent additive migrations on open; this script issues
 * no writes of its own.)
 */
import { existsSync } from "node:fs";
import { normalizeTier } from "../lib/jack/backtest-reference";
import { normalizeSizeBucket } from "../lib/jack/handle-score";
import { readArchiveCsvs, dedupeLatest, archiveKey, type ArchiveRow } from "../lib/jack/archive-csv";

const DEFAULT_ARCHIVE_DIR = "c:/repos/watchlist";
const archiveDir =
  process.env.JACK_ARCHIVE_DIR || process.argv.slice(2).find((a) => !a.startsWith("--")) || DEFAULT_ARCHIVE_DIR;

const pad = (s: string, n: number) => s.padEnd(n);

type Cls = "ranked" | "expected" | "gap" | "ingest_bug" | "no_archive_match";

const MARK: Record<Cls, string> = {
  ranked: "ranked",
  expected: "blank (expected — scanner does not rank skips)",
  gap: "SCANNER GAP  <-- tradeable setup with no pick-order",
  ingest_bug: "INGEST BUG   <-- CSV HAS a priority, DB is NULL",
  no_archive_match: "no archive match (cannot classify)",
};

async function main(): Promise<number> {
  const read = await import("../lib/db/read");

  const runId = read.getCurrentRunId();
  if (runId === null) {
    console.error("\nNo validation run with decisions — nothing to diagnose. Run a VALIDATE first.\n");
    return 1;
  }
  const board = read.getCurrentBoard();
  const pending = read.getPendingSetups();

  console.log("\n=================================================================");
  console.log(" JACK priority-null diagnostic (read-only)");
  console.log("=================================================================");
  console.log(`current run          : #${runId}`);
  console.log(`board rows           : ${board.live.length} live · ${board.pending.length} pending`);
  console.log(`alert/board-eligible : ${pending.length} pending (owned + retired excluded)`);

  // ---- archive side --------------------------------------------------------
  // Latest-wins across the weekly files, keyed through the SHARED archiveKey.
  let archive = new Map<string, ArchiveRow>();
  let archiveOk = false;
  let archiveEarliest: string | null = null;

  if (existsSync(archiveDir)) {
    const { rows: aRows, files } = readArchiveCsvs(archiveDir);
    archive = dedupeLatest(aRows);
    archiveOk = true;
    for (const r of archive.values()) {
      if (archiveEarliest === null || r.handleLowDate < archiveEarliest) archiveEarliest = r.handleLowDate;
    }
    console.log(`archive              : ${archiveDir}`);
    console.log(
      `  ${files.length} file(s) · ${archive.size} distinct setup key(s)` +
        (archiveEarliest ? ` · earliest handle_low ${archiveEarliest}` : "")
    );
    const noPrio = files.filter((f) => !f.hasPriority);
    if (noPrio.length) {
      console.log(`  ⚠ ${noPrio.length} file(s) carry NO priority column: ${noPrio.map((f) => f.file).join(", ")}`);
    }
    const badDates = files.reduce((n, f) => n + f.badDates, 0);
    if (badDates) console.log(`  ⚠ ${badDates} archive row(s) had an unparseable handle_low_date and were skipped`);
  } else {
    console.log(`archive              : NOT FOUND at ${archiveDir}`);
    console.log("  Pass a path as an argument or set JACK_ARCHIVE_DIR. Without it, blanks can");
    console.log("  only be split into expected/gap — an INGEST BUG cannot be distinguished.");
  }
  console.log("");

  if (pending.length === 0) {
    console.log("No eligible pending setups on the current board.\n");
    return 0;
  }

  // ---- classify ------------------------------------------------------------
  const classify = (r: (typeof pending)[number]): { cls: Cls; csv: ArchiveRow | undefined } => {
    const csv = archive.get(archiveKey(r.ticker, r.handleLowDate));
    if (r.priority != null) return { cls: "ranked", csv };
    if (archiveOk && !csv) return { cls: "no_archive_match", csv };
    // (c) CSV has it, DB doesn't → our ingest dropped it.
    if (csv && csv.priority != null) return { cls: "ingest_bug", csv };
    // Prefer the CSV's own tier/bucket when matched — it is the source of the blank.
    const tier = normalizeTier(csv?.tier ?? r.tier);
    const bucket = normalizeSizeBucket(csv?.sizeBucket ?? r.sizeBucket);
    // (a) the scanner doesn't rank what you'd skip, or what isn't in a ranked tier
    if (bucket === "skip" || tier === null) return { cls: "expected", csv };
    // (b) tradeable tier + bucket, still unranked
    return { cls: "gap", csv };
  };

  const rows = pending.map((r) => {
    const { cls, csv } = classify(r);
    return { r, cls, csv };
  });

  // ---- per-row table -------------------------------------------------------
  console.log(
    `  ${pad("TICKER", 8)}${pad("TIER", 6)}${pad("SIZE_BUCKET", 13)}${pad("DB_PRIO", 10)}${pad("CSV_PRIO", 10)}CLASS`
  );
  for (const { r, cls, csv } of rows) {
    const csvPrio = csv ? (csv.priority != null ? csv.priority.toFixed(2) : "blank") : "-";
    console.log(
      `  ${pad(r.ticker, 8)}${pad(r.tier ?? "-", 6)}${pad(r.sizeBucket ?? "-", 13)}` +
        `${pad(r.priority != null ? r.priority.toFixed(2) : "NULL", 10)}${pad(csvPrio, 10)}${MARK[cls]}`
    );
  }

  // ---- summary -------------------------------------------------------------
  const of = (c: Cls) => rows.filter((x) => x.cls === c);
  const ranked = of("ranked");
  const expected = of("expected");
  const gaps = of("gap");
  const bugs = of("ingest_bug");
  const unmatched = of("no_archive_match");

  console.log("\n--- SUMMARY -----------------------------------------------------");
  console.log(`  total pending (eligible)     : ${pending.length}`);
  console.log(`  WITH a priority (shows Pn)   : ${ranked.length}`);
  console.log(`  WITHOUT a priority (no chip) : ${pending.length - ranked.length}`);
  console.log(`    (a) EXPECTED (skip / untiered)        : ${expected.length}`);
  console.log(`    (b) SCANNER GAP (Q3-Q5 + tradeable)   : ${gaps.length}`);
  console.log(`    (c) INGEST BUG (CSV had it, DB NULL)  : ${bugs.length}`);
  console.log(`    (d) NO ARCHIVE MATCH                  : ${unmatched.length}`);

  if (bugs.length > 0) {
    console.log("\n  ############################################################");
    console.log("  (c) INGEST BUG — the scanner DID rank these; we lost it:");
    for (const { r, csv } of bugs) {
      console.log(
        `    ${pad(r.ticker, 8)}${r.handleLowDate}  csv priority ${csv?.priority?.toFixed(2)}  (from ${csv?.file})`
      );
    }
    console.log("  Fix the ingest, then re-VALIDATE or backfill priority the way the rim");
    console.log("  was backfilled. This is OUR defect, not the scanner's.");
    console.log("  ############################################################");
  }

  if (gaps.length > 0) {
    console.log("\n  (b) SCANNER GAP — tradeable but unranked upstream:");
    for (const { r, csv } of gaps) {
      console.log(
        `    ${pad(r.ticker, 8)}tier ${pad(csv?.tier ?? r.tier ?? "-", 4)} bucket ${pad(csv?.sizeBucket ?? r.sizeBucket ?? "-", 6)}` +
          (csv ? `  (csv row from ${csv.file}, priority blank)` : "")
      );
    }
    console.log("  Chase these upstream: the scanner emitted a Q3-Q5 tradeable setup with no");
    console.log("  pick-order, so the board cannot rank it.");
  }

  if (unmatched.length > 0) {
    console.log("\n  (d) NO ARCHIVE MATCH — unclassifiable:");
    for (const { r } of unmatched) {
      const old = archiveEarliest != null && r.handleLowDate < archiveEarliest;
      console.log(`    ${pad(r.ticker, 8)}${r.handleLowDate}${old ? "   (predates the archive's earliest row)" : ""}`);
    }
    if (archiveEarliest) {
      console.log(`  The archive's earliest handle_low is ${archiveEarliest}; anything older cannot be`);
      console.log("  checked against a CSV, so its blank priority is neither confirmed nor denied.");
    }
  }

  if (gaps.length === 0 && bugs.length === 0) {
    console.log("\n  No scanner gaps and no ingest bugs — every unranked pending row is a");
    console.log("  skip/untiered setup, i.e. the scanner behaving as designed.");
  }

  // Secondary check: rows ranked in BOTH places but disagreeing. Not one of the four
  // buckets (the DB isn't NULL), but a silent mismatch is worth surfacing.
  const drift = rows.filter(
    ({ r, csv }) => r.priority != null && csv?.priority != null && Math.abs(r.priority - csv.priority) > 1e-9
  );
  if (drift.length > 0) {
    console.log(`\n  ⚠ ${drift.length} row(s) carry a DIFFERENT priority in the DB than in the archive:`);
    for (const { r, csv } of drift) {
      console.log(`    ${pad(r.ticker, 8)}db ${r.priority?.toFixed(2)}  vs  csv ${csv?.priority?.toFixed(2)} (${csv?.file})`);
    }
    console.log("  Likely a later scan re-ranked the setup; the DB keeps the first value seen");
    console.log("  (upsertSetup COALESCEs priority). Informational.");
  }

  // Blank-priority breakdown, so a surprising tier/bucket pairing is visible rather
  // than hidden inside a bucket count.
  const blanks = rows.filter((x) => x.cls !== "ranked");
  if (blanks.length > 0) {
    const combos = new Map<string, number>();
    for (const { r, csv } of blanks) {
      const k = `tier ${csv?.tier ?? r.tier ?? "(null)"} · bucket ${csv?.sizeBucket ?? r.sizeBucket ?? "(null)"}`;
      combos.set(k, (combos.get(k) ?? 0) + 1);
    }
    console.log("\n  blank-priority rows by tier/bucket:");
    for (const [k, n] of [...combos.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${pad(k, 40)}${n}`);
    }
  }

  console.log("\nRead-only — nothing was written.\n");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.stack : String(err), "\n");
    process.exit(1);
  });

export {};
