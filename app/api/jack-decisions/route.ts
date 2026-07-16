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
