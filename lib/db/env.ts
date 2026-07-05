// =============================================================================
// JACK persistence environment gate (v1.3)
// =============================================================================
//
// SQLite (better-sqlite3) needs a persistent, writable filesystem. Vercel's
// serverless runtime doesn't have one, so persistence must be disabled there.
// The route uses these guards to decide whether to touch the DB layer at all —
// on Vercel it never require()s better-sqlite3, so the native module is never
// loaded and the deploy stays green (see PROJECT_STATE.md §3).
//
// Detection:
//   process.env.VERCEL === "1"                    -> running on Vercel, skip
//   process.env.JACK_DISABLE_PERSISTENCE === "1"  -> manual override for testing
//   otherwise                                     -> persistence enabled (VPS/local)

export function isPersistenceAvailable(): boolean {
  if (process.env.VERCEL === "1") return false;
  if (process.env.JACK_DISABLE_PERSISTENCE === "1") return false;
  return true;
}

export function persistenceUnavailableReason(): string {
  if (process.env.VERCEL === "1") return "disabled (running on Vercel)";
  if (process.env.JACK_DISABLE_PERSISTENCE === "1")
    return "disabled (JACK_DISABLE_PERSISTENCE=1)";
  return "available";
}
