import { NextResponse } from "next/server";
import { buildM2Payload } from "@/lib/m2/server";

// M2 panel (IV tab): live SPY status from Tiingo + the alert script's state file and
// trade ledger, READ-ONLY. All logic lives in lib/m2 — this file exports only the
// handler + route config (Next16 build rule).
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    return NextResponse.json(await buildM2Payload());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), live: null },
      { status: 500 }
    );
  }
}
