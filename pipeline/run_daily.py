#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pipeline/run_daily.py — JACK daily pipeline, PHASE 7: the orchestrator.

Chains the proven stage scripts in order and STOPS at the first failure:

    calendar guard -> tiingo_pull.py -> run_detector.py (--check-only, then real)
                   -> ingest.py -> alert (STUB, Phase 5 fills it in)

    python pipeline/run_daily.py                  # the nightly run
    python pipeline/run_daily.py --skip-pull      # detect+ingest on the current corpus
    python pipeline/run_daily.py --dry-run        # plan only, nothing executed
    python pipeline/run_daily.py --selftest       # offline checks, no network, no subprocess

Every stage is invoked as a SUBPROCESS of the existing script. Nothing here
re-implements a pull, a detection, or an ingest — this file is control flow,
logging, and the exit-code contract, and nothing else.

=============================================================================
EXIT CODES — the tens digit names the stage that failed
=============================================================================
     0  success (a weekend/holiday no-op is also 0 — see WHY below)
     1  orchestrator itself failed (bad args, unexpected exception)

    20  PULL failed, unclassified non-zero from tiingo_pull.py
    21  PULL could not start          (tiingo_pull exit 2)
    22  PULL network outage           (tiingo_pull exit 3)
    23  PULL HIT THE TIINGO TIER CAP / RATE LIMIT   <-- the loud one
    24  PULL failure rate above the floor (corpus too damaged to detect on)

    30  DETECT failed, unclassified non-zero from run_detector.py
    31  DETECT preconditions failed   (run_detector exit 2)
    32  DETECT notebook execution failed (run_detector exit 3)

    40  INGEST failed, unclassified non-zero from ingest.py
    41  INGEST no/empty watchlist     (ingest exit 2)
    42  INGEST could not reach JACK   (ingest exit 3)
    43  INGEST refused by the floor guard (ingest exit 4) — prior board preserved
    44  INGEST persistence unavailable (ingest exit 5) — pointed at Vercel
    45  INGEST wrote nothing / could not verify (ingest exit 6)

    50  ALERT failed (reserved for Phase 5; the stub cannot fail)

Task Scheduler surfaces this as "Last Run Result", so a glance at the task
history names the failing stage without opening a log.

WHY A WEEKEND IS EXIT 0
    The job fires 365 nights a year and ~250 of them are trading days. If every
    Saturday painted a red "last run result", the operator would learn to ignore
    red — which is the one thing that must never happen to this task. A skip is
    a correct outcome, so it exits 0 and says so in the log.

=============================================================================
THE TIER-CAP GUARD — why this file watches the pull's output
=============================================================================
tiingo_pull.py is deliberately tolerant: its own comment reads "ALWAYS PROCEED:
partial success is success. Exit 0 so the orchestrator continues to the
detector — the Phase 4 floor guard owns the 'is this enough data?' decision."
Its only non-zero exits are 2 (cannot start) and 3 (network gone).

That tolerance is right for one dead ticker. It is WRONG for a tier cap.

On a plan-limit breach Tiingo answers HTTP 200 with a prose body
("You have run over your 500 symbol look up limit..."). tiingo_pull's structural
content guard catches that correctly and refuses to write it — the corpus is
never poisoned, which is the important half. But every remaining ticker then
fails the same way, the run still exits 0, and the orchestrator would happily
detect on a corpus that stopped updating at ticker 500 of 1824.

That is the silent-wrong-board failure: a green run, a fresh-looking board, and
two thirds of it stale. So this file:

  1. STREAMS the pull's stdout and scans it live for cap/limit signatures.
     On CAP_HITS_TO_ABORT distinct hits it TERMINATES the pull immediately and
     exits 23. Killing it early also stops ~1300 doomed requests from burning
     the rest of the quota.
  2. Re-checks the failure ledger tiingo_pull writes
     (data/pipeline_state/pull_failures.csv) after the run, in case the cap
     arrived in a form the live scan missed.
  3. Enforces a failure-rate floor (--max-fail-pct, default 5%) so a corpus
     damaged some OTHER way also stops the chain.

Killing the pull mid-run is safe: the corpus is append-only per ticker, so a
partial pass leaves every written ticker valid and simply older than the rest.
tiingo_pull is incremental+backfill, so the next successful night self-heals the
gap rather than leaving a hole in the SMA/ATR windows.

NOTE ON COUPLING: (1) reads tiingo_pull's LOG TEXT, which is a softer contract
than an exit code. It is belt-and-braces with (2) and (3), both of which read
structured data. The clean long-term fix is for tiingo_pull.py to detect the cap
itself and exit non-zero; that is a change to a proven script and is left for a
separate, deliberate commit rather than folded into the orchestrator.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
import time
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
PIPELINE_DIR = REPO_ROOT / "pipeline"

# Import the proven helpers rather than re-deriving them. is_trading_day() is the
# SAME calendar guard tiingo_pull uses, so the orchestrator and the pull can never
# disagree about whether a day is a session.
sys.path.insert(0, str(PIPELINE_DIR))
try:
    from tiingo_pull import (  # type: ignore  # noqa: E402
        FAILURE_LEDGER,
        enable_utf8_stdio,
        env,
        is_trading_day,
        send_telegram,
    )
except Exception as exc:  # noqa: BLE001 — a broken import must not be a stack trace at 19:00
    print(f"FATAL: cannot import pipeline/tiingo_pull.py helpers: {exc}", file=sys.stderr)
    raise SystemExit(1) from exc

# Importing tiingo_pull already ran this, but call it explicitly so the guarantee
# is visible here and survives any future change to that module's import side
# effects. Windows cp1252 stdout is what it defends against — see the docstring.
enable_utf8_stdio()

# Handed to every child process. PYTHONUTF8 puts the child interpreter in UTF-8
# mode from startup, which covers output that never passes through our log() —
# papermill's progress and tracebacks above all. Without it a child writes cp1252
# bytes that this parent then decodes as UTF-8, producing the mojibake that made
# em-dashes render as replacement characters in earlier run logs.
CHILD_ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8:replace"}


# ============================================================================
# Exit codes
# ============================================================================

EXIT_OK = 0
EXIT_ORCHESTRATOR = 1

EXIT_PULL_GENERIC = 20
EXIT_PULL_CANNOT_START = 21
EXIT_PULL_NETWORK = 22
EXIT_PULL_TIER_CAP = 23
EXIT_PULL_TOO_MANY_FAILURES = 24

EXIT_DETECT_GENERIC = 30
EXIT_DETECT_PRECONDITION = 31
EXIT_DETECT_NOTEBOOK = 32

EXIT_INGEST_GENERIC = 40
EXIT_INGEST_NO_WATCHLIST = 41
EXIT_INGEST_UNREACHABLE = 42
EXIT_INGEST_FLOOR_GUARD = 43
EXIT_INGEST_NO_PERSISTENCE = 44
EXIT_INGEST_NOTHING_WRITTEN = 45

EXIT_ALERT_GENERIC = 50

# child exit code -> orchestrator exit code, per stage
PULL_CODE_MAP: Dict[int, int] = {2: EXIT_PULL_CANNOT_START, 3: EXIT_PULL_NETWORK}
DETECT_CODE_MAP: Dict[int, int] = {2: EXIT_DETECT_PRECONDITION, 3: EXIT_DETECT_NOTEBOOK}
INGEST_CODE_MAP: Dict[int, int] = {
    2: EXIT_INGEST_NO_WATCHLIST,
    3: EXIT_INGEST_UNREACHABLE,
    4: EXIT_INGEST_FLOOR_GUARD,
    5: EXIT_INGEST_NO_PERSISTENCE,
    6: EXIT_INGEST_NOTHING_WRITTEN,
}

EXIT_MEANING: Dict[int, str] = {
    EXIT_OK: "success",
    EXIT_ORCHESTRATOR: "orchestrator error",
    EXIT_PULL_GENERIC: "PULL failed (unclassified)",
    EXIT_PULL_CANNOT_START: "PULL could not start",
    EXIT_PULL_NETWORK: "PULL network outage",
    EXIT_PULL_TIER_CAP: "PULL hit the Tiingo tier cap / rate limit",
    EXIT_PULL_TOO_MANY_FAILURES: "PULL failure rate above the floor",
    EXIT_DETECT_GENERIC: "DETECT failed (unclassified)",
    EXIT_DETECT_PRECONDITION: "DETECT preconditions failed",
    EXIT_DETECT_NOTEBOOK: "DETECT notebook execution failed",
    EXIT_INGEST_GENERIC: "INGEST failed (unclassified)",
    EXIT_INGEST_NO_WATCHLIST: "INGEST no/empty watchlist",
    EXIT_INGEST_UNREACHABLE: "INGEST could not reach JACK",
    EXIT_INGEST_FLOOR_GUARD: "INGEST refused by the floor guard",
    EXIT_INGEST_NO_PERSISTENCE: "INGEST persistence unavailable",
    EXIT_INGEST_NOTHING_WRITTEN: "INGEST wrote nothing",
    EXIT_ALERT_GENERIC: "ALERT failed",
}


# ============================================================================
# Tier-cap detection
# ============================================================================

# Phrases Tiingo uses on a plan/rate breach, plus the shapes tiingo_pull's own
# guard reports them as. Deliberately specific: a bare "limit" or a bare "429"
# would false-positive on ordinary log text and abort a healthy run.
CAP_PATTERNS: Tuple[re.Pattern, ...] = (
    re.compile(r"HTTP\s*429", re.I),
    re.compile(r"too many requests", re.I),
    re.compile(r"run over your", re.I),
    re.compile(r"symbol look\s*up", re.I),
    re.compile(r"look\s*up limit", re.I),
    re.compile(r"rate[\s_-]?limit", re.I),
    re.compile(r"exceeded your (?:daily |hourly |monthly )?(?:limit|quota|allowance)", re.I),
    re.compile(r"upgrade your plan", re.I),
    re.compile(r"usage limit", re.I),
)

# One ticker returning something odd is not a cap. A real cap fails EVERY
# subsequent ticker, so distinct hits pile up within seconds.
CAP_HITS_TO_ABORT = 3

# "Done in 12.4 min: 1801 updated (5403 bars), 12 already current, 11 failed, ..."
DONE_LINE = re.compile(
    r"Done in [\d.]+ min:\s*(\d+)\s+updated.*?,\s*(\d+)\s+already current,\s*(\d+)\s+failed",
    re.I,
)
# "  1200/1824 · 1180 updated · 8 current · 12 failed (734s)"
PROGRESS_LINE = re.compile(r"^\s*(\d+)/(\d+)\s*·")


def cap_signature(line: str) -> Optional[str]:
    """Return the matched cap phrase, or None. Pure — unit-testable offline."""
    for pat in CAP_PATTERNS:
        m = pat.search(line)
        if m:
            return m.group(0)
    return None


class PullWatcher:
    """Live scanner over the pull's stdout.

    Counts distinct cap hits, tracks the ticker totals the pull reports, and
    tells the runner when to abort. Holds no I/O of its own so it can be driven
    line-by-line from a test.
    """

    def __init__(self, cap_hits_to_abort: int = CAP_HITS_TO_ABORT) -> None:
        self.cap_hits_to_abort = cap_hits_to_abort
        self.cap_hits: List[str] = []
        self.fail_lines = 0
        self.total_tickers: Optional[int] = None
        self.reported: Optional[Tuple[int, int, int]] = None  # updated, current, failed

    def feed(self, line: str) -> bool:
        """Consume one log line. Returns True when the pull should be aborted."""
        sig = cap_signature(line)
        if sig:
            self.cap_hits.append(sig)

        if re.search(r"^\s*FAIL\s|\sFAIL\s", line):
            self.fail_lines += 1

        m = PROGRESS_LINE.match(line)
        if m:
            self.total_tickers = int(m.group(2))

        m = DONE_LINE.search(line)
        if m:
            updated, current, failed = int(m.group(1)), int(m.group(2)), int(m.group(3))
            self.reported = (updated, current, failed)
            if self.total_tickers is None:
                self.total_tickers = updated + current + failed

        return len(self.cap_hits) >= self.cap_hits_to_abort

    def failure_pct(self) -> Optional[float]:
        """Observed failure rate, or None when the pull reported no totals."""
        if self.reported is not None:
            updated, current, failed = self.reported
            total = updated + current + failed
            return (failed / total * 100.0) if total else 0.0
        if self.total_tickers:
            return self.fail_lines / self.total_tickers * 100.0
        return None


def ledger_cap_hits(run_date: date) -> List[str]:
    """Scan tiingo_pull's failure ledger for cap signatures on this run date.

    Structured backstop to the live log scan: the ledger is CSV written by the
    pull itself (run_date, ticker, kind, reason), so this survives any change to
    the log wording.
    """
    hits: List[str] = []
    try:
        if not Path(FAILURE_LEDGER).is_file():
            return hits
        with open(FAILURE_LEDGER, "r", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                if (row.get("run_date") or "") != run_date.isoformat():
                    continue
                if (row.get("kind") or "").upper() != "FAIL":
                    continue
                sig = cap_signature(row.get("reason") or "")
                if sig:
                    hits.append(f"{row.get('ticker')}: {sig}")
    except Exception as exc:  # noqa: BLE001 — the ledger is a diagnostic, never fatal
        hits.append(f"(ledger unreadable: {type(exc).__name__}: {exc})")
    return hits


# ============================================================================
# Logging — file AND stdout, every line stamped
# ============================================================================

class Tee:
    """Timestamped logger writing to stdout and a run log simultaneously.

    A watched run shows live progress; an unattended run leaves the same record
    on disk. Both are flushed per line so a killed process still leaves the log
    up to the moment it died.
    """

    def __init__(self, log_path: Optional[Path]) -> None:
        self.log_path = log_path
        self._fh = None
        if log_path is not None:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            self._fh = open(log_path, "a", encoding="utf-8", errors="replace")

    def line(self, msg: str = "", stamp: bool = True) -> None:
        text = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}" if stamp else msg
        try:
            print(text, flush=True)
        except UnicodeEncodeError:
            # enable_utf8_stdio() should have made this unreachable; kept as the
            # last net so a log line can never fail a stage. The file still gets
            # the original text either way.
            enc = getattr(sys.stdout, "encoding", None) or "ascii"
            try:
                print(text.encode(enc, "replace").decode(enc, "replace"), flush=True)
            except Exception:  # noqa: BLE001
                pass
        except Exception:  # noqa: BLE001 — broken pipe must not kill the run
            pass
        if self._fh is not None:
            self._fh.write(text + "\n")
            self._fh.flush()

    def rule(self, title: str) -> None:
        self.line("")
        self.line("=" * 72, stamp=False)
        self.line(f"  {title}")
        self.line("=" * 72, stamp=False)

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None


# ============================================================================
# Stage runner
# ============================================================================

def run_stage(
    tee: Tee,
    name: str,
    argv: Sequence[str],
    code_map: Dict[int, int],
    generic_code: int,
    on_line: Optional[Callable[[str], bool]] = None,
    abort_code: Optional[int] = None,
    abort_reason: str = "",
) -> Tuple[int, List[str]]:
    """Run one stage as a subprocess, streaming its output through the tee.

    Returns (orchestrator_exit_code, captured_lines). 0 means the stage passed.

    on_line, when supplied, is called for every output line; returning True
    aborts the child immediately and yields abort_code.
    """
    cmd = [sys.executable, "-u", *argv]
    tee.line(f"$ {' '.join(str(c) for c in cmd)}")
    started = time.time()
    captured: List[str] = []

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=CHILD_ENV,
        )
    except OSError as exc:
        tee.line(f"{name}: could not launch: {type(exc).__name__}: {exc}")
        return generic_code, captured

    aborted = False
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip("\n")
        captured.append(line)
        tee.line(f"  | {line}", stamp=False)
        if on_line is not None and not aborted and on_line(line):
            aborted = True
            tee.line("")
            tee.line(f"!! {name}: {abort_reason}")
            tee.line(f"!! terminating {name} now — not spending the rest of the quota on it.")
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
            except Exception as exc:  # noqa: BLE001
                tee.line(f"!! could not terminate cleanly: {type(exc).__name__}: {exc}")
            break

    rc = proc.wait()
    elapsed = time.time() - started
    tee.line(f"{name}: child exit {rc} after {elapsed / 60:.1f} min")

    if aborted:
        return (abort_code if abort_code is not None else generic_code), captured
    if rc == 0:
        return EXIT_OK, captured
    return code_map.get(rc, generic_code), captured


# ============================================================================
# Stages
# ============================================================================

def stage_pull(tee: Tee, args, run_date: date) -> int:
    tee.rule("STAGE 1/4 — TIINGO PULL")

    if args.skip_pull:
        tee.line("--skip-pull: using the corpus as it stands. No requests made.")
        return EXIT_OK

    argv: List[str] = [str(PIPELINE_DIR / "tiingo_pull.py")]
    if args.data_dir:
        argv += ["--data-dir", str(args.data_dir)]
    if args.date:
        argv += ["--date", args.date]
    if args.dry_run:
        argv += ["--dry-run"]

    watcher = PullWatcher()
    tee.line(f"tier-cap guard ARMED: abort after {watcher.cap_hits_to_abort} distinct "
             f"cap/limit signatures; failure floor {args.max_fail_pct:.1f}%")

    code, _ = run_stage(
        tee, "PULL", argv,
        code_map=PULL_CODE_MAP,
        generic_code=EXIT_PULL_GENERIC,
        on_line=watcher.feed,
        abort_code=EXIT_PULL_TIER_CAP,
        abort_reason="TIINGO TIER CAP / RATE LIMIT DETECTED",
    )

    # --- report what the pull actually did ---------------------------------
    if watcher.reported is not None:
        updated, current, failed = watcher.reported
        tee.line(f"PULL summary: {updated} updated · {current} already current · {failed} failed")
    elif watcher.total_tickers:
        tee.line(f"PULL summary: {watcher.fail_lines} FAIL lines over "
                 f"~{watcher.total_tickers} tickers (no completion line seen)")
    else:
        tee.line("PULL summary: the pull reported no totals.")

    if watcher.cap_hits:
        tee.line(f"CAP SIGNATURES SEEN ({len(watcher.cap_hits)}): "
                 f"{', '.join(sorted(set(watcher.cap_hits))[:5])}")

    if code == EXIT_PULL_TIER_CAP:
        tee.line("")
        tee.line("TIER CAP: the pull was stopped mid-run. The corpus is PARTIALLY updated —")
        tee.line("every written ticker is valid, the rest are simply older. tiingo_pull is")
        tee.line("incremental+backfill, so the next good night self-heals the gap.")
        tee.line("NOT proceeding to the detector: a half-updated corpus makes a wrong board.")
        _notify(tee, "TIINGO TIER CAP — pull stopped, board NOT updated",
                f"Cap signatures: {', '.join(sorted(set(watcher.cap_hits))[:3])}")
        return code

    if code != EXIT_OK:
        _notify(tee, f"PULL failed ({EXIT_MEANING.get(code, code)})", "Board NOT updated.")
        return code

    if args.dry_run:
        tee.line("--dry-run: skipping the post-pull ledger and failure-rate checks.")
        return EXIT_OK

    # --- structured backstop: the ledger the pull wrote ---------------------
    led = ledger_cap_hits(run_date)
    if led:
        tee.line("")
        tee.line(f"LEDGER CAP HITS ({len(led)}) — the live scan did not abort, but the")
        tee.line("failure ledger carries cap signatures for this run date:")
        for row in led[:10]:
            tee.line(f"    {row}")
        tee.line("Treating as a tier cap. NOT proceeding to the detector.")
        _notify(tee, "TIINGO TIER CAP (from the failure ledger) — board NOT updated",
                f"{len(led)} capped tickers on {run_date.isoformat()}")
        return EXIT_PULL_TIER_CAP

    # --- failure-rate floor -------------------------------------------------
    pct = watcher.failure_pct()
    if pct is None:
        tee.line("WARNING: no totals parsed from the pull, so the failure-rate floor "
                 "could not be evaluated. Proceeding on the pull's own exit 0.")
    elif pct > args.max_fail_pct:
        tee.line("")
        tee.line(f"FAILURE FLOOR BREACHED: {pct:.1f}% of tickers failed "
                 f"(limit {args.max_fail_pct:.1f}%).")
        tee.line("The corpus is too damaged to detect on. NOT proceeding.")
        _notify(tee, f"PULL failure rate {pct:.1f}% — board NOT updated",
                f"Above the {args.max_fail_pct:.1f}% floor.")
        return EXIT_PULL_TOO_MANY_FAILURES
    else:
        tee.line(f"failure rate {pct:.1f}% — within the {args.max_fail_pct:.1f}% floor.")

    return EXIT_OK


def stage_detect(tee: Tee, args) -> Tuple[int, Optional[Path]]:
    tee.rule("STAGE 2/4 — DETECTOR")

    base: List[str] = [str(PIPELINE_DIR / "run_detector.py")]
    if args.data_dir:
        base += ["--data-dir", str(args.data_dir)]
    if args.out_dir:
        base += ["--out-dir", str(args.out_dir)]

    # --check-only first. Its preconditions (SPY.csv, frozen thresholds, notebooks)
    # are cheap to verify and expensive to discover two minutes into a papermill run.
    tee.line("preflight: --check-only")
    code, _ = run_stage(tee, "DETECT(check)", base + ["--check-only"],
                        code_map=DETECT_CODE_MAP, generic_code=EXIT_DETECT_GENERIC)
    if code != EXIT_OK:
        tee.line("preconditions failed — not executing the notebooks.")
        _notify(tee, f"DETECT preflight failed ({EXIT_MEANING.get(code, code)})",
                "Board NOT updated.")
        return code, None

    if args.dry_run:
        tee.line("--dry-run: preconditions pass; stopping before the real detector run.")
        return EXIT_OK, None

    tee.line("preconditions pass — running the detector for real.")
    code, lines = run_stage(tee, "DETECT", base,
                            code_map=DETECT_CODE_MAP, generic_code=EXIT_DETECT_GENERIC)
    if code != EXIT_OK:
        _notify(tee, f"DETECT failed ({EXIT_MEANING.get(code, code)})", "Board NOT updated.")
        return code, None

    # run_detector's stdout contract: the LAST line is the watchlist path.
    watchlist: Optional[Path] = None
    for line in reversed(lines):
        cand = line.strip()
        if cand.lower().endswith(".csv"):
            watchlist = Path(cand)
            break

    if watchlist is None:
        tee.line("DETECT exited 0 but printed no watchlist path on its last line.")
        _notify(tee, "DETECT produced no watchlist path", "Board NOT updated.")
        return EXIT_DETECT_GENERIC, None

    tee.line(f"watchlist: {watchlist}")
    return EXIT_OK, watchlist


def stage_ingest(tee: Tee, args, watchlist: Optional[Path]) -> Tuple[int, List[str]]:
    tee.rule("STAGE 3/4 — INGEST")

    if args.dry_run:
        tee.line("--dry-run: nothing to ingest (the detector did not run).")
        return EXIT_OK, []

    if watchlist is None:
        tee.line("no watchlist from the detector — cannot ingest.")
        return EXIT_INGEST_NO_WATCHLIST, []

    argv: List[str] = [str(PIPELINE_DIR / "ingest.py"), "--watchlist", str(watchlist)]
    if args.no_floor_guard:
        argv += ["--no-floor-guard"]
        tee.line("WARNING: --no-floor-guard — the 50% board-shrink guard is DISABLED.")

    code, lines = run_stage(tee, "INGEST", argv,
                            code_map=INGEST_CODE_MAP, generic_code=EXIT_INGEST_GENERIC)
    if code == EXIT_INGEST_FLOOR_GUARD:
        tee.line("floor guard REFUSED the ingest — the prior board is intact and "
                 "nothing was retired. This is the guard working, not a crash.")
    if code != EXIT_OK:
        _notify(tee, f"INGEST failed ({EXIT_MEANING.get(code, code)})", "Board NOT updated.")
    return code, lines


def stage_alert(tee: Tee, args, ingest_lines: Sequence[str]) -> int:
    """PHASE 5 — one Telegram alert describing what actually landed on the board.

    Reached ONLY after a successful ingest (the chain is fail-fast and every
    earlier stage returns before here), so this can never fire "here are your
    fires" on a run that failed. Failure alerting stays with _notify and with
    ingest.py's own floor-guard message.

    Never returns non-zero. The board is already written by this point; an
    alerting problem must not turn a good night into a red Last Run Result.
    """
    tee.rule("STAGE 4/4 — ALERT")
    try:
        return _alert_body(tee, args, ingest_lines)
    except Exception as exc:  # noqa: BLE001
        # The board IS written. An alerting bug must never redden a good night,
        # so this is logged and swallowed rather than raised into main().
        import traceback
        tee.line("ALERT ERROR (board is still updated): {}: {}".format(
            type(exc).__name__, exc))
        for row_ in traceback.format_exc().splitlines():
            tee.line("  | " + row_, stamp=False)
        return EXIT_OK


def _alert_body(tee: Tee, args, ingest_lines: Sequence[str]) -> int:
    if args.dry_run:
        tee.line("--dry-run: no ingest ran, so there is no board to report.")
        return EXIT_OK

    expected_run = parse_ingest_run_id(ingest_lines)
    tee.line("ingest reported run #{}".format(
        expected_run if expected_run is not None else "?"))

    base = board_base_url()
    tee.line("reading the persisted board: {}/api/jack-board".format(base))
    payload, err = fetch_board(base)

    if payload is None:
        # The board IS written — only the read-back failed. Say exactly that, so
        # this is not mistaken for a failed ingest.
        tee.line("could not read the board back: {}".format(err))
        _notify(tee, "board written, but the alert could not read it back",
                "{}\nThe ingest SUCCEEDED — check the board in the terminal.".format(err))
        return EXIT_OK

    run_id = payload.get("runId")
    decisions = payload.get("decisions") or []

    note = ""
    if payload.get("error"):
        note = "board read reported: {}".format(payload["error"])
    if expected_run is not None and run_id is not None and int(run_id) != int(expected_run):
        # Reading a different run than the one just written means the alert would
        # describe the wrong night. Report it rather than dress it up as tonight's.
        note = ("board shows run #{} but ingest wrote run #{} — this alert may be "
                "describing an older run".format(run_id, expected_run))
        tee.line("RUN MISMATCH: {}".format(note))

    summary = summarize_board(decisions)
    tee.line("board run #{}: {} rows · FRESH {} · AGING {} · watching {} · UNREVIEWED {}".format(
        run_id, len(decisions), len(summary["fresh"]), len(summary["aging"]),
        summary["pending"], summary["unreviewed"]))

    body = format_fire_alert(summary, run_id, note)

    for line in body.split(NL):
        tee.line("  > " + line, stamp=False)

    if args.no_alert:
        tee.line("--no-alert: rendered above, not sent.")
        return EXIT_OK

    try:
        sent = send_telegram(body)
        tee.line("telegram: {}".format(
            "sent" if sent else "NOT sent (unconfigured or failed) — the board is "
                               "still updated; the alert is what did not go out"))
    except Exception as exc:  # noqa: BLE001 — alerting must never fail the run
        tee.line("telegram: error, ignored — {}: {}".format(type(exc).__name__, exc))

    return EXIT_OK


# ============================================================================
# PHASE 5 — the fire alert
#
# Reads the ACTUALLY-PERSISTED board and summarises the night in one message.
#
# WHY IT READS THE BOARD BACK INSTEAD OF TRUSTING THE INGEST RESPONSE
#   ingest.py's `filterStats` (live N / pending M) is computed at applyFilters,
#   BEFORE persistRun, and persistRun is deliberately non-fatal. Those counts
#   therefore describe what PASSED THE FILTERS, not what reached jack.db.
#   Alerting off them would be the same class of lie this pipeline keeps
#   removing. GET /api/jack-board serves getCurrentBoard() — the rows that
#   actually landed — so that is the source of truth here.
#
#   The board's runId is cross-checked against the run ingest reported writing.
#   A mismatch means we are reading a different (stale) run, and the alert says
#   so rather than presenting an older night's setups as tonight's.
#
# SPLIT BY entry_status, because that IS the actionable distinction:
#   FRESH   -> confirmed on the most recent close; take the next open (2.24 book)
#   AGING   -> still inside the window but the modeled open has passed;
#              pullback-to-entry only (1.83 book). Listed, labelled do-not-chase.
#   PENDING -> counted, never listed. Nothing to do tonight.
#   UNKNOWN -> counted with PENDING; the alert makes no claim either way.
#
# UNREVIEWED is a DIFFERENT AXIS: it is the LLM verdict, not the entry window. A
# row can be FRESH and UNREVIEWED at once. It is surfaced so a missing verdict
# reads as "not analysed yet" and never as "no signal".
#
# WHAT THIS STAGE DELIBERATELY DOES NOT DO
#   It does not alert on a failed run. The orchestrator's _notify already fires
#   on every stage failure, and ingest.py sends its own message on a floor-guard
#   refusal. Firing "here are your fires" after a failure would be actively
#   misleading, so the alert is reached only after a confirmed successful ingest.
# ============================================================================

# Mirrors ingest.py's resolution so the alert reads the same app the ingest wrote.
DEFAULT_BASE_URL = "http://localhost:3000"
BOARD_TIMEOUT = 30

NL = "\n"
RUN_ID_RE = r"WROTE run #(\d+)"

# Telegram hard-caps a message at 4096 characters. FRESH is the actionable list
# and is capped generously; AGING is reference and is capped tighter. Anything
# dropped is always still COUNTED, so the message can never imply a shorter
# night than actually happened.
MAX_FRESH_LISTED = 25
MAX_AGING_LISTED = 12
MAX_MESSAGE_CHARS = 3900


def board_base_url() -> str:
    return (env("JACK_SELF_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def fetch_board(base_url: str) -> Tuple[Optional[dict], str]:
    """GET /api/jack-board. Returns (payload, "") or (None, reason)."""
    url = base_url + "/api/jack-board"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=BOARD_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return None, "HTTP {} from {}".format(exc.code, url)
    except Exception as exc:  # noqa: BLE001
        return None, "{}: {} (is the app running at {}?)".format(
            type(exc).__name__, exc, base_url)
    try:
        return json.loads(raw), ""
    except (ValueError, TypeError):
        return None, "response was not JSON: {!r}".format(raw[:160])


def _num(val, digits: int = 2) -> str:
    if val is None:
        return "-"
    try:
        return format(float(val), "." + str(digits) + "f")
    except (TypeError, ValueError):
        return "-"


def summarize_board(decisions: Sequence[dict]) -> dict:
    """Split the persisted board into the alert's buckets. Pure — unit-testable."""
    fresh: List[dict] = []
    aging: List[dict] = []
    pending = 0
    unreviewed = 0

    for d in decisions or []:
        status = str(d.get("entryStatus") or "UNKNOWN").upper()
        if str(d.get("decision") or "").strip().upper() == "UNREVIEWED":
            unreviewed += 1
        if status == "FRESH":
            fresh.append(d)
        elif status == "AGING":
            aging.append(d)
        else:
            pending += 1

    # Highest P-rank first, then the stronger handle — the board's own order, so
    # the alert's top name is the board's top name rather than a second opinion.
    def rank(d: dict):
        return (-(d.get("priority") or 0), -(d.get("handleScore") or 0), d.get("ticker") or "")

    fresh.sort(key=rank)
    aging.sort(key=rank)
    return {"fresh": fresh, "aging": aging, "pending": pending, "unreviewed": unreviewed}


def _fire_line(d: dict) -> str:
    tier = str(d.get("tier") or "?").upper()
    bucket = str(d.get("sizeBucket") or "?").upper()
    hs = d.get("handleScore")
    hs_txt = " · hs " + format(float(hs), ".2f") if isinstance(hs, (int, float)) else ""
    return (
        "• <b>" + str(d.get("ticker") or "?") + "</b> " + tier + " · " + bucket + hs_txt
        + NL
        + "   entry " + _num(d.get("entry"))
        + " · stop " + _num(d.get("stop"))
        + " · t05 " + _num(d.get("target"))
    )


def format_fire_alert(summary: dict, run_id, run_note: str = "") -> str:
    """Build the Telegram HTML body. Pure, so every state is testable offline."""
    fresh, aging = summary["fresh"], summary["aging"]
    pending, unreviewed = summary["pending"], summary["unreviewed"]
    head_run = "run #" + str(run_id) if run_id is not None else "run #?"

    parts: List[str] = []

    if not fresh and not aging:
        # QUIET NIGHT. This still sends: silence must never be indistinguishable
        # from a dead pipeline. "No fires" is a result, not the absence of one.
        parts.append("🌙 <b>JACK nightly — no new fires</b>")
        parts.append(head_run + " · board updated · " + str(pending) + " watching")
    else:
        parts.append("🎯 <b>JACK nightly — " + str(len(fresh)) + " FRESH · "
                     + str(len(aging)) + " AGING</b>")
        parts.append(head_run + " · " + str(pending) + " watching")

    if run_note:
        parts.append("⚠ " + run_note)

    if fresh:
        parts.append("")
        parts.append("<b>FRESH — take the next open</b> <i>(2.24 book)</i>")
        for d in fresh[:MAX_FRESH_LISTED]:
            parts.append(_fire_line(d))
        if len(fresh) > MAX_FRESH_LISTED:
            parts.append("   …+" + str(len(fresh) - MAX_FRESH_LISTED) + " more FRESH")

    if aging:
        parts.append("")
        parts.append("<b>AGING — pullback to entry ONLY</b> <i>(1.83 book)</i>")
        parts.append("<i>do not chase at market</i>")
        for d in aging[:MAX_AGING_LISTED]:
            parts.append(_fire_line(d))
        if len(aging) > MAX_AGING_LISTED:
            parts.append("   …+" + str(len(aging) - MAX_AGING_LISTED) + " more AGING")

    if unreviewed:
        parts.append("")
        parts.append("⚠️ <b>" + str(unreviewed) + " row(s) UNREVIEWED</b> — verdicts "
                     "pending, the analysis was unavailable. NOT a SKIP: these were "
                     "never graded.")

    body = NL.join(parts)
    if len(body) > MAX_MESSAGE_CHARS:
        body = body[:MAX_MESSAGE_CHARS] + NL + "…truncated (Telegram limit)."
    return body


def parse_ingest_run_id(lines: Sequence[str]) -> Optional[int]:
    """Pull the run number out of ingest.py's 'WROTE run #N ...' success line."""
    for line in reversed(list(lines or [])):
        m = re.search(RUN_ID_RE, line)
        if m:
            return int(m.group(1))
    return None



def _notify(tee: Tee, headline: str, detail: str) -> None:
    """Best-effort Telegram. A notification problem must never change the exit code."""
    try:
        ok = send_telegram(f"🛑 <b>JACK nightly: {headline}</b>\n{detail}")
        tee.line(f"telegram: {'sent' if ok else 'not sent (unconfigured or failed)'}")
    except Exception as exc:  # noqa: BLE001
        tee.line(f"telegram: error, ignored — {type(exc).__name__}: {exc}")


# ============================================================================
# Selftest — offline, no network, no subprocess
# ============================================================================

def selftest() -> int:
    passed = failed = 0

    def check(label: str, cond: bool, detail: str = "") -> None:
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"  OK   {label}")
        else:
            failed += 1
            print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))

    print("\n[1] cap signatures are recognised")
    for sample in (
        "  FAIL AAPL: non-price body (string): 'You have run over your 500 symbol look up limit'",
        "  FAIL MSFT: HTTP 429: Too Many Requests",
        "  FAIL NVDA: non-price body (object): 'You have exceeded your daily limit'",
        "  FAIL TSLA: rate limit reached",
        "  FAIL AMD: please upgrade your plan to continue",
    ):
        check(f"detects: {sample[:52]}...", cap_signature(sample) is not None)

    print("\n[2] ordinary failures do NOT trip the guard")
    for sample in (
        "  FAIL ZZZZ: HTTP 404: Not found",
        "  FAIL YYYY: HTTP 403: not entitled",
        "  FAIL XXXX: connection: TimeoutError: timed out",
        "  1200/1824 · 1180 updated · 8 current · 12 failed (734s)",
        "Done in 30.4 min: 1801 updated (5403 bars), 12 already current, 11 failed, 0 splits.",
        "  FAIL WWWW: bar 3 missing keys: ['close']",
    ):
        check(f"ignores: {sample[:52]}...", cap_signature(sample) is None, str(cap_signature(sample)))

    print("\n[3] watcher aborts only after enough distinct hits")
    w = PullWatcher()
    check("one hit does not abort", w.feed("FAIL A: HTTP 429") is False)
    check("two hits do not abort", w.feed("FAIL B: HTTP 429") is False)
    check("three hits abort", w.feed("FAIL C: HTTP 429") is True)
    check("  and the hits are recorded", len(w.cap_hits) == 3, str(w.cap_hits))

    w2 = PullWatcher()
    for line in ("FAIL A: HTTP 404", "FAIL B: connection: timeout", "FAIL C: HTTP 403"):
        check(f"healthy failure does not abort ({line[:24]})", w2.feed(line) is False)
    check("  no cap hits recorded", w2.cap_hits == [])

    print("\n[4] totals and failure rate are parsed")
    w3 = PullWatcher()
    w3.feed("  1200/1824 · 1180 updated · 8 current · 12 failed (734s)")
    check("total tickers from the progress line", w3.total_tickers == 1824, str(w3.total_tickers))
    w3.feed("Done in 30.4 min: 1801 updated (5403 bars), 12 already current, 11 failed, 0 splits.")
    check("completion line parsed", w3.reported == (1801, 12, 11), str(w3.reported))
    pct = w3.failure_pct()
    check("failure rate ~0.6%", pct is not None and abs(pct - (11 / 1824 * 100)) < 0.05, str(pct))

    w4 = PullWatcher()
    w4.feed("Done in 9.1 min: 500 updated (1500 bars), 0 already current, 1324 failed, 0 splits.")
    pct4 = w4.failure_pct()
    check("a capped-shaped run reads as ~72.6% failed",
          pct4 is not None and pct4 > 70, str(pct4))

    w5 = PullWatcher()
    check("no totals -> failure_pct is None", w5.failure_pct() is None)

    print("\n[5] exit-code map is complete and unambiguous")
    codes = [
        EXIT_OK, EXIT_ORCHESTRATOR,
        EXIT_PULL_GENERIC, EXIT_PULL_CANNOT_START, EXIT_PULL_NETWORK,
        EXIT_PULL_TIER_CAP, EXIT_PULL_TOO_MANY_FAILURES,
        EXIT_DETECT_GENERIC, EXIT_DETECT_PRECONDITION, EXIT_DETECT_NOTEBOOK,
        EXIT_INGEST_GENERIC, EXIT_INGEST_NO_WATCHLIST, EXIT_INGEST_UNREACHABLE,
        EXIT_INGEST_FLOOR_GUARD, EXIT_INGEST_NO_PERSISTENCE, EXIT_INGEST_NOTHING_WRITTEN,
        EXIT_ALERT_GENERIC,
    ]
    check("every code is distinct", len(codes) == len(set(codes)))
    check("every code has a meaning", all(c in EXIT_MEANING for c in codes))
    check("pull codes are the 20s", all(20 <= c < 30 for c in
          (EXIT_PULL_GENERIC, EXIT_PULL_CANNOT_START, EXIT_PULL_NETWORK,
           EXIT_PULL_TIER_CAP, EXIT_PULL_TOO_MANY_FAILURES)))
    check("detect codes are the 30s", all(30 <= c < 40 for c in
          (EXIT_DETECT_GENERIC, EXIT_DETECT_PRECONDITION, EXIT_DETECT_NOTEBOOK)))
    check("ingest codes are the 40s", all(40 <= c < 50 for c in
          (EXIT_INGEST_GENERIC, EXIT_INGEST_NO_WATCHLIST, EXIT_INGEST_UNREACHABLE,
           EXIT_INGEST_FLOOR_GUARD, EXIT_INGEST_NO_PERSISTENCE, EXIT_INGEST_NOTHING_WRITTEN)))
    check("child->orchestrator maps stay in their stage band",
          all(20 <= v < 30 for v in PULL_CODE_MAP.values())
          and all(30 <= v < 40 for v in DETECT_CODE_MAP.values())
          and all(40 <= v < 50 for v in INGEST_CODE_MAP.values()))
    check("ingest floor-guard refusal maps to 43", INGEST_CODE_MAP[4] == EXIT_INGEST_FLOOR_GUARD)

    print("\n[6] the stage scripts this orchestrator drives exist")
    for script in ("tiingo_pull.py", "run_detector.py", "ingest.py"):
        check(f"{script} present", (PIPELINE_DIR / script).is_file())

    print("\n[7] logging survives a cp1252 stdout (the 2026-08-24 crash)")
    # Regression test for the UnicodeEncodeError that killed an otherwise-perfect
    # run: the detector had scored 76/76 setups and stamped entry_status, then a
    # final log line carrying U+26A0 met cp1252 stdout and raised, failing the
    # stage. This spawns a CHILD with a hostile encoding on purpose - by the time
    # the selftest runs, this process's stdout is already UTF-8 and would prove
    # nothing. PYTHONUTF8 is stripped so the IN-CODE fix has to stand on its own,
    # without help from run_daily.cmd.
    killers = "warn ⚠ arrow → stop \U0001F6D1 ok ✅ clip \U0001F4CB"
    child = (
        "import sys; sys.path.insert(0, r'" + str(PIPELINE_DIR) + "');"
        "from tiingo_pull import log;"
        "log(" + repr(killers) + ");"
        "print('SURVIVED')"
    )
    hostile = {**os.environ, "PYTHONIOENCODING": "cp1252"}
    hostile.pop("PYTHONUTF8", None)
    try:
        proc = subprocess.run(
            [sys.executable, "-c", child],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=hostile, timeout=60,
        )
        check("log() does not raise under cp1252 stdout", proc.returncode == 0,
              (proc.stderr or "").strip()[-160:])
        check("  and the line still reaches stdout", "SURVIVED" in (proc.stdout or ""))
        check("  with the characters intact, not dropped",
              "⚠" in (proc.stdout or "") and "→" in (proc.stdout or ""),
              (proc.stdout or "").strip()[:120])
    except Exception as exc:  # noqa: BLE001
        check("cp1252 child ran", False, f"{type(exc).__name__}: {exc}")

    print("\n[8] which characters depend on the UTF-8 guarantee")
    # Every stage script logs through tiingo_pull.log, so UTF-8 stdout covers them
    # all. This records WHICH characters rely on it, so a future reader knows the
    # guarantee is load-bearing rather than decorative.
    for name in ("tiingo_pull.py", "run_detector.py", "ingest.py", "run_daily.py"):
        path = PIPELINE_DIR / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        risky = sorted({c for c in set(text) if ord(c) > 127 and not _cp1252_ok(c)})
        check(f"{name}: {len(risky)} char(s) need UTF-8 stdout", True,
              "".join(f"U+{ord(c):04X} " for c in risky) or "none")

    print("\n[9] Phase 5 alert — board summarising and every alert state")

    def row(tkr, status, tier="Q5", bucket="full", hs=0.71, entry=41.2, stop=37.9,
            tgt=45.6, prio=9.0, decision="TAKE"):
        return {"ticker": tkr, "entryStatus": status, "tier": tier, "sizeBucket": bucket,
                "handleScore": hs, "entry": entry, "stop": stop, "target": tgt,
                "priority": prio, "decision": decision}

    board = (
        [row("AAAA", "FRESH", prio=9.5), row("BBBB", "FRESH", tier="Q4", hs=0.58, prio=8.1),
         row("CCCC", "FRESH", tier="Q3", hs=0.49, prio=7.0)]
        + [row(f"AG{i:02d}", "AGING", tier="Q4", hs=0.55, prio=6.0 - i * 0.1) for i in range(29)]
        + [row(f"PD{i:02d}", "PENDING") for i in range(44)]
    )
    s = summarize_board(board)
    check("FRESH split", len(s["fresh"]) == 3, str(len(s["fresh"])))
    check("AGING split", len(s["aging"]) == 29, str(len(s["aging"])))
    check("PENDING counted, not listed", s["pending"] == 44, str(s["pending"]))
    check("no UNREVIEWED here", s["unreviewed"] == 0)
    check("FRESH ordered by P-rank", [d["ticker"] for d in s["fresh"]] == ["AAAA", "BBBB", "CCCC"],
          str([d["ticker"] for d in s["fresh"]]))

    normal = format_fire_alert(s, 412)
    check("normal: headline counts", "3 FRESH · 29 AGING" in normal)
    check("normal: run id", "run #412" in normal)
    check("normal: pending counted", "44 watching" in normal)
    check("normal: FRESH labelled with the 2.24 book", "2.24 book" in normal)
    check("normal: AGING labelled pullback-only", "pullback to entry ONLY" in normal)
    check("normal: AGING carries the do-not-chase warning", "do not chase at market" in normal)
    check("normal: geometry on a fire line", "entry 41.20" in normal and "stop 37.90" in normal
          and "t05 45.60" in normal)
    check("normal: AGING truncated with a count", "more AGING" in normal, normal[-80:])
    check("normal: nothing dropped silently — 29 still in the headline",
          "29 AGING" in normal)
    check("normal: inside Telegram's 4096 limit", len(normal) < 4096, str(len(normal)))

    quiet = format_fire_alert(summarize_board([row(f"PD{i}", "PENDING") for i in range(42)]), 413)
    check("quiet: still sends something", bool(quiet.strip()))
    check("quiet: says no new fires", "no new fires" in quiet)
    check("quiet: still reports the watch count", "42 watching" in quiet)
    check("quiet: no FRESH/AGING sections", "2.24 book" not in quiet and "1.83 book" not in quiet)

    unrev = format_fire_alert(
        summarize_board([row("AAAA", "FRESH", decision="UNREVIEWED"),
                         row("BBBB", "FRESH", decision="TAKE"),
                         row("PD01", "PENDING", decision="UNREVIEWED")]), 414)
    check("unreviewed: counted across statuses", "2 row(s) UNREVIEWED" in unrev, unrev[-160:])
    check("unreviewed: framed as not-yet-graded, not as a skip", "NOT a SKIP" in unrev)
    check("unreviewed: the FRESH list is still shown", "2.24 book" in unrev)

    mismatch = format_fire_alert(s, 999, "board shows run #999 but ingest wrote run #412")
    check("run mismatch surfaces in the message", "ingest wrote run #412" in mismatch)

    big = summarize_board([row(f"F{i:03d}", "FRESH", prio=100 - i) for i in range(60)])
    huge = format_fire_alert(big, 415)
    check("60 FRESH: list capped", "more FRESH" in huge)
    check("  but the true count is in the headline", "60 FRESH" in huge)
    check("  and it still fits Telegram", len(huge) < 4096, str(len(huge)))

    check("run id parsed from ingest stdout",
          parse_ingest_run_id(["noise", "WROTE run #412 in 8s: 76 setups · 76 decisions"]) == 412)
    check("  no run line -> None", parse_ingest_run_id(["nothing here"]) is None)
    check("  last run line wins", parse_ingest_run_id(["WROTE run #1 x", "WROTE run #2 y"]) == 2)

    check("UNKNOWN entry_status counts as watching, never as a fire",
          summarize_board([row("XX", "UNKNOWN")])["pending"] == 1)
    check("missing entry_status counts as watching",
          summarize_board([{"ticker": "YY"}])["pending"] == 1)

    if os.environ.get("JACK_SHOW_ALERTS"):
        for title, msg in (("NORMAL (FRESH + AGING)", normal), ("QUIET NIGHT", quiet),
                           ("UNREVIEWED", unrev), ("RUN MISMATCH", mismatch)):
            print("\n----- SAMPLE: " + title + " -----")
            print(msg)
            print("----- end (" + str(len(msg)) + " chars) -----")

    print(f"\n{'ALL PASS' if failed == 0 else 'FAILURES'} — {passed} passed, {failed} failed\n")
    return 0 if failed == 0 else 1


def _cp1252_ok(ch: str) -> bool:
    """Is this character representable in the Windows ANSI code page?"""
    try:
        ch.encode("cp1252")
        return True
    except UnicodeEncodeError:
        return False


# ============================================================================
# Entry point
# ============================================================================

def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="JACK Phase 7 — nightly orchestrator: pull -> detect -> ingest -> alert.",
    )
    parser.add_argument("--skip-pull", action="store_true",
                        help="Skip the Tiingo pull and run detect+ingest on the corpus as it "
                             "stands. For testing without spending quota.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Plan only: pull --dry-run, detector --check-only, no ingest.")
    parser.add_argument("--force", action="store_true",
                        help="Run even when the calendar guard says it is not a trading day.")
    parser.add_argument("--date", type=str, default=None,
                        help="Run date YYYY-MM-DD (default: today). Passed to the pull.")
    parser.add_argument("--data-dir", type=Path, default=None,
                        help="Corpus directory (default: the stage scripts' own default).")
    parser.add_argument("--out-dir", type=Path, default=None,
                        help="Detector results directory (default: <data-dir>/results).")
    parser.add_argument("--log-dir", type=Path, default=None,
                        help="Log directory (default: $JACK_PIPELINE_LOG_DIR or "
                             "data/pipeline_state/logs).")
    parser.add_argument("--max-fail-pct", type=float, default=5.0,
                        help="Stop the chain when more than this %% of tickers fail the pull "
                             "(default: 5.0).")
    parser.add_argument("--no-floor-guard", action="store_true",
                        help="Pass --no-floor-guard to ingest. Use only for a known-good "
                             "deliberate shrink.")
    parser.add_argument("--no-alert", action="store_true",
                        help="Render the Phase 5 alert into the log but do NOT send it. "
                             "For previewing the message without pinging the channel.")
    parser.add_argument("--selftest", action="store_true",
                        help="Run offline checks of the cap guard and exit-code map. "
                             "No network, no subprocesses.")
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    run_date = date.today()
    if args.date:
        try:
            run_date = datetime.strptime(args.date, "%Y-%m-%d").date()
        except ValueError:
            print(f"Invalid --date: {args.date!r} (expected YYYY-MM-DD)", file=sys.stderr)
            return EXIT_ORCHESTRATOR

    log_dir = (
        args.log_dir
        or (Path(env("JACK_PIPELINE_LOG_DIR")) if env("JACK_PIPELINE_LOG_DIR") else None)
        or REPO_ROOT / "data" / "pipeline_state" / "logs"
    )
    log_path = Path(log_dir) / f"run_daily_{datetime.now():%Y%m%d_%H%M%S}.log"

    tee = Tee(log_path)
    started = time.time()
    code = EXIT_ORCHESTRATOR

    try:
        tee.rule(f"JACK NIGHTLY PIPELINE — {run_date.isoformat()}")
        tee.line(f"log        : {log_path}")
        tee.line(f"repo       : {REPO_ROOT}")
        tee.line(f"python     : {sys.executable}")
        tee.line(f"cwd        : {os.getcwd()}")
        # The task fires on the VPS clock; 19:00 ET only holds if that clock is ET.
        # Logging it makes a DST/timezone drift visible in the record instead of
        # silently shifting the run relative to the close.
        tee.line(f"clock      : {datetime.now():%Y-%m-%d %H:%M:%S} "
                 f"{time.tzname[time.daylight and time.localtime().tm_isdst > 0]}")
        tee.line(f"flags      : skip_pull={args.skip_pull} dry_run={args.dry_run} "
                 f"force={args.force} max_fail_pct={args.max_fail_pct}")

        # ---- calendar guard ------------------------------------------------
        tee.rule("CALENDAR GUARD")
        trading, why = is_trading_day(run_date)
        tee.line(f"{run_date.isoformat()}: {why}")
        if not trading and not args.force:
            tee.line("not a trading session — nothing to do. Exiting 0 (a skip is a "
                     "correct outcome, not a failure).")
            return EXIT_OK
        if not trading and args.force:
            tee.line("--force: running anyway.")

        code = stage_pull(tee, args, run_date)
        if code != EXIT_OK:
            return code

        code, watchlist = stage_detect(tee, args)
        if code != EXIT_OK:
            return code

        code, ingest_lines = stage_ingest(tee, args, watchlist)
        if code != EXIT_OK:
            return code

        code = stage_alert(tee, args, ingest_lines)
        return code

    except KeyboardInterrupt:
        tee.line("interrupted by the operator.")
        code = EXIT_ORCHESTRATOR
        return code
    except Exception as exc:  # noqa: BLE001 — an unattended job must log, not stack-trace
        import traceback
        tee.line(f"ORCHESTRATOR ERROR: {type(exc).__name__}: {exc}")
        for row in traceback.format_exc().splitlines():
            tee.line(f"  | {row}", stamp=False)
        code = EXIT_ORCHESTRATOR
        return code
    finally:
        tee.rule("RESULT")
        tee.line(f"exit {code} — {EXIT_MEANING.get(code, 'unknown')}")
        tee.line(f"elapsed {(time.time() - started) / 60:.1f} min")
        tee.line(f"log: {log_path}")
        tee.close()


if __name__ == "__main__":
    sys.exit(main())
