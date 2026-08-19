import { NextRequest, NextResponse } from "next/server";
import { isPersistenceAvailable, persistenceUnavailableReason } from "@/lib/db/env";

export const dynamic = "force-dynamic";

// ============================================================
// Interactive decision-row writes (Session B, Deliverable 2).
//
// Two mutation types, both guarded by isPersistenceAvailable() (VPS only):
//   type: "user_action" → decisions.user_action (TRADED/PASSED/WATCHED)
//   type: "user_fills"  → outcomes user-fill columns (+ computed user_R_realized)
//
// The interactive table is the source of truth for these writes; it binds to the
// structured JSON decisions the validation route returns (decision_id + setup_id),
// NOT to scraped markdown.
// ============================================================

type UserAction = "TRADED" | "PASSED" | "WATCHED";

interface UserActionBody {
  type: "user_action";
  decisionId: number;
  action: UserAction;
  userNotes?: string;
}

interface UserFillsBody {
  type: "user_fills";
  setupId: number;
  entry: number | null;
  entryDate: string | null;
  exit: number | null;
  exitDate: string | null;
}

type RequestBody = UserActionBody | UserFillsBody;

// ============================================================
// Re-hydration read (display-only): return the current user_action + fills for a
// set of setups so the interactive table can reload them on mount. Saving fills
// writes the DB but not the cached validation response, so returning to JACK
// without re-VALIDATE would otherwise show stale/blank rows. Read-only, guarded.
//   GET /api/jack-decisions?setupIds=1,2,3  ->  { marks: { "1": {...}, ... } }
// ============================================================
export async function GET(req: NextRequest) {
  if (!isPersistenceAvailable()) {
    return NextResponse.json({ marks: {} });
  }
  const raw = req.nextUrl.searchParams.get("setupIds") ?? "";
  const setupIds = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (setupIds.length === 0) {
    return NextResponse.json({ marks: {} });
  }
  try {
    const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");
    const map = dbRead.getUserMarksForSetups(setupIds);
    const marks: Record<string, import("@/lib/db/read").UserMark> = {};
    for (const [setupId, mark] of map) marks[String(setupId)] = mark;

    // Close-confirmed FIRE flags. This is the ONLY path that refreshes board rows
    // without a re-VALIDATE (the validation response is cached in a Jotai atom), so
    // it is what makes a fire visible the evening it happens.
    const firedMap = dbRead.getFiredFlagsForSetups(setupIds);
    const fired: Record<string, import("@/lib/db/read").FiredFlag> = {};
    for (const [setupId, flag] of firedMap) fired[String(setupId)] = flag;

    return NextResponse.json({ marks, fired });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ marks: {}, fired: {}, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isPersistenceAvailable()) {
    return NextResponse.json(
      { ok: false, error: persistenceUnavailableReason() },
      { status: 200 }
    );
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const dbWrite = require("@/lib/db/write") as typeof import("@/lib/db/write");
    const dbRead = require("@/lib/db/read") as typeof import("@/lib/db/read");

    if (body.type === "user_action") {
      if (typeof body.decisionId !== "number") {
        return NextResponse.json({ ok: false, error: "decisionId required" }, { status: 400 });
      }
      if (!["TRADED", "PASSED", "WATCHED"].includes(body.action)) {
        return NextResponse.json({ ok: false, error: "invalid action" }, { status: 400 });
      }
      dbRead.markDecisionUserAction(body.decisionId, body.action, body.userNotes);
      return NextResponse.json({ ok: true, type: "user_action", action: body.action });
    }

    if (body.type === "user_fills") {
      if (typeof body.setupId !== "number") {
        return NextResponse.json({ ok: false, error: "setupId required" }, { status: 400 });
      }
      const result = dbWrite.updateUserFills(
        body.setupId,
        body.entry ?? null,
        body.entryDate ?? null,
        body.exit ?? null,
        body.exitDate ?? null
      );

      // FILL-WRITE RECONCILIATION. Logging an entry flips the setup not-owned → OWNED,
      // so a "RAN TO TARGET UN-ENTERED" alert sent while it was still un-entered is now
      // wrong-in-hindsight: the position exists and its own target_hit will fire from a
      // DIFFERENT namespace. The namespace split is the load-bearing fix (the owned hit
      // fires either way); this purge is cleanup, so the un-entered line doesn't linger
      // beside the realized win. Deliberately here and NOT in updateUserFills — that is
      // a synchronous better-sqlite3 writer and has no business awaiting Redis.
      // Best-effort: a failure here must never fail the fill write.
      if (body.entry != null) {
        try {
          const ident = dbRead.getSetupIdentity(body.setupId);
          if (ident) {
            const alerts = require("@/lib/jack/alerts") as typeof import("@/lib/jack/alerts");
            await alerts.purgeMarker(alerts.hitMarkerKey("ran_to_target", ident.ticker, ident.handleLowDate));
          }
        } catch (err) {
          console.warn("JACK fill reconcile: ran_to_target purge skipped:", err);
        }
      }

      // user_R_realized = (exit - entry) / (entry - stop) — the execution-quality R.
      return NextResponse.json({
        ok: true,
        type: "user_fills",
        userRRealized: result.userRRealized,
        stop: result.stop,
      });
    }

    return NextResponse.json({ ok: false, error: "unknown request type" }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
