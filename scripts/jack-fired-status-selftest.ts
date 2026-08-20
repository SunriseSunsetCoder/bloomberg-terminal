/*
 * JACK board FIRED-status self-test (Phase 1) — persistence + read plumbing.
 *
 * Proves the close-confirmed fire flag written by the 18:00 EOD pass:
 *   · is SET-ONCE (markDecisionFired's `fired_at IS NULL` guard makes it idempotent)
 *   · carries through getCurrentBoard / getPendingSetups / getFiredFlagsForSetups
 *   · NEVER mutates decisions.section, and therefore never disturbs the pending
 *     scoping that the price refresh + alert passes run on — the hard mandate
 *
 * Real throwaway SQLite DB, exercising the actual migration + write + read paths.
 * No network, no Redis, no Telegram.
 *
 * Run:  npx tsx scripts/jack-fired-status-selftest.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const sorted = (a: string[]) => [...a].sort().join(",");

const dir = mkdtempSync(join(tmpdir(), "jack-fired-status-"));
process.env.JACK_DB_PATH = join(dir, "test.db");

const HLD = "2026-06-01";

async function main(): Promise<void> {
  const write = await import("../lib/db/write");
  const read = await import("../lib/db/read");
  const { getDb } = await import("../lib/db/init");
  const db = getDb();

  const meta = (t: string, n: number) => ({
    timestamp: t, inputRowCount: n, totalFinalCount: n, liveFinalCount: n, pendingFinalCount: n,
    liveDroppedStale: 0, pendingDroppedStale: 0, liveDroppedOverCap: 0, pendingDroppedOverCap: 0,
    tiingoAttempted: 0, tiingoSucceeded: 0, riskPerTrade: 2000, parseSuccess: true,
  });

  function ingest(ts: string, rows: Array<{ t: string; section: "live" | "pending" }>) {
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(`${r.t}|${HLD}`, write.upsertSetup({
        ticker: r.t, handleLowDate: HLD, status: r.section === "live" ? "just_fired" : "pending",
        entry: 101, stop: 95, t05Target: 115, breakoutLevel: 100,
        tier: "Q5", priority: 7.5, sizeBucket: "full",
      }, ts));
    }
    const runId = write.insertValidationRun(meta(ts, rows.length));
    const { ids } = write.insertDecisions(
      rows.map((r) => ({ ticker: r.t, handleLowDate: HLD, section: r.section, decision: "WATCH" })),
      runId, map
    );
    write.retireSupersededSetups([...map.values()], runId, ts);
    return { runId, ids, map };
  }

  // ---------------------------------------------------------------------------
  console.log("\n[1] Migration — the additive columns exist on a fresh DB");
  // ---------------------------------------------------------------------------
  {
    const cols = (db.pragma("table_info(decisions)") as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["fired_at", "fire_close", "fire_bar", "fired_status"]) {
      check(`decisions.${c} exists`, cols.includes(c));
    }
  }

  const run1 = ingest("2026-07-01T12:00:00.000Z", [
    { t: "FIRED", section: "pending" },
    { t: "QUIET", section: "pending" },
    { t: "LATER", section: "pending" },
  ]);
  const decisionOf = (t: string) => run1.ids.find((i) => i.ticker === t)!.decisionId;
  const setupOf = (t: string) => run1.map.get(`${t}|${HLD}`)!;

  // ---------------------------------------------------------------------------
  console.log("\n[2] markDecisionFired writes, and is SET-ONCE");
  // ---------------------------------------------------------------------------
  {
    const changed = write.markDecisionFired(decisionOf("FIRED"), {
      firedAt: "2026-07-02", fireClose: 101.25, fireBar: 3, firedStatus: "confirmed",
    });
    check("first call stamps the row", changed === 1, String(changed));

    const row = db.prepare(
      `SELECT fired_at AS a, fire_close AS c, fire_bar AS b, fired_status AS s FROM decisions WHERE id = ?`
    ).get(decisionOf("FIRED")) as { a: string; c: number; b: number; s: string };
    check("fired_at persisted", row.a === "2026-07-02", row.a);
    check("fire_close persisted", row.c === 101.25, String(row.c));
    check("fire_bar persisted", row.b === 3, String(row.b));
    check("fired_status persisted", row.s === "confirmed", row.s);

    // Second call with DIFFERENT values must be a no-op — first detection wins.
    const again = write.markDecisionFired(decisionOf("FIRED"), {
      firedAt: "2026-07-09", fireClose: 999, fireBar: 14, firedStatus: "resolved",
    });
    const after = db.prepare(
      `SELECT fired_at AS a, fire_close AS c, fire_bar AS b, fired_status AS s FROM decisions WHERE id = ?`
    ).get(decisionOf("FIRED")) as { a: string; c: number; b: number; s: string };
    check("second call changes nothing (idempotent)", again === 0, String(again));
    check("original values survive the re-stamp attempt", after.a === "2026-07-02" && after.c === 101.25 && after.b === 3 && after.s === "confirmed", JSON.stringify(after));

    check("an unfired row stays NULL", (db.prepare(
      `SELECT fired_at AS a FROM decisions WHERE id = ?`
    ).get(decisionOf("QUIET")) as { a: string | null }).a === null);
  }

  // ---------------------------------------------------------------------------
  console.log("\n[3] HARD MANDATE — section is untouched, scoping intact");
  // ---------------------------------------------------------------------------
  {
    const section = (db.prepare(`SELECT section FROM decisions WHERE id = ?`).get(decisionOf("FIRED")) as { section: string }).section;
    check("fired decision keeps section='pending'", section === "pending", section);

    const pending = read.getPendingSetups().map((p) => p.ticker);
    check(
      "fired setup is STILL in the pending set (price refresh + alerts keep covering it)",
      pending.includes("FIRED"),
      pending.join(",")
    );
    check("pending set is unchanged by the fire", sorted(pending) === sorted(["FIRED", "QUIET", "LATER"]), pending.join(","));

    const board = read.getCurrentBoard();
    check("board still shows it under pending, not live", board.pending.some((r) => r.ticker === "FIRED") && !board.live.some((r) => r.ticker === "FIRED"));
  }

  // ---------------------------------------------------------------------------
  console.log("\n[4] Fields carry through the read layer");
  // ---------------------------------------------------------------------------
  {
    const board = read.getCurrentBoard();
    const row = board.pending.find((r) => r.ticker === "FIRED")!;
    check("CurrentBoardRow.firedAt", row.firedAt === "2026-07-02", String(row.firedAt));
    check("CurrentBoardRow.fireClose", row.fireClose === 101.25, String(row.fireClose));
    check("CurrentBoardRow.fireBar", row.fireBar === 3, String(row.fireBar));
    check("CurrentBoardRow.firedStatus", row.firedStatus === "confirmed", String(row.firedStatus));
    check("an unfired board row carries nulls", board.pending.find((r) => r.ticker === "QUIET")!.firedStatus === null);

    const pend = read.getPendingSetups().find((p) => p.ticker === "FIRED")!;
    check("PendingSetupRow.decisionId is the current run's row", pend.decisionId === decisionOf("FIRED"), String(pend.decisionId));
    check("PendingSetupRow carries the fire flag", pend.firedAt === "2026-07-02" && pend.firedStatus === "confirmed" && pend.fireBar === 3);

    const flags = read.getFiredFlagsForSetups([setupOf("FIRED"), setupOf("QUIET")]);
    check("getFiredFlagsForSetups returns the fired setup", flags.get(setupOf("FIRED"))?.firedStatus === "confirmed");
    check("  with its close + bar", flags.get(setupOf("FIRED"))?.fireClose === 101.25 && flags.get(setupOf("FIRED"))?.fireBar === 3);
    check("  and omits the unfired one", !flags.has(setupOf("QUIET")));
    check("empty input → empty map, no query", read.getFiredFlagsForSetups([]).size === 0);
  }

  // ---------------------------------------------------------------------------
  console.log("\n[5] All three statuses round-trip");
  // ---------------------------------------------------------------------------
  {
    write.markDecisionFired(decisionOf("LATER"), {
      firedAt: "2026-07-03", fireClose: 100.5, fireBar: 7, firedStatus: "late",
    });
    const flags = read.getFiredFlagsForSetups([setupOf("LATER")]);
    check("'late' round-trips", flags.get(setupOf("LATER"))?.firedStatus === "late");

    const run2 = ingest("2026-07-08T12:00:00.000Z", [{ t: "RESOLV", section: "pending" }]);
    write.markDecisionFired(run2.ids[0].decisionId, {
      firedAt: "2026-07-09", fireClose: 102, fireBar: 2, firedStatus: "resolved",
    });
    const f2 = read.getFiredFlagsForSetups([run2.map.get(`RESOLV|${HLD}`)!]);
    check("'resolved' round-trips", f2.get(run2.map.get(`RESOLV|${HLD}`)!)?.firedStatus === "resolved");
  }

  // ---------------------------------------------------------------------------
  console.log("\n[6] The flag survives a re-VALIDATE (per-setup display lookup)");
  // ---------------------------------------------------------------------------
  {
    // A fresh run inserts NEW decision rows with fired_at NULL, and the EOD loop's
    // once-per-setup Redis marker stops it re-stamping. Reading per DECISION ROW would
    // lose the badge every Friday; getFiredFlagsForSetups reads per SETUP instead.
    const run3 = ingest("2026-07-15T12:00:00.000Z", [{ t: "FIRED", section: "pending" }]);
    const newDecisionId = run3.ids[0].decisionId;
    check("the re-validated row is a NEW decision", newDecisionId !== decisionOf("FIRED"));
    check(
      "the new current-run DB row has no flag of its own",
      (db.prepare(`SELECT fired_at FROM decisions WHERE id = ?`).get(newDecisionId) as { fired_at: string | null })
        .fired_at === null
    );
    // …but the BOARD READ resolves fired state per SETUP, across runs (the same join
    // getFiredFlagsForSetups uses). That is the fix for "shows LIVE on the JACK tab,
    // Basket Sizer won't size it": this read used to take the current run's own row,
    // so re-pasting the weekly CSV silently un-promoted the setup for the Sizer while
    // the tab kept showing it. Updated deliberately — the old expectation WAS the bug.
    check(
      "the board read still reports the fire after a re-VALIDATE (cross-run)",
      read.getPendingSetups().find((p) => p.ticker === "FIRED")!.firedAt !== null
    );
    check(
      "but the per-setup lookup still reports the fire (badge survives)",
      read.getFiredFlagsForSetups([setupOf("FIRED")]).get(setupOf("FIRED"))?.firedStatus === "confirmed"
    );
    check(
      "section STILL pending after re-validate + fire",
      (db.prepare(`SELECT section FROM decisions WHERE id = ?`).get(newDecisionId) as { section: string }).section === "pending"
    );
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.stack : String(err), "\n");
    process.exit(1);
  });
