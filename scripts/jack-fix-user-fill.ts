/*
 * JACK one-off fix — correct a CORRUPTED user entry fill, directly in the DB.
 *
 * Background: UMBF's entry fill was logged as 15.00 against a ~150 setup (a dropped
 * decimal). A wrong cost basis poisons everything downstream of it — unrealized %,
 * the rules flag (near stop / near target), the position re-read prompt, and
 * user_R_realized. This corrects the ONE outcomes row; the guard that stops it
 * happening again lives in lib/jack/fill-guard.ts.
 *
 * DIRECT DB, NOT the API — the route is a Next runtime concern and this must be
 * runnable on the box that owns the SQLite file, with no server running.
 *
 * DRY RUN BY DEFAULT — prints the current row and what it would write, nothing else.
 *   npx tsx --env-file=.env.local scripts/jack-fix-user-fill.ts --ticker UMBF --price 153.00
 *   npx tsx --env-file=.env.local scripts/jack-fix-user-fill.ts --ticker UMBF --price 153.00 --apply
 *
 * Options:
 *   --ticker  <SYM>   required
 *   --price   <NUM>   required — the corrected ENTRY fill
 *   --setup-id <N>    disambiguate when a ticker has more than one filled setup
 *   --apply           perform the write (otherwise dry run)
 *   --force           write even if the fill-sanity guard objects to the NEW price
 *
 * Safety:
 *   · targets EXACTLY ONE setup — 0 or >1 candidates aborts and prints them
 *   · writes through updateUserFills (the same upsert the UI uses), passing the
 *     EXISTING exit price/date back unchanged, so only user_entry_price moves and
 *     user_R_realized is recomputed by the one code path that owns that formula
 *   · the new price is run through the decimal guard; a warning aborts unless --force
 *   · re-checks inside the transaction that the row is still the one it reported
 *   · touches ONE outcomes row. No setup, decision, or theoretical-outcome column.
 */

interface CandidateRow {
  setup_id: number;
  ticker: string;
  handle_low_date: string;
  entry: number | null;
  stop: number | null;
  t05_target: number | null;
  breakout_level: number | null;
  retired_at: string | null;
  user_entry_price: number | null;
  user_entry_date: string | null;
  user_exit_price: number | null;
  user_exit_date: string | null;
  user_R_realized: number | null;
  outcome_source: string | null;
  has_outcome: number;
  ever_traded: number;
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const TICKER = (argValue("--ticker") ?? "").trim().toUpperCase();
const PRICE_RAW = argValue("--price");
const SETUP_ID = argValue("--setup-id") != null ? Number(argValue("--setup-id")) : null;

const num = (n: number | null | undefined, dp = 2) => (n == null ? "—" : n.toFixed(dp));
const str = (s: string | null | undefined) => (s == null ? "—" : s);

function printRow(c: CandidateRow, indent = "  "): void {
  console.log(
    `${indent}setup_id=${c.setup_id}  ${c.ticker}  handle_low=${c.handle_low_date}  ` +
      `entry=${num(c.entry)} stop=${num(c.stop)} target=${num(c.t05_target)} rim=${num(c.breakout_level)}`
  );
  console.log(
    `${indent}  user_entry_price=${num(c.user_entry_price)}  user_entry_date=${str(c.user_entry_date)}  ` +
      `user_exit_price=${num(c.user_exit_price)}  user_exit_date=${str(c.user_exit_date)}  ` +
      `user_R=${num(c.user_R_realized)}  source=${str(c.outcome_source)}` +
      `${c.retired_at ? `  [setup retired ${c.retired_at.slice(0, 10)}]` : ""}`
  );
}

async function main(): Promise<number> {
  if (!TICKER || PRICE_RAW == null) {
    console.error(
      `\nUsage: npx tsx --env-file=.env.local scripts/jack-fix-user-fill.ts --ticker UMBF --price 153.00 [--setup-id N] [--apply] [--force]\n`
    );
    return 1;
  }
  const NEW_PRICE = Number(PRICE_RAW);
  if (!Number.isFinite(NEW_PRICE) || NEW_PRICE <= 0) {
    console.error(`\n--price must be a positive number (got "${PRICE_RAW}")\n`);
    return 1;
  }
  if (SETUP_ID != null && !Number.isFinite(SETUP_ID)) {
    console.error(`\n--setup-id must be a number\n`);
    return 1;
  }

  const { getDb } = await import("../lib/db/init");
  const write = await import("../lib/db/write");
  const { checkFillPrice } = await import("../lib/jack/fill-guard");
  const db = getDb();

  console.log("\n=================================================================");
  console.log(` JACK user-fill correction — ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);
  console.log("=================================================================\n");
  console.log(`DB        : ${db.name}`);
  console.log(`Ticker    : ${TICKER}`);
  console.log(`New entry : ${NEW_PRICE.toFixed(2)}\n`);

  // ---- 1. Every setup for this ticker, with its fill row ---------------------
  const all = db
    .prepare(
      `SELECT s.id                AS setup_id,
              s.ticker            AS ticker,
              s.handle_low_date   AS handle_low_date,
              s.entry             AS entry,
              s.stop              AS stop,
              s.t05_target        AS t05_target,
              s.breakout_level    AS breakout_level,
              s.retired_at        AS retired_at,
              o.user_entry_price  AS user_entry_price,
              o.user_entry_date   AS user_entry_date,
              o.user_exit_price   AS user_exit_price,
              o.user_exit_date    AS user_exit_date,
              o.user_R_realized   AS user_R_realized,
              o.outcome_source    AS outcome_source,
              (o.setup_id IS NOT NULL) AS has_outcome,
              EXISTS (SELECT 1 FROM decisions d
                       WHERE d.setup_id = s.id AND d.user_action = 'TRADED') AS ever_traded
         FROM setups s
         LEFT JOIN outcomes o ON o.setup_id = s.id
        WHERE UPPER(s.ticker) = ?
        ORDER BY s.handle_low_date ASC, s.id ASC`
    )
    .all(TICKER) as CandidateRow[];

  if (all.length === 0) {
    console.error(`ABORT — no setup in the DB has ticker ${TICKER}. Nothing written.\n`);
    return 1;
  }

  console.log(`Setups for ${TICKER} (${all.length}):`);
  for (const c of all) printRow(c);

  // ---- 2. Narrow to exactly one -------------------------------------------
  // A correctable row is one that HAS a logged entry fill. --setup-id overrides the
  // narrowing entirely (still required to have a fill to correct).
  let candidates = all.filter((c) => c.user_entry_price != null);
  if (SETUP_ID != null) candidates = candidates.filter((c) => c.setup_id === SETUP_ID);

  console.log(
    `\nCandidates with a logged entry fill${SETUP_ID != null ? ` and setup_id=${SETUP_ID}` : ""}: ${candidates.length}`
  );

  if (candidates.length === 0) {
    console.error(
      `\nABORT — 0 matching setups. There is no logged user_entry_price to correct` +
        `${SETUP_ID != null ? ` for setup_id=${SETUP_ID}` : ""}. Nothing written.\n` +
        `(To LOG a first fill, use the terminal's fill panel — this script only corrects an existing one.)\n`
    );
    return 1;
  }
  if (candidates.length > 1) {
    console.error(`\nABORT — ${candidates.length} matching setups. Refusing to guess. Nothing written.`);
    for (const c of candidates) printRow(c, "  ");
    console.error(`\nRe-run with --setup-id <N> to pick one.\n`);
    return 1;
  }

  const target = candidates[0];

  // ---- 3. Guard the NEW price (the same rule the UI now enforces) -----------
  const verdict = checkFillPrice("entry", NEW_PRICE, {
    entry: target.entry,
    breakout: target.breakout_level,
    stop: target.stop,
    target: target.t05_target,
  });
  const oldVerdict =
    target.user_entry_price != null
      ? checkFillPrice("entry", target.user_entry_price, {
          entry: target.entry,
          breakout: target.breakout_level,
          stop: target.stop,
          target: target.t05_target,
        })
      : null;

  console.log(`\n-----------------------------------------------------------------`);
  console.log(` TARGET`);
  console.log(`-----------------------------------------------------------------`);
  printRow(target);
  console.log(`\n  stored fill vs guard : ${oldVerdict == null ? "n/a" : oldVerdict.ok ? "plausible" : `REJECTED — ${oldVerdict.reason}`}`);
  console.log(`  new fill vs guard    : ${verdict.ok ? "plausible ✓" : `REJECTED — ${verdict.reason}`}`);

  console.log(`\n-----------------------------------------------------------------`);
  console.log(` CHANGE`);
  console.log(`-----------------------------------------------------------------`);
  console.log(`  outcomes.user_entry_price : ${num(target.user_entry_price)}  ->  ${NEW_PRICE.toFixed(2)}`);
  console.log(`  user_entry_date           : ${str(target.user_entry_date)}  (unchanged)`);
  console.log(`  user_exit_price / date    : ${num(target.user_exit_price)} / ${str(target.user_exit_date)}  (passed back unchanged)`);
  console.log(`  user_R_realized           : ${num(target.user_R_realized)}  ->  recomputed by updateUserFills`);
  console.log(`  rows affected             : 1 (outcomes, setup_id=${target.setup_id})`);

  if (!verdict.ok && !FORCE) {
    console.error(
      `\nABORT — the NEW price fails the fill-sanity guard. Nothing written.\n` +
        `  ${verdict.reason}\n` +
        `Re-run with --force if the price really is this.\n`
    );
    return 1;
  }
  if (!verdict.ok && FORCE) {
    console.log(`\n  ⚠ guard overridden by --force`);
  }

  // ---- 4. Apply -------------------------------------------------------------
  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run the same command with --apply to write it.\n`);
    return 0;
  }

  const applyTx = db.transaction(() => {
    // Re-check inside the transaction: same setup, same stored (bad) value.
    const now = db
      .prepare(`SELECT user_entry_price AS p, user_exit_price AS x, user_exit_date AS xd FROM outcomes WHERE setup_id = ?`)
      .get(target.setup_id) as { p: number | null; x: number | null; xd: string | null } | undefined;
    if (now == null) throw new Error(`outcomes row for setup_id=${target.setup_id} vanished — nothing written`);
    if (now.p !== target.user_entry_price) {
      throw new Error(
        `user_entry_price changed under us (${num(target.user_entry_price)} -> ${num(now.p)}) — nothing written`
      );
    }
    // The SAME upsert the UI writes through; exit side passed back unchanged so only
    // the entry moves and user_R_realized is recomputed by its owning code path.
    return write.updateUserFills(target.setup_id, NEW_PRICE, target.user_entry_date, now.x, now.xd);
  });

  const result = applyTx();

  const after = db
    .prepare(
      `SELECT user_entry_price AS p, user_entry_date AS d, user_exit_price AS x, user_exit_date AS xd,
              user_R_realized AS r, outcome_source AS src
         FROM outcomes WHERE setup_id = ?`
    )
    .get(target.setup_id) as {
    p: number | null; d: string | null; x: number | null; xd: string | null; r: number | null; src: string | null;
  };

  console.log(`\nAPPLIED — setup_id=${target.setup_id} (${target.ticker}).`);
  console.log(`  before : user_entry_price=${num(target.user_entry_price)}  user_R=${num(target.user_R_realized)}`);
  console.log(`  after  : user_entry_price=${num(after.p)}  user_entry_date=${str(after.d)}  ` +
    `user_exit_price=${num(after.x)}  user_exit_date=${str(after.xd)}  user_R=${num(after.r)}  source=${str(after.src)}`);
  console.log(`  stop used for user_R: ${num(result.stop)}`);

  if (after.p !== NEW_PRICE) {
    console.error(`\n  ⚠ WRITE DID NOT TAKE (${num(after.p)} != ${NEW_PRICE.toFixed(2)}) — investigate.\n`);
    return 1;
  }
  if (after.x !== target.user_exit_price || after.xd !== target.user_exit_date) {
    console.error(`\n  ⚠ EXIT SIDE MOVED — investigate immediately.\n`);
    return 1;
  }
  console.log(`  exit side unchanged ✓  entry corrected ✓\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.message : String(err), "\n");
    process.exit(1);
  });

// Module (top-level dynamic imports only) — keeps `main` out of the global script scope.
export {};
