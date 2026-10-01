// READ-ONLY diagnostic: live (TRADED) vs same-period paper arm, from data/jack.db.
// Opens the DB with { readonly: true } — no writes, no API calls.
//
//   node scripts/jack-live-vs-paper-diag.mjs [path/to/jack.db]
//
// Writes data/exports/jack-diag-<YYYY-MM-DD>/{traded,stopouts,paper,summary}.{csv,md}
// and echoes every SQL statement it ran into summary.md.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = process.argv[2] ?? "data/jack.db";
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const today = new Date().toISOString().slice(0, 10);
const outDir = path.join("data", "exports", `jack-diag-${today}`);
fs.mkdirSync(outDir, { recursive: true });

// Shared CTEs.
//  fire:   first close-confirmed fire per setup (decisions.fired_at is set once).
//  marked: the decision row the user marked TRADED (latest mark wins).
//  ranked: APPROXIMATE P-rank — ordinal by priority DESC among LIVE decisions in
//          the same validation run as the mark. The board's true P-rank also
//          tie-breaks on size bucket / handle_score and skips owned rows; it is
//          computed at render time and never persisted, so this is the closest
//          reconstruction. setups.priority/tier are the CURRENT values, not
//          frozen at mark (only handle_score/size_bucket have *_at_mark columns).
const CTES = `
WITH fire AS (
  SELECT d.setup_id,
         MIN(d.fired_at) AS fired_at,
         (SELECT d2.fired_status FROM decisions d2
           WHERE d2.setup_id = d.setup_id AND d2.fired_at IS NOT NULL
           ORDER BY d2.fired_at, d2.id LIMIT 1) AS fired_status
  FROM decisions d
  WHERE d.fired_at IS NOT NULL
  GROUP BY d.setup_id
),
marked AS (
  SELECT * FROM (
    SELECT d.*, ROW_NUMBER() OVER (PARTITION BY d.setup_id
                                   ORDER BY d.user_action_at DESC, d.id DESC) AS rn
    FROM decisions d WHERE d.user_action = 'TRADED'
  ) WHERE rn = 1
),
ranked AS (
  SELECT d.id AS decision_id,
         RANK() OVER (PARTITION BY d.validation_run_id ORDER BY s.priority DESC) AS prank
  FROM decisions d JOIN setups s ON s.id = d.setup_id
  WHERE d.section = 'live' AND s.priority IS NOT NULL
)`;

const SQL_TRADED = `${CTES}
SELECT
  s.id                                   AS setup_id,
  s.ticker,
  s.tier,
  m.handle_score_at_mark,
  m.size_bucket_at_mark,
  s.priority                             AS priority_now,
  r.prank                                AS p_rank_at_mark_approx,
  m.section                              AS section_at_mark,
  m.jack_decision_at_mark,
  m.user_action_at                       AS marked_at,
  s.handle_low_date,
  COALESCE(o.fire_date, f.fired_at)      AS fire_date,
  CASE f.fired_status WHEN 'confirmed' THEN 'entry_confirmed'
                      WHEN 'late'      THEN 'late_entry'
                      ELSE 'none' END    AS entry_alert,
  f.fired_status                         AS fired_status_raw,
  s.stop,
  s.t05_target,
  o.entry_price_actual                   AS board_next_open,
  o.entry_date_actual                    AS board_entry_date,
  o.user_entry_price,
  o.user_entry_date,
  ROUND(100.0 * (o.user_entry_price - o.entry_price_actual) / o.entry_price_actual, 2)
                                         AS entry_slippage_pct,
  o.user_exit_price,
  o.user_exit_date,
  CASE
    WHEN o.user_exit_price IS NULL                                   THEN 'open'
    WHEN o.user_exit_price <= s.stop * 1.001                         THEN 'stop'
    WHEN s.t05_target IS NOT NULL AND o.user_exit_price >= s.t05_target * 0.999 THEN 'target'
    WHEN o.exit_reason = 'timeout' AND o.exit_date = o.user_exit_date THEN 'time'
    ELSE 'manual'
  END                                    AS user_exit_reason_inferred,
  ROUND(o.user_R_realized, 3)            AS user_R,
  o.exit_reason                          AS replay_exit_reason,
  o.exit_date                            AS replay_exit_date,
  ROUND(o.R_realized, 3)                 AS replay_R,
  ROUND(o.user_R_realized - o.R_realized, 3) AS exec_delta_R,
  CAST(julianday(COALESCE(o.user_exit_date, date('now'))) - julianday(o.user_entry_date) AS INTEGER)
                                         AS days_held,
  s.sector
FROM marked m
JOIN setups s        ON s.id = m.setup_id
LEFT JOIN outcomes o ON o.setup_id = s.id
LEFT JOIN fire f     ON f.setup_id = s.id
LEFT JOIN ranked r   ON r.decision_id = m.id
ORDER BY o.user_entry_date, s.ticker`;

// Paper arm start = first live entry (fallback: first TRADED mark).
const SQL_FIRST_TRADE = `
SELECT COALESCE(
  (SELECT MIN(o.user_entry_date) FROM outcomes o
     JOIN decisions d ON d.setup_id = o.setup_id AND d.user_action = 'TRADED'
    WHERE o.user_entry_date IS NOT NULL),
  (SELECT MIN(substr(user_action_at, 1, 10)) FROM decisions WHERE user_action = 'TRADED')
) AS first_trade_date`;

const SQL_PAPER = `${CTES}
SELECT
  s.id                                   AS setup_id,
  s.ticker,
  s.tier,
  s.handle_low_date,
  COALESCE(o.fire_date, f.fired_at)      AS fire_date,
  CASE f.fired_status WHEN 'confirmed' THEN 'entry_confirmed'
                      WHEN 'late'      THEN 'late_entry'
                      ELSE 'none' END    AS entry_alert,
  o.entry_price_actual                   AS replay_entry,
  o.entry_date_actual                    AS replay_entry_date,
  COALESCE(o.exit_reason, 'no_outcome')  AS replay_exit_reason,
  o.exit_date                            AS replay_exit_date,
  ROUND(o.R_realized, 3)                 AS replay_R,
  CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END AS traded,
  s.sector
FROM setups s
LEFT JOIN outcomes o ON o.setup_id = s.id
LEFT JOIN fire f     ON f.setup_id = s.id
LEFT JOIN marked m   ON m.setup_id = s.id
WHERE UPPER(s.tier) IN ('Q3', 'Q4', 'Q5')
  AND COALESCE(o.fire_date, f.fired_at) >= @start
ORDER BY fire_date, s.ticker`;

const traded = db.prepare(SQL_TRADED).all();
const firstTrade = db.prepare(SQL_FIRST_TRADE).get().first_trade_date;
const paper = firstTrade ? db.prepare(SQL_PAPER).all({ start: firstTrade }) : [];
const stopouts = traded
  .filter((t) => t.user_exit_reason_inferred === "stop" && t.user_R != null)
  .map((t) => ({
    ticker: t.ticker,
    stop: t.stop,
    user_entry_price: t.user_entry_price,
    user_exit_price: t.user_exit_price,
    user_R: t.user_R,
    gap_slippage_R: +(t.user_R + 1).toFixed(3),
    exit_vs_stop_pct: +((100 * (t.user_exit_price - t.stop)) / t.stop).toFixed(2),
    replay_exit_reason: t.replay_exit_reason,
    replay_R: t.replay_R,
  }));

// ---- stats ----
function stats(rs) {
  const n = rs.length;
  if (!n) return { n: 0, WR: "", avgR: "", PF: "", netR: "" };
  const wins = rs.filter((r) => r > 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = -rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  const net = rs.reduce((a, b) => a + b, 0);
  return {
    n,
    WR: `${((100 * wins.length) / n).toFixed(1)}%`,
    avgR: (net / n).toFixed(3),
    PF: gl === 0 ? (gw > 0 ? "inf" : "") : (gw / gl).toFixed(2),
    netR: net.toFixed(2),
  };
}
const CLOSED = new Set(["target", "stop", "timeout"]);
const liveClosed = traded.filter((t) => t.user_exit_price != null && t.user_R != null);
const paperClosed = paper.filter((p) => CLOSED.has(p.replay_exit_reason) && p.replay_R != null);
// "live trades, replay R" isolates execution from selection.
const liveReplay = traded.filter((t) => CLOSED.has(t.replay_exit_reason) && t.replay_R != null);

const week = (d) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // Monday
  return dt.toISOString().slice(0, 10);
};
function groupBy(rows, keyFn, rFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r) ?? "(none)";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(rFn(r));
  }
  return [...m.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
}

const summary = [
  { arm: "LIVE (user fills)", ...stats(liveClosed.map((t) => t.user_R)),
    still_open: traded.filter((t) => t.user_exit_price == null).length },
  { arm: "LIVE trades @ replay R", ...stats(liveReplay.map((t) => t.replay_R)),
    still_open: traded.filter((t) => t.replay_exit_reason === "still_open").length },
  { arm: "PAPER Q3-Q5 since first trade", ...stats(paperClosed.map((p) => p.replay_R)),
    still_open: paper.filter((p) => p.replay_exit_reason === "still_open").length },
  { arm: "PAPER not traded", ...stats(paperClosed.filter((p) => !p.traded).map((p) => p.replay_R)),
    still_open: paper.filter((p) => !p.traded && p.replay_exit_reason === "still_open").length },
];
const byWeek = [
  ...groupBy(liveClosed, (t) => week(t.user_exit_date), (t) => t.user_R).map(([k, rs]) => ({ arm: "live", exit_week: k, ...stats(rs) })),
  ...groupBy(paperClosed, (p) => week(p.replay_exit_date), (p) => p.replay_R).map(([k, rs]) => ({ arm: "paper", exit_week: k, ...stats(rs) })),
];
const byTier = [
  ...groupBy(liveClosed, (t) => t.tier, (t) => t.user_R).map(([k, rs]) => ({ arm: "live", tier: k, ...stats(rs) })),
  ...groupBy(paperClosed, (p) => p.tier, (p) => p.replay_R).map(([k, rs]) => ({ arm: "paper", tier: k, ...stats(rs) })),
];

// ---- output ----
const csvCell = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}
function toMd(rows) {
  if (!rows.length) return "_(no rows)_\n";
  const cols = Object.keys(rows[0]);
  return [
    `| ${cols.join(" | ")} |`,
    `| ${cols.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${cols.map((c) => (r[c] ?? "")).join(" | ")} |`),
  ].join("\n") + "\n";
}

const files = { traded, stopouts, paper, summary, by_exit_week: byWeek, by_tier: byTier };
for (const [name, rows] of Object.entries(files)) fs.writeFileSync(path.join(outDir, `${name}.csv`), toCsv(rows));

const md = [
  `# JACK live vs paper — ${today}`,
  `DB: \`${dbPath}\` (opened read-only). Paper-arm start (first live entry): **${firstTrade ?? "n/a — no TRADED setups"}**`,
  `## 1. Traded setups (${traded.length})`, toMd(traded),
  `## 2. Stop-outs vs -1R (${stopouts.length})`, toMd(stopouts),
  `## 3. Paper arm — Q3–Q5 fired since first trade (${paper.length})`, toMd(paper),
  `## 4. Summary (closed trades only)`, toMd(summary),
  `### R by exit week (Monday)`, toMd(byWeek),
  `### R by quintile`, toMd(byTier),
  `## Notes`,
  `- user exit reason is INFERRED (no user exit-reason column): exit ≤ stop → stop, ≥ t05_target → target, same day as a replay timeout → time, else manual.`,
  `- P-rank at mark is APPROXIMATE (priority DESC within the marking run's LIVE rows; board tie-breaks not reproduced). tier/priority are current values, not frozen at mark.`,
  `- board_next_open = outcomes.entry_price_actual (replay's next-open fill). Requires the outcome replay to have run for that setup.`,
  `## SQL`,
  "```sql\n-- traded\n" + SQL_TRADED.trim() + "\n\n-- first trade date\n" + SQL_FIRST_TRADE.trim() +
    "\n\n-- paper (@start = first trade date)\n" + SQL_PAPER.trim() + "\n```",
].join("\n\n");
fs.writeFileSync(path.join(outDir, "summary.md"), md);
console.log(md);
console.error(`\nwrote ${outDir}`);
