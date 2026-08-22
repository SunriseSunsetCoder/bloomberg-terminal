#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pipeline/run_detector.py — JACK daily pipeline, PHASE 2: headless detector run.

Runs the validated Cup-with-Handle detector on the VPS via papermill, replacing
the manual Colab session. Detection, scoring and exit logic are untouched — the
only notebook changes are path/mount parameterization (see notebooks/README.md).

    python pipeline/run_detector.py                    # full chain
    python pipeline/run_detector.py --check-only       # guards only, no execution
    python pipeline/run_detector.py --data-dir D       # override corpus location

Exit codes:
    0  watchlist produced and scored
    2  precondition failed (thresholds seed missing/invalid, corpus missing)
    3  a notebook raised during execution
    4  SCORING DID NOT LAND — watchlist exists but every setup is unscored
    5  an expected output file was missing or stale after a notebook ran

=============================================================================
WHY TWO papermill RUNS AND NOT ONE
=============================================================================

cup_handle_weekly.ipynb originally pulled the detector in with the IPython line
magic `%run cup_handle_active_scanner.ipynb`. papermill executes ONE notebook
top-to-bottom and does not resolve that child notebook, so the chain is made
explicit here: the scanner runs as its own papermill job first, then the weekly
runs with SCANNER_ALREADY_RAN=True so its Step 2 cell skips the %run.

That substitution is safe because the two notebooks are coupled only through a
file on disk, never through shared Python state:

    scanner  Cell 6  WRITES  <OUT_DIR>/cup_handle_active_setups.csv
    weekly   Step 5  READS   <OUT_DIR>/cup_handle_active_setups.csv   (PENDING_CSV)

The weekly re-reads that CSV into its own DataFrame and defines its own
latest_close(); it never reads a variable the scanner defined. (`_scanner_ok` is
set inside the scanner cell and read nowhere else.) Both notebooks receive the
SAME DATA_DIR/OUT_DIR parameters from this script, so the write target and the
read target are the same path by construction.

=============================================================================
THE FAIL-LOUD GUARD (two parts — precondition AND outcome)
=============================================================================

handle_score_thresholds.json is a FROZEN one-time seed produced by
handle_score_freeze.ipynb. The weekly notebook degrades gracefully without it:
load_handle_thresholds() prints a warning and returns None, then score_and_size()
stamps every row 'unscored' and the run completes normally, publishing a
plausible watchlist with NO SIZE BUCKETS. Nothing raises. That is the failure
this guard exists to make impossible.

Checking the file is present is NOT enough — the file can be present and the
scoring still not land (a schema drift, a feature column the scanner stopped
emitting, an exception swallowed inside the notebook). So both are checked:

  (a) PRECONDITION, before any notebook runs — the thresholds file exists,
      parses, and carries the frozen contract (see THRESHOLDS_CONTRACT). This is
      also where a STALE copy is caught: the Q3 half->full promotion of
      2026-07-20 lives ONLY in this artifact's size_map, so an older seed would
      silently re-size every Q3 setup at half. The notebook docstrings still say
      "Q3 -> half" and are wrong; the artifact is the source of truth.

  (b) OUTCOME, after the weekly finishes — the produced watchlist is read back
      and at least one row must carry a real size_bucket. If every row is
      'unscored' the run FAILS (exit 4) and alerts, and the watchlist path is
      NOT returned, so nothing downstream can ingest an unscored board.

An empty watchlist (zero rows) is NOT treated as an unscored failure — a session
with no qualifying setups is legitimate. It is reported, and the "is this enough
to trust?" decision belongs to the Phase 4 ingest floor guard, not here.

=============================================================================
VPS-ONLY SEED — NOT EXPECTED FROM GIT
=============================================================================

Git carries CODE only: these two notebooks, this script, tiingo_pull.py. Every
data artifact below is seeded once onto the VPS by hand and is gitignored. None
of it is expected to arrive from a `git pull`.

  <DATA_DIR>/<TICKER>.csv .................. ~1,890 files, ~500MB (Phase 1 corpus)
  <DATA_DIR>/SPY.csv ....................... freshness check
  <OUT_DIR>/handle_score_thresholds.json ... FROZEN seed — guard (a) above
  <OUT_DIR>/ticker_sectors.json ............ sector/tier/priority enrichment
                                             (take the results/ copy, 637KB —
                                             NOT the 38KB My-Drive-root one)
  <OUT_DIR>/cup_handle_fires.csv ........... historical fires cache (read-only)
  <OUT_DIR>/cup_handle_v2b_fires_with_clean_volume.csv ... Q5 staleness threshold
  <OUT_DIR>/cup_handle_live_fires.csv ...... durable fire log; seed to keep history
  <OUT_DIR>/cup_handle_v2b_exit_sweep/trades_t05.csv ..... provenance only, unused
                                             by the nightly path (needed only to
                                             re-run handle_score_freeze.ipynb)

Produced by each run, do NOT seed:
  <OUT_DIR>/cup_handle_active_setups.csv ... scanner -> weekly handoff
  <OUT_DIR>/cup_handle_t05_watchlist.csv ... the deliverable
  <OUT_DIR>/watchlist_archive/*.csv ........ one stamped copy per run

Executed notebooks are written to pipeline/_out/ (gitignored) — they are the run
log when something breaks at 19:00.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

# Reuse the Phase 1 alert sender + env loader verbatim. tiingo_pull.py is imported
# read-only and is NOT modified by this phase; it has no import-time side effects
# (constants and defs only, main() is behind __name__ == "__main__").
from pipeline.tiingo_pull import env, log, send_telegram  # noqa: E402

# ============================================================================
# Configuration
# ============================================================================

NOTEBOOK_DIR = REPO_ROOT / "notebooks"
SCANNER_NB = NOTEBOOK_DIR / "cup_handle_active_scanner.ipynb"
WEEKLY_NB = NOTEBOOK_DIR / "cup_handle_weekly.ipynb"

EXECUTED_DIR = REPO_ROOT / "pipeline" / "_out"

DEFAULT_DATA_DIR = REPO_ROOT / "data" / "corpus"

# Filesystem timestamp granularity + clock skew slack for the freshness checks.
MTIME_SLACK_SECONDS = 5.0

SETUPS_FILENAME = "cup_handle_active_setups.csv"
WATCHLIST_FILENAME = "cup_handle_t05_watchlist.csv"
THRESHOLDS_FILENAME = "handle_score_thresholds.json"

# A row counts as scored when size_bucket is one of these. 'unscored' is what
# score_and_size() stamps when the frozen thresholds could not be loaded.
REAL_BUCKETS = {"full", "half", "skip"}

# --- The frozen contract -----------------------------------------------------
# Pinned against the deployed artifact (handle_score_v1, built 2026-07-20 from
# 1,780 trades). These are not arbitrary: size_map is where the Q3 half->full
# promotion lives, and hscore_edges are the quintile boundaries the live scoring
# ranks against. If the strategy is ever deliberately re-frozen by re-running
# handle_score_freeze.ipynb, update these constants IN THE SAME COMMIT as the new
# artifact — that coupling is the point.
THRESHOLDS_CONTRACT: Dict[str, object] = {
    "version": "handle_score_v1",
    "features": ["days_since_handle_low", "handle_dur_days", "handle_depth_atr"],
    "feature_direction": "lower_is_better",
    "size_map": {"4": "full", "3": "full", "2": "full", "1": "skip", "0": "skip"},
    "n_edges": 6,
    "edge_first": 0.03595505617977527,
    "edge_last": 0.8895131086142322,
    "feature_hist_len": 1780,
}
EDGE_TOLERANCE = 1e-9


# ============================================================================
# Guard (a) — PRECONDITION: the frozen seed is present and is the right one
# ============================================================================

def validate_thresholds(out_dir: Path) -> Tuple[bool, str]:
    """Return (ok, detail). Runs BEFORE any notebook executes."""
    path = out_dir / THRESHOLDS_FILENAME

    if not path.is_file():
        return False, (
            f"{THRESHOLDS_FILENAME} not found at {path}. This is a frozen one-time "
            f"seed — copy it from Drive Bukowski/results/. Without it the notebook "
            f"would publish an UNSCORED watchlist without erroring."
        )

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return False, f"{THRESHOLDS_FILENAME} unreadable or not valid JSON: {exc}"

    if not isinstance(payload, dict):
        return False, f"{THRESHOLDS_FILENAME} is {type(payload).__name__}, expected an object"

    c = THRESHOLDS_CONTRACT

    if payload.get("version") != c["version"]:
        return False, f"version is {payload.get('version')!r}, expected {c['version']!r}"

    if payload.get("features") != c["features"]:
        return False, f"features are {payload.get('features')!r}, expected {c['features']!r}"

    if payload.get("feature_direction") != c["feature_direction"]:
        return False, (f"feature_direction is {payload.get('feature_direction')!r}, "
                       f"expected {c['feature_direction']!r}")

    size_map = payload.get("size_map")
    if size_map != c["size_map"]:
        # The single most valuable assertion here: a stale seed silently reverts
        # Q3 to half and nothing else in the stack would notice.
        return False, (f"size_map is {size_map!r}, expected {c['size_map']!r} "
                       f"(Q3 must be 'full' — promoted 2026-07-20)")

    edges = payload.get("hscore_edges")
    if not isinstance(edges, list) or len(edges) != c["n_edges"]:
        return False, (f"hscore_edges has {len(edges) if isinstance(edges, list) else '?'} "
                       f"entries, expected {c['n_edges']}")
    if any(not isinstance(e, (int, float)) or isinstance(e, bool) for e in edges):
        return False, "hscore_edges contains a non-numeric entry"
    if any(edges[i] >= edges[i + 1] for i in range(len(edges) - 1)):
        return False, f"hscore_edges are not strictly ascending: {edges}"
    if abs(float(edges[0]) - float(c["edge_first"])) > EDGE_TOLERANCE:
        return False, f"hscore_edges[0] is {edges[0]!r}, expected {c['edge_first']!r}"
    if abs(float(edges[-1]) - float(c["edge_last"])) > EDGE_TOLERANCE:
        return False, f"hscore_edges[-1] is {edges[-1]!r}, expected {c['edge_last']!r}"

    hist = payload.get("feature_hist")
    if not isinstance(hist, dict):
        return False, "feature_hist missing or not an object"
    for feat in c["features"]:  # type: ignore[union-attr]
        vals = hist.get(feat)
        if not isinstance(vals, list) or not vals:
            return False, f"feature_hist[{feat!r}] missing or empty"
        if len(vals) != c["feature_hist_len"]:
            return False, (f"feature_hist[{feat!r}] has {len(vals)} values, "
                           f"expected {c['feature_hist_len']}")

    built = payload.get("built_from") or {}
    return True, (f"{c['version']} · {built.get('n_trades', '?')} trades · "
                  f"PF {built.get('overall_pf', '?')} · Q3=full")


# ============================================================================
# Guard (b) — OUTCOME: scoring actually landed on the produced watchlist
# ============================================================================

def check_scoring_landed(watchlist: Path) -> Tuple[bool, str, Dict[str, int]]:
    """Read the watchlist back and confirm at least one setup carries a real bucket.

    Returns (ok, detail, counts). A ZERO-ROW watchlist is ok=True — a session with
    no qualifying setups is legitimate, and judging "enough setups" is the Phase 4
    ingest floor guard's job, not this one.
    """
    counts: Dict[str, int] = {}
    try:
        with watchlist.open("r", encoding="utf-8-sig", newline="") as fh:
            rows = list(csv.DictReader(fh))
    except OSError as exc:
        return False, f"could not read the produced watchlist: {exc}", counts

    if not rows:
        return True, "watchlist has 0 rows — no qualifying setups this session", counts

    fieldnames = [f.strip().lower() for f in (rows[0].keys() or [])]
    if "size_bucket" not in fieldnames:
        return False, (
            f"watchlist has {len(rows)} rows but NO size_bucket column — "
            f"score_and_size() did not run. Columns: {sorted(rows[0].keys())[:12]}"
        ), counts

    key = next(k for k in rows[0] if k.strip().lower() == "size_bucket")
    for row in rows:
        bucket = (row.get(key) or "").strip().lower() or "(blank)"
        counts[bucket] = counts.get(bucket, 0) + 1

    scored = sum(n for b, n in counts.items() if b in REAL_BUCKETS)
    if scored == 0:
        return False, (
            f"SCORING DID NOT LAND — all {len(rows)} setups came back without a real "
            f"size bucket ({counts}). The frozen thresholds were present but scoring "
            f"produced nothing usable; the board would have published with no sizing."
        ), counts

    return True, f"{scored}/{len(rows)} setups scored ({counts})", counts


# ============================================================================
# papermill
# ============================================================================

def execute_notebook(nb_in: Path, nb_out: Path, params: Dict[str, object]) -> None:
    """Run one notebook. Raises on any execution error."""
    try:
        import papermill as pm  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            f"papermill is not installed ({exc}). "
            f"py -m pip install -r pipeline/requirements.txt"
        ) from exc

    nb_out.parent.mkdir(parents=True, exist_ok=True)
    log(f"papermill: {nb_in.name} -> {nb_out.name}")
    for k, v in params.items():
        log(f"    {k} = {v!r}")

    kernel = env("JACK_PAPERMILL_KERNEL") or "python3"
    started = time.time()
    pm.execute_notebook(
        input_path=str(nb_in),
        output_path=str(nb_out),
        parameters=params,
        kernel_name=kernel,
        progress_bar=False,
        request_save_on_cell_execute=True,
    )
    log(f"    completed in {time.time() - started:.0f}s")


def require_fresh(path: Path, since: float, label: str) -> Tuple[bool, str]:
    """The file must exist AND have been written by the run we just did."""
    if not path.is_file():
        return False, f"{label} was not produced at {path}"
    mtime = path.stat().st_mtime
    if mtime < since - MTIME_SLACK_SECONDS:
        age = (since - mtime) / 60.0
        return False, (
            f"{label} exists but is STALE — last written {age:.1f} min before this "
            f"run started ({datetime.fromtimestamp(mtime):%Y-%m-%d %H:%M:%S}). The "
            f"notebook completed without rewriting it."
        )
    return True, f"{label} fresh ({path.stat().st_size:,} bytes)"


# ============================================================================
# Orchestration
# ============================================================================

def fail(code: int, headline: str, detail: str) -> int:
    log(f"FATAL: {headline} — {detail}")
    send_telegram(f"🛑 <b>{headline}</b>\n{detail}\n\n<i>Detector run aborted; the board was not updated.</i>")
    return code


def run(data_dir: Path, out_dir: Path, check_only: bool) -> int:
    log(f"corpus   : {data_dir}")
    log(f"results  : {out_dir}")

    if not data_dir.is_dir():
        return fail(2, "Detector ABORTED — corpus missing",
                    f"{data_dir} does not exist. See the VPS-ONLY SEED notes in run_detector.py.")
    if not out_dir.is_dir():
        return fail(2, "Detector ABORTED — results dir missing",
                    f"{out_dir} does not exist. Seed the frozen artifacts there first.")
    for nb in (SCANNER_NB, WEEKLY_NB):
        if not nb.is_file():
            return fail(2, "Detector ABORTED — notebook missing", f"{nb} not found in the repo.")

    # ---- GUARD (a): PRECONDITION ------------------------------------------
    ok, detail = validate_thresholds(out_dir)
    if not ok:
        return fail(2, "Detector ABORTED — frozen thresholds invalid", detail)
    log(f"thresholds OK: {detail}")

    if check_only:
        log("--check-only: preconditions pass, nothing executed.")
        return 0

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    params = {"DATA_DIR": str(data_dir), "OUT_DIR": str(out_dir)}
    setups_csv = out_dir / SETUPS_FILENAME
    watchlist_csv = out_dir / WATCHLIST_FILENAME

    # ---- 1/2: the detector -------------------------------------------------
    t_scanner = time.time()
    try:
        execute_notebook(SCANNER_NB, EXECUTED_DIR / f"scanner_{stamp}.ipynb", params)
    except Exception as exc:  # noqa: BLE001
        return fail(3, "Detector FAILED — scanner notebook raised",
                    f"{type(exc).__name__}: {str(exc)[:400]}\nSee pipeline/_out/scanner_{stamp}.ipynb")

    ok, detail = require_fresh(setups_csv, t_scanner, SETUPS_FILENAME)
    if not ok:
        return fail(5, "Detector FAILED — scanner produced no setups", detail)
    log(f"scanner OK: {detail}")

    # ---- 2/2: the weekly ---------------------------------------------------
    # SCANNER_ALREADY_RAN=True neuters the notebook's %run cell; the scanner has
    # already written the CSV that its Step 5 reads.
    t_weekly = time.time()
    try:
        execute_notebook(
            WEEKLY_NB,
            EXECUTED_DIR / f"weekly_{stamp}.ipynb",
            {**params, "SCANNER_ALREADY_RAN": True},
        )
    except Exception as exc:  # noqa: BLE001
        return fail(3, "Detector FAILED — weekly notebook raised",
                    f"{type(exc).__name__}: {str(exc)[:400]}\nSee pipeline/_out/weekly_{stamp}.ipynb")

    ok, detail = require_fresh(watchlist_csv, t_weekly, WATCHLIST_FILENAME)
    if not ok:
        return fail(5, "Detector FAILED — no watchlist produced", detail)
    log(f"weekly OK: {detail}")

    # ---- GUARD (b): OUTCOME ------------------------------------------------
    ok, detail, counts = check_scoring_landed(watchlist_csv)
    if not ok:
        return fail(4, "Detector FAILED — UNSCORED BOARD", detail)
    log(f"scoring OK: {detail}")

    total = sum(counts.values())
    log(f"WATCHLIST: {watchlist_csv}")
    send_telegram(
        f"🔎 <b>Detector run complete</b>\n"
        f"{total} setups · {detail}\n"
        f"{watchlist_csv.name}\n\n"
        f"<i>Board not updated yet — ingest is Phase 4.</i>"
    )
    # stdout contract for the Phase 7 orchestrator: last line is the watchlist path.
    print(str(watchlist_csv))
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="JACK Phase 2 — run the Cup-with-Handle detector headless via papermill."
    )
    parser.add_argument("--data-dir", type=Path, default=None,
                        help=f"Corpus directory (default: $JACK_CORPUS_DIR or {DEFAULT_DATA_DIR})")
    parser.add_argument("--out-dir", type=Path, default=None,
                        help="Results directory (default: <data-dir>/results)")
    parser.add_argument("--check-only", action="store_true",
                        help="Run the preconditions and exit. Executes no notebook.")
    args = parser.parse_args(argv)

    data_dir = (args.data_dir or Path(env("JACK_CORPUS_DIR") or DEFAULT_DATA_DIR)).expanduser().resolve()
    out_dir = (args.out_dir or (data_dir / "results")).expanduser().resolve()
    return run(data_dir, out_dir, args.check_only)


if __name__ == "__main__":
    sys.exit(main())
