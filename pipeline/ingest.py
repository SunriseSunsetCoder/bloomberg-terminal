#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pipeline/ingest.py — JACK daily pipeline, PHASE 4: headless ingest.

Posts the Phase 3 stamped watchlist into JACK's OWN validated ingest path and
writes jack.db. No raw CSV→SQLite dump, no second ingest route.

    python pipeline/ingest.py --watchlist <csv>
    python pipeline/ingest.py --watchlist <csv> --dry-run     # POST nothing
    python pipeline/ingest.py --watchlist <csv> --no-floor-guard

Exit codes:
    0  ingested
    2  precondition failed (no watchlist, no base URL, empty CSV)
    3  transport/HTTP failure talking to the app
    4  INGEST REFUSED by the floor guard — prior board deliberately preserved
    5  persistence unavailable (pointed at Vercel, where writes silently no-op)
    6  the endpoint ran but NOTHING WAS WRITTEN (or the write errored)

=============================================================================
WHY THIS POSTS TO THE APP INSTEAD OF WRITING SQLite DIRECTLY
=============================================================================

Everything that makes a row usable downstream happens inside
/api/jack-validation: the CSV contract (header aliases, BOM tolerance, the
fraction-vs-percent normalisation on cup_depth_pct), the handle-staleness filter,
the per-section caps, geometry capture, handle_score/size_bucket resolution, the
Phase 3 freshness stamp, decision-row insertion keyed to setup_id, and
retireSupersededSetups. A direct writer would have to re-implement all of it and
would drift the first time one of them changed.

That is Phase 0's classification cashed in: the Validate action is a plain API
route (Category 1), so the pipeline calls it directly — no wrapper, no refactor.

=============================================================================
analysis=best_effort — WHY THE LLM IS NOT IN THE CRITICAL PATH
=============================================================================

The route defaults to analysis="required" so the terminal UI is unchanged. This
script always sends "best_effort", which changes exactly one thing: if the
analysis cannot be produced — no API key, API down, timeout, rate limit,
unparseable JSON — the board is still built from the detector output and the rows
land with decision=UNREVIEWED.

That is safe because the model produces commentary only. It emits no geometry:
rim, entry, stop, t05, size_bucket, tier, priority and entry_status all come from
the CSV, and `section` comes from the route's own filter step. Nothing on the
promote/size path reads decisions.decision — isPromotedToLive keys on setups
geometry, isFiredActionable on fired_status (written by the promoter), and
isTradeableSetup on sizeBucket/tier. An UNREVIEWED row promotes and sizes exactly
like a graded one; only the verdict text is missing.

An Anthropic outage at 19:00 must not cost a night's board.

=============================================================================
THE FLOOR GUARD
=============================================================================

Sent as floorGuard=true (opt-in server-side, OFF by default). The route rejects
an ingest carrying under 50% of the prior board's setups — a broken scan reads as
a collapse, and without this it would silently retire the whole watchlist.

Ordering inside the route matters and is asserted by the selftest:
    filters → FLOOR CHECK → (pass) enrich → persist → retire
                          → (fail) reject, write nothing, prior board intact
The refusal returns BEFORE persistRun, and retireSupersededSetups lives INSIDE
persistRun, so a sub-floor run cannot retire anything.

The guard is deliberately NOT applied to manual pastes: an ad-hoc small VALIDATE
that shrinks the board is intended behaviour.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional, Sequence, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from pipeline.tiingo_pull import env, log, send_telegram  # noqa: E402

# ============================================================================
# Configuration
# ============================================================================

DEFAULT_BASE_URL = "http://localhost:3000"
INGEST_PATH = "/api/jack-validation"

# The route's own maxDuration is 120s and a full run does a Tiingo burst plus up
# to six Claude calls. Generous, because a timeout here would leave us unsure
# whether the write landed.
REQUEST_TIMEOUT = 300

DEFAULT_RISK_PER_TRADE = 2000


def base_url() -> str:
    return (env("JACK_SELF_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


# ============================================================================
# The POST
# ============================================================================

def post_ingest(csv_text: str, risk_per_trade: int, floor_guard: bool) -> Tuple[Optional[dict], str]:
    """Returns (payload, error). Never raises."""
    url = f"{base_url()}{INGEST_PATH}"
    body = json.dumps({
        "csv": csv_text,
        "riskPerTrade": risk_per_trade,
        "analysis": "best_effort",
        "floorGuard": floor_guard,
    }).encode("utf-8")

    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        return None, f"HTTP {exc.code} from {url}" + (f": {detail}" if detail else "")
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc} (is the app running at {base_url()}?)"

    try:
        return json.loads(raw), ""
    except ValueError:
        return None, f"response was not JSON: {raw[:200]!r}"


# ============================================================================
# Orchestration
# ============================================================================

def fail(code: int, headline: str, detail: str) -> int:
    log(f"FATAL: {headline} — {detail}")
    send_telegram(f"🛑 <b>{headline}</b>\n{detail}")
    return code


def run(watchlist: Path, risk_per_trade: int, floor_guard: bool, dry_run: bool) -> int:
    if not watchlist.is_file():
        return fail(2, "Ingest ABORTED — no watchlist", f"{watchlist} not found. Did run_detector.py run?")

    csv_text = watchlist.read_text(encoding="utf-8-sig", errors="replace").strip()
    if not csv_text:
        return fail(2, "Ingest ABORTED — empty watchlist", f"{watchlist} has no content.")

    rows = max(0, len(csv_text.splitlines()) - 1)
    has_stamp = "entry_status" in csv_text.splitlines()[0].lower()
    log(f"watchlist : {watchlist} ({rows} rows)")
    log(f"target    : {base_url()}{INGEST_PATH}")
    log(f"mode      : analysis=best_effort · floorGuard={floor_guard}")
    if not has_stamp:
        # Not fatal: the route drops an absent stamp to NULL rather than keeping a
        # stale one. But it means the alert loses its FRESH/AGING split.
        log("WARNING: watchlist carries no entry_status column — Phase 3 stamp missing.")

    if dry_run:
        log("DRY RUN — nothing posted.")
        return 0

    started = time.time()
    payload, err = post_ingest(csv_text, risk_per_trade, floor_guard)
    elapsed = time.time() - started

    if payload is None:
        return fail(3, "Ingest FAILED — could not reach JACK", err)

    # ---- floor guard refusal ------------------------------------------------
    if payload.get("ingestRefused"):
        prior = payload.get("priorCount", "?")
        new = payload.get("newCount", "?")
        log(f"INGEST REFUSED: count dropped {prior}→{new}. Prior board preserved.")
        send_telegram(
            f"🛑 <b>INGEST REFUSED: count dropped {prior}→{new}</b>\n"
            f"This scan carries under half the prior board's setups — reads as a broken scan, "
            f"not a real shrink.\n"
            f"<b>Nothing was written. The previous board is intact and nothing was retired.</b>\n"
            f"Check the Tiingo pull and the detector run before re-running."
        )
        return 4

    # ---- persistence off (pointed at Vercel) --------------------------------
    if payload.get("persistenceAvailable") is False:
        return fail(
            5, "Ingest FAILED — persistence unavailable",
            "The target has no SQLite layer, so writes silently no-op. "
            "JACK_SELF_BASE_URL must point at the VPS app, not Vercel.",
        )

    # ---- VERIFY THE WRITE ---------------------------------------------------
    #
    # filterStats is computed at applyFilters, BEFORE persistRun, and persistRun
    # is deliberately non-fatal — a DB error surfaces only in the response's
    # markdown preface. So "live 12 · pending 42" proves the CSV parsed, not that
    # a single row reached jack.db. An unattended job reporting success off a
    # filter count is the same class of lie this pipeline keeps removing, so the
    # structured persist block is authoritative here.
    persist = payload.get("persist") or {}
    if not persist:
        return fail(
            6, "Ingest FAILED — cannot verify the write",
            "The response carried no `persist` block, so there is no way to confirm "
            "anything reached jack.db. The app is likely older than the Phase 4 "
            "verification change — redeploy the VPS.",
        )
    if persist.get("error"):
        return fail(
            6, "Ingest FAILED — persistence error",
            f"The endpoint ran but the write failed: {persist['error']}. "
            f"The board was NOT updated.",
        )
    inserted = persist.get("decisionsInserted") or 0
    run_id = persist.get("runId")
    if run_id is None or inserted == 0:
        return fail(
            6, "Ingest FAILED — nothing written",
            f"run_id={run_id}, decisionsInserted={inserted}. The endpoint accepted the "
            f"CSV but produced no decision rows, so getCurrentRunId() will not resolve "
            f"to this run and the board will not move.",
        )

    skipped = persist.get("decisionsSkipped") or 0
    geometry_ok = persist.get("geometryOk") or 0
    setups = persist.get("setupsUpserted") or 0

    # ---- success ------------------------------------------------------------
    stats = payload.get("filterStats") or {}
    live = (stats.get("live") or {}).get("finalCount", "?")
    pending = (stats.get("pending") or {}).get("finalCount", "?")
    analysis_skipped = bool(payload.get("analysisSkipped"))
    unreviewed = payload.get("unreviewedCount") or 0
    err_msg = payload.get("error")

    log(f"WROTE run #{run_id} in {elapsed:.0f}s: {setups} setups · {inserted} decisions"
        + (f" · {skipped} skipped" if skipped else "")
        + f" · live {live} · pending {pending}"
        + (f" · {unreviewed} UNREVIEWED" if analysis_skipped else "")
        + (f" · error: {err_msg}" if err_msg else ""))
    if geometry_ok < setups:
        log(f"WARNING: only {geometry_ok}/{setups} setups are replayable "
            f"(need breakout_level + stop + t05_target) — outcome tracking will be partial.")

    verdict_line = (
        f"⚠️ <b>{unreviewed} setup(s) stored UNREVIEWED</b> — the analysis was unavailable, "
        f"so no verdict text. The board, promotion and sizing are unaffected."
        if analysis_skipped
        else "Analysis graded every setup."
    )
    send_telegram(
        f"📥 <b>Board updated</b>\n"
        f"live {live} · pending {pending} · {elapsed:.0f}s\n"
        f"{verdict_line}"
        + (f"\n⚠ {err_msg}" if err_msg else "")
    )
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="JACK Phase 4 — post the stamped watchlist into JACK's validated ingest path."
    )
    parser.add_argument("--watchlist", type=Path, required=True,
                        help="The Phase 3 stamped watchlist CSV.")
    parser.add_argument("--risk-per-trade", type=int, default=DEFAULT_RISK_PER_TRADE)
    parser.add_argument("--no-floor-guard", action="store_true",
                        help="Disable the 50%% floor guard for this run. Use only for a "
                             "deliberate, supervised shrink.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Validate the watchlist and print the plan. Posts nothing.")
    args = parser.parse_args(argv)

    return run(
        args.watchlist.expanduser().resolve(),
        args.risk_per_trade,
        not args.no_floor_guard,
        args.dry_run,
    )


if __name__ == "__main__":
    sys.exit(main())
