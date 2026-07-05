import { getDb } from "./init";

export function countValidationRuns(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM validation_runs`).get() as { c: number };
  return row.c;
}

export function countSetups(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM setups`).get() as { c: number };
  return row.c;
}

export function countDecisions(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM decisions`).get() as { c: number };
  return row.c;
}

export function getLatestRunSummary(): {
  runId: number;
  timestamp: string;
  liveDecisions: number;
  pendingDecisions: number;
  parseSuccess: boolean;
} | null {
  const db = getDb();
  const run = db
    .prepare(`SELECT id, timestamp, parse_success FROM validation_runs ORDER BY id DESC LIMIT 1`)
    .get() as { id: number; timestamp: string; parse_success: number } | undefined;
  if (!run) return null;

  const counts = db
    .prepare(
      `SELECT section, COUNT(*) AS c
       FROM decisions WHERE validation_run_id = ?
       GROUP BY section`
    )
    .all(run.id) as Array<{ section: string; c: number }>;

  const live = counts.find((c) => c.section === "live")?.c ?? 0;
  const pending = counts.find((c) => c.section === "pending")?.c ?? 0;

  return {
    runId: run.id,
    timestamp: run.timestamp,
    liveDecisions: live,
    pendingDecisions: pending,
    parseSuccess: run.parse_success === 1,
  };
}

export function markDecisionUserAction(
  decisionId: number,
  action: "TRADED" | "PASSED" | "WATCHED",
  userNotes?: string
): void {
  const db = getDb();
  db.prepare(
    `UPDATE decisions SET user_action = ?, user_action_at = ?, user_notes = ? WHERE id = ?`
  ).run(action, new Date().toISOString(), userNotes ?? null, decisionId);
}
