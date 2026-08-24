#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pipeline/tiingo_pull.py — JACK daily pipeline, PHASE 1: Tiingo EOD pull (VPS-local).

Refreshes the per-ticker OHLCV corpus the Cup-with-Handle detector reads. Replaces
the manual Patternz -> Drive copy with an incremental nightly append.

    python pipeline/tiingo_pull.py                 # nightly pull
    python pipeline/tiingo_pull.py --digest        # weekly repeat-failure digest
    python pipeline/tiingo_pull.py --dry-run       # plan only, no writes, no requests
    python pipeline/tiingo_pull.py --data-dir D    # override corpus location

=============================================================================
DESIGN CONTRACT
=============================================================================

ALWAYS PROCEED. A ticker failure is data, not an exception. Whatever succeeds is
written; whatever fails is collected and reported. 1000/1800 OK means 1000 bars
land on disk and one alert names the 800. The "is this enough data to trust?"
decision is NOT made here — it lives downstream in the Phase 4 ingest floor
guard. This script's job is: grab everything possible, report what failed, never
block the pipeline.

Only two conditions stop the run before it starts:
  1. TIINGO_API_KEY entirely absent.
  2. Total network failure — the first NETWORK_OUTAGE_STREAK tickers all fail at
     the connection layer (not HTTP), meaning we cannot reach Tiingo at all.
Everything else proceeds.

APPEND-ONLY, RAW. Full history is never re-pulled. Each ticker's local CSV
is the source of truth for "where am I up to"; we request only bars after its
last row and append them. One mechanism gives both minimal data (a current
ticker fetches ~1 bar) and gap self-healing (a ticker that missed four nights
fetches all four).

=============================================================================
WHY RAW PRICES (do not change this without re-seeding the corpus)
=============================================================================

The per-ticker corpus holds PLAIN DAILY PRICES — unadjusted. Close is the actual
day's close. So this script writes Tiingo's RAW fields (open/high/low/close/
volume), NOT the adj* variants, so that an appended bar is continuous with the
row above it.

Getting this backwards in either direction puts a step discontinuity at the
splice point, and that propagates straight into SMA50/SMA200 and ATR — the exact
inputs the detector gates on. A corrupted SMA cross silently changes which
tickers get scanned at all. It would not raise; it would just quietly scan the
wrong universe.

ONE DELIBERATE INCONSISTENCY: SPY.csv is dividend-ADJUSTED (it carries 204.35 for
2020-03-23 against an actual close of 222.95; jack-state.md documents it as
"div-adjusted"), unlike the per-ticker files. This script appends raw bars to it
anyway, and that is harmless here: the pipeline reads SPY.csv for its DATE only
(the weekly notebook's freshness check takes df['Date'].max()), and the scanner
explicitly excludes SPY from the universe it scans. Nothing in the nightly path
reads an SPY price. Note that the offline 15-yr analysis notebooks DO use SPY.csv
as an adjusted series — if one of those is ever re-run against a corpus this
script has been maintaining, re-pull SPY separately as adjusted first.

SPLIT DETECTION IS DETERMINISTIC AND LIVES HERE, NOT IN THE LLM. Raw history is
never restated, so a split puts a permanent step in the file — a 2:1 split halves
every bar from that day forward while the years above it stay at the old scale,
and SMA200 then straddles that step for ~200 sessions. The corrupted SMA silently
changes which tickers the detector scans at all.

That is a data-integrity guard, so it is a hard arithmetic test on a field Tiingo
already returns: splitFactor != 1.0. Nothing more. No model, no inference, no
network call beyond the price request itself — this module never touches the
Anthropic API and has no dependency on the analysis layer. A split check that can
silently miss is unacceptable, and a deterministic field comparison cannot miss.
Any bar with splitFactor != 1.0 is named in the alert under ⚠ SPLITS, written to
the ledger as kind=SPLIT, and flagged for a deliberate re-seed. The LLM verdict
layer downstream is free to MENTION a split as commentary; it is never what
detects one.

We do not auto-re-pull: "never re-pull full history" is a locked decision, and a
surprise 15-year refetch of 1,800 tickers is exactly the kind of thing that
should not happen unattended.

DIVIDENDS ARE A NON-EVENT AND ARE NOT DETECTED. On a raw series a stock going
ex-div is just the normal price drop the unadjusted history is supposed to show.
There is no dividend column in the corpus and dividends were never in the
backtest. divCash is deliberately ignored — not logged, not alerted, not counted.

=============================================================================
ONE-TIME SEED (before the first nightly run)
=============================================================================

The corpus is VPS-only and gitignored. It is NOT created by this script — this
script maintains an existing corpus. Seed it once:

  1. On the VPS, create the corpus root:
         C:\\Users\\Administrator\\Desktop\\bloomberg-terminal\\data\\corpus\\

  2. Copy the existing per-ticker CSVs from Google Drive MyDrive/Bukowski/*.csv
     (~1,890 files, ~450-500 MB) into that folder. Include SPY.csv — the weekly
     notebook's freshness check reads it, and this script keeps it current.
     Everything in Bukowski/results/ is a separate concern (Phase 2 seed list);
     only the flat per-ticker <TICKER>.csv files belong here.

  3. Verify the schema. Every file must have a header row whose columns include
     Date, Open, High, Low, Close (Volume optional), with Date as YYYY-MM-DD and
     rows in ascending date order:
         Date,Open,High,Low,Close,Volume
         2010-03-04,83.85455361159262,84.11555044364292,...,135526954

  4. Point the script at it, either by exporting JACK_CORPUS_DIR or by passing
     --data-dir. Confirm with a dry run:
         python pipeline/tiingo_pull.py --dry-run

THE UNIVERSE IS THE FOLDER. Tickers are discovered by globbing <DATA_DIR>/*.csv.
A ticker with no local file is not pulled — to add one, drop in a seed CSV with
at least a header and one bar (the detector needs 250+ bars to scan it anyway).
To retire a ticker, delete or move its file; the weekly digest exists to tell you
which ones have gone dead.

=============================================================================
CREDENTIALS
=============================================================================

TIINGO_API_KEY comes from the environment, or from .env.local at the repo root
if unset (Python does not auto-load .env.local, same trap documented for
`npx tsx` in jack-state.md). The token is never logged, never written to disk,
and never included in an alert body.

Telegram uses the same bot and channel as the app — TELEGRAM_BOT_TOKEN and
TELEGRAM_TRADE_CHAT_ID — mirroring lib/jack/telegram.ts (plain HTTPS POST, HTML
parse mode, graceful no-op when either env is unset, never raises). A Python
process cannot import the TypeScript module, so the behaviour is mirrored rather
than shared; keep the two in sync if the contract there changes.

Dependencies: standard library only, except pandas_market_calendars for the
trading-calendar guard. If that package is missing the script degrades to a
weekend-only check and says so — a holiday run just finds no new bars.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

# ============================================================================
# Configuration
# ============================================================================

REPO_ROOT = Path(__file__).resolve().parent.parent

# Corpus location. Overridable by env or --data-dir so the VPS and a dev box can
# differ without editing code.
DEFAULT_DATA_DIR = REPO_ROOT / "data" / "corpus"

# Where the failure ledger and digest state live. Gitignored alongside the corpus.
STATE_DIR = REPO_ROOT / "data" / "pipeline_state"
FAILURE_LEDGER = STATE_DIR / "pull_failures.csv"

TIINGO_BASE = "https://api.tiingo.com/tiingo/daily"

# Pacing between requests. 1.0s = 3,600/hr, comfortably under the paid tier's
# 10,000/hr ceiling with room for the app's own Tiingo traffic on the same
# account (the nightly VALIDATE fires its own burst). Tune once the plan is
# confirmed; do not drop below ~0.4s without re-checking the hourly cap.
PACING_SECONDS = 1.0

REQUEST_TIMEOUT = 30  # seconds per request
RETRIES_PER_TICKER = 2  # total attempts = 1 + this, only for transient failures
RETRY_BACKOFF_SECONDS = 3.0

# Total-outage tripwire: if this many tickers in a row fail at the CONNECTION
# layer (DNS/socket/timeout — never an HTTP status), we cannot reach Tiingo at
# all and there is no point walking 1,800 tickers to prove it.
NETWORK_OUTAGE_STREAK = 5

# Canonical corpus schema. Volume is optional (some seed files may omit it); the
# five OHLC columns are required.
REQUIRED_COLUMNS = ("Date", "Open", "High", "Low", "Close")
CANONICAL_COLUMNS = ("Date", "Open", "High", "Low", "Close", "Volume")

# Tiingo response fields we require on every bar. We write the RAW variants (see
# the module docstring); the adj* ones are required too because their presence is
# part of what makes a payload structurally a price bar — a body carrying only
# {date, close} is not a Tiingo price bar and must not be trusted.
REQUIRED_BAR_KEYS = (
    "date",
    "open", "high", "low", "close", "volume",
    "adjOpen", "adjHigh", "adjLow", "adjClose", "adjVolume",
)

# Corpus column -> Tiingo field. RAW / unadjusted, deliberately: the corpus holds
# plain daily prices, so an appended bar must be the actual day's price to stay
# continuous with the row above it. See WHY RAW PRICES in the module docstring.
COLUMN_TO_TIINGO_FIELD = {
    "Open": "open",
    "High": "high",
    "Low": "low",
    "Close": "close",
    "Volume": "volume",
}

# --- Weekly digest -----------------------------------------------------------
# A ticker is "repeatedly failing" when it fails on at least this many distinct
# trading days inside the trailing window. A US trading week is 5 sessions, so a
# genuinely dead ticker (delisted, acquired, renamed) fails 5/5 and clears this
# easily. A one-night blip — Tiingo hiccup, a dropped connection, a transient
# 5xx — scores 1 and never appears. Two is still plausibly two bad nights in a
# row on one flaky name; three means the ticker, not the network.
DIGEST_WINDOW_DAYS = 7
DIGEST_MIN_FAILED_DAYS = 3

# Alert sizing: how many tickers to name inline before truncating to a count.
ALERT_SAMPLE_SIZE = 15


# ============================================================================
# Environment
# ============================================================================

def _load_env_local(path: Path) -> Dict[str, str]:
    """Minimal .env parser — KEY=VALUE, # comments, optional quotes, no expansion.

    Deliberately dependency-free and deliberately dumb: this reads a secrets file,
    so it should do the least surprising thing possible.
    """
    out: Dict[str, str] = {}
    if not path.is_file():
        return out
    try:
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            if key:
                out[key] = val
    except OSError:
        return {}
    return out


_ENV_LOCAL_CACHE: Optional[Dict[str, str]] = None


def env(name: str) -> Optional[str]:
    """Real environment first, then .env.local at the repo root."""
    val = os.environ.get(name)
    if val:
        return val
    global _ENV_LOCAL_CACHE
    if _ENV_LOCAL_CACHE is None:
        _ENV_LOCAL_CACHE = _load_env_local(REPO_ROOT / ".env.local")
    val = _ENV_LOCAL_CACHE.get(name)
    return val or None


# ============================================================================
# Telegram — mirrors lib/jack/telegram.ts. Never raises.
# ============================================================================

def send_telegram(text: str) -> bool:
    """Post one message to the trade channel. Returns False on any failure.

    Graceful disable: with either env unset this warns once and no-ops, exactly
    like alertsEnabled() in the TypeScript sender. An alerting problem must never
    be the reason the pull fails.
    """
    token = env("TELEGRAM_BOT_TOKEN")
    chat_id = env("TELEGRAM_TRADE_CHAT_ID")
    if not token or not chat_id:
        log("Telegram disabled — TELEGRAM_BOT_TOKEN and/or TELEGRAM_TRADE_CHAT_ID unset.")
        return False

    payload = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:  # noqa: BLE001 — alerting must never propagate
        log(f"Telegram send failed: {type(exc).__name__}: {exc}")
        return False


def enable_utf8_stdio() -> None:
    """Force UTF-8 on stdout/stderr so a log line can never kill the run.

    WHY THIS EXISTS
    ---------------
    Windows picks the ANSI code page (cp1252 here) for stdout when it is not a
    UTF-8 console. cp1252 cannot encode U+26A0 WARNING SIGN, U+2192 RIGHTWARDS
    ARROW, or any emoji — all of which appear in this pipeline's log and alert
    strings. print() then raises UnicodeEncodeError, which is FATAL: a 2026-08-24
    run lost an otherwise-perfect detector pass (76/76 setups scored, entry_status
    stamped) because the very last log line contained a warning sign.

    A logging call must never be able to fail a pipeline stage. This makes the
    stream itself UTF-8 and lossy-on-failure, and log() below adds a second net.

    Called at import, so every module that imports from tiingo_pull — which is all
    three stage scripts and the orchestrator — is protected without repeating it.

    NON-INTERACTIVE IS THE CASE THAT MATTERS. The 19:00 Task Scheduler run has no
    console at all: stdout is a redirected file handle. reconfigure() works there
    too, and pipeline/run_daily.cmd additionally exports PYTHONUTF8=1 and
    PYTHONIOENCODING=utf-8:replace so the interpreter starts in UTF-8 mode before
    any of our code runs — which also covers output we do NOT route through log(),
    notably papermill's own progress and traceback printing.
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue  # pythonw, a replaced stream, or an exotic wrapper
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 — best effort; log() still has a fallback
            pass


enable_utf8_stdio()


def log(msg: str) -> None:
    """Timestamped stdout line. CANNOT raise — see enable_utf8_stdio()."""
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{stamp}] {msg}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        # Second net: the stream refused UTF-8 (reconfigure failed). Transliterate
        # rather than lose the line — and never let it propagate.
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        try:
            print(line.encode(enc, "replace").decode(enc, "replace"), flush=True)
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001 — a closed/broken pipe must not kill the run
        pass


# ============================================================================
# Trading-calendar guard
# ============================================================================

def is_trading_day(day: date) -> Tuple[bool, str]:
    """(is_trading_day, how_we_decided). Falls back to weekend-only if the
    pandas_market_calendars package is unavailable."""
    try:
        import pandas_market_calendars as mcal  # type: ignore
    except Exception:  # noqa: BLE001
        if day.weekday() >= 5:
            return False, "weekend (pandas_market_calendars unavailable)"
        return True, "weekday (pandas_market_calendars unavailable — holidays NOT checked)"

    try:
        cal = mcal.get_calendar("NYSE")
        sched = cal.schedule(start_date=day.isoformat(), end_date=day.isoformat())
        if len(sched) == 0:
            return False, "NYSE holiday or weekend"
        return True, "NYSE trading day"
    except Exception as exc:  # noqa: BLE001
        # A calendar bug must not stop the pull; degrade to the weekend check.
        log(f"Calendar lookup failed ({type(exc).__name__}: {exc}) — weekend check only.")
        if day.weekday() >= 5:
            return False, "weekend (calendar lookup failed)"
        return True, "weekday (calendar lookup failed)"


# ============================================================================
# Corpus CSV I/O
# ============================================================================

def read_header(path: Path) -> Optional[List[str]]:
    """First line of the CSV, split into column names. None if unreadable/empty."""
    try:
        with path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
            first = fh.readline()
    except OSError:
        return None
    if not first.strip():
        return None
    # Strip a UTF-8 BOM the same way the JACK ingest does.
    if first and first[0] == "\ufeff":
        first = first[1:]
    return [c.strip() for c in first.rstrip("\r\n").split(",")]


def read_last_line(path: Path, chunk_size: int = 4096) -> Optional[str]:
    """Last non-empty line, read by seeking from EOF.

    Deliberately NOT pandas / not a full read: the corpus is ~1,890 files
    averaging ~260 KB. Reading them whole to learn one date would move ~500 MB
    per night. This touches the final few KB of each file instead, which makes
    last-bar detection O(1) per ticker rather than O(filesize).
    """
    try:
        with path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            if size == 0:
                return None
            buf = b""
            pos = size
            while pos > 0:
                step = min(chunk_size, pos)
                pos -= step
                fh.seek(pos)
                buf = fh.read(step) + buf
                # Need at least one newline with non-empty content after it.
                stripped = buf.rstrip(b"\r\n")
                if b"\n" in stripped or pos == 0:
                    lines = [ln for ln in stripped.split(b"\n") if ln.strip()]
                    if lines:
                        return lines[-1].decode("utf-8", errors="replace").strip()
                    return None
            return None
    except OSError:
        return None


def parse_iso_date(text: str) -> Optional[date]:
    """YYYY-MM-DD (tolerating a trailing timestamp, which Tiingo sends)."""
    text = (text or "").strip().strip('"').strip("'")
    if len(text) < 10:
        return None
    try:
        return date(int(text[0:4]), int(text[5:7]), int(text[8:10]))
    except (ValueError, IndexError):
        return None


def last_bar_date(path: Path, header: Sequence[str]) -> Optional[date]:
    """Date of the final bar in a corpus file, or None if there are no data rows."""
    line = read_last_line(path)
    if line is None:
        return None
    cells = [c.strip() for c in line.split(",")]
    # A header-only file: the last line IS the header.
    if cells and cells[0].lstrip("\ufeff").strip().lower() == "date":
        return None
    try:
        date_idx = [c.lower() for c in header].index("date")
    except ValueError:
        return None
    if date_idx >= len(cells):
        return None
    return parse_iso_date(cells[date_idx])


def append_bars(path: Path, header: Sequence[str], bars: List[dict]) -> int:
    """Append validated bars in the file's OWN column order. Returns rows written.

    Columns are matched by name, so a corpus file with a different column order —
    or an extra column we don't populate — still round-trips correctly rather
    than silently shifting values into the wrong fields.
    """
    if not bars:
        return 0

    lines: List[str] = []
    for bar in bars:
        row: List[str] = []
        for col in header:
            key = col.strip()
            if key.lower() == "date":
                row.append(bar["_date"].isoformat())
                continue
            field = COLUMN_TO_TIINGO_FIELD.get(key)
            if field is None:
                row.append("")  # unknown column: leave blank, never guess
                continue
            row.append(_format_number(bar[field]))
        lines.append(",".join(row))

    payload = "\n".join(lines) + "\n"

    # Ensure we start on a fresh line — a corpus file whose last line lacks a
    # trailing newline would otherwise get its final bar concatenated with ours.
    needs_newline = False
    try:
        with path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            if fh.tell() > 0:
                fh.seek(-1, os.SEEK_END)
                needs_newline = fh.read(1) not in (b"\n", b"\r")
    except OSError:
        needs_newline = False

    with path.open("a", encoding="utf-8", newline="") as fh:
        if needs_newline:
            fh.write("\n")
        fh.write(payload)
        fh.flush()
        os.fsync(fh.fileno())  # survive a VPS power cut mid-run

    return len(lines)


def _format_number(val) -> str:
    """Match the corpus style: integers plain, floats without trailing noise."""
    if isinstance(val, bool):
        return ""
    if isinstance(val, int):
        return str(val)
    if isinstance(val, float):
        if val.is_integer() and abs(val) < 1e15:
            return str(int(val))
        return repr(val)
    return str(val)


# ============================================================================
# Tiingo fetch + STRUCTURAL CONTENT GUARD
# ============================================================================

class ConnectionLayerError(Exception):
    """Could not complete a request at all (DNS/socket/timeout) — not an HTTP status."""


def fetch_raw(ticker: str, start: date, end: date, token: str) -> str:
    """One Tiingo request. Raises ConnectionLayerError or urllib.error.HTTPError."""
    url = (
        f"{TIINGO_BASE}/{ticker}/prices"
        f"?startDate={start.isoformat()}&endDate={end.isoformat()}&format=json"
    )
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Token {token}",  # header auth — token never in the URL
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError:
        raise
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as exc:
        raise ConnectionLayerError(f"{type(exc).__name__}: {exc}") from exc


def validate_payload(body: str) -> Tuple[Optional[List[dict]], Optional[str]]:
    """STRUCTURAL CONTENT GUARD. Returns (bars, None) or (None, reason).

    Tiingo answers HTTP 200 with a NON-PRICE BODY on limit breach, e.g.
        "You have run over your 500 symbol look up limit..."
    A status check alone would accept that and we would write prose to a price
    file. So the body must prove it is price data, structurally:

      1. It must parse as JSON.
      2. The top level must be a LIST. An error body is a bare string or an
         object like {"detail": "..."} — both rejected here.
      3. Every element must be a dict carrying ALL of REQUIRED_BAR_KEYS.
      4. Every OHLCV value must be a real number (bool is explicitly excluded —
         in Python bool is an int subclass and True would otherwise pass).
      5. Every date must parse as an ISO date.

    An EMPTY list is valid and means "no new bars" — a ticker already current, or
    a session with nothing after its last bar. That is a success with zero rows,
    never a failure.
    """
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        snippet = body.strip().replace("\n", " ")[:120]
        return None, f"non-JSON body: {snippet!r}"

    if not isinstance(parsed, list):
        # The limit-breach message and every Tiingo error object land here.
        if isinstance(parsed, str):
            return None, f"non-price body (string): {parsed.strip()[:120]!r}"
        if isinstance(parsed, dict):
            detail = parsed.get("detail") or parsed.get("message") or parsed.get("error")
            if detail:
                return None, f"non-price body (object): {str(detail)[:120]!r}"
            return None, f"non-price body (object keys: {sorted(parsed.keys())[:6]})"
        return None, f"non-price body (type {type(parsed).__name__})"

    bars: List[dict] = []
    for idx, item in enumerate(parsed):
        if not isinstance(item, dict):
            return None, f"bar {idx} is {type(item).__name__}, expected object"

        missing = [k for k in REQUIRED_BAR_KEYS if k not in item]
        if missing:
            return None, f"bar {idx} missing keys: {missing[:5]}"

        bar_date = parse_iso_date(str(item["date"]))
        if bar_date is None:
            return None, f"bar {idx} has unparseable date: {str(item['date'])[:32]!r}"

        for key in REQUIRED_BAR_KEYS:
            if key == "date":
                continue
            val = item[key]
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                return None, f"bar {idx} field {key} is not numeric: {str(val)[:32]!r}"

        item["_date"] = bar_date
        bars.append(item)

    bars.sort(key=lambda b: b["_date"])
    return bars, None


def detect_split(bars: Iterable[dict]) -> Optional[str]:
    """DETERMINISTIC split check. Returns a note, or None when there is no split.

    The entire test is `float(splitFactor) != 1.0` on a field Tiingo returns with
    every bar. No model, no heuristic, no inference — a split is an arithmetic
    fact, and this is a data-integrity guard that must not be able to miss one.
    See SPLIT DETECTION IS DETERMINISTIC in the module docstring.

    Dividends are deliberately NOT examined: on a raw series ex-div is the normal
    price drop the unadjusted history is meant to show. divCash is ignored.

    We report, we do not act: auto-re-pulling 15 years of history unattended is
    precisely what "never re-pull full history" forbids.
    """
    notes: List[str] = []
    for bar in bars:
        split = bar.get("splitFactor")
        # bool is excluded explicitly: in Python bool subclasses int, so True
        # would otherwise satisfy isinstance(split, int) and compare != 1.0.
        if isinstance(split, bool) or not isinstance(split, (int, float)):
            continue
        if float(split) != 1.0:
            notes.append(f"SPLIT x{split} on {bar['_date'].isoformat()}")
    return "; ".join(notes[:3]) if notes else None


# ============================================================================
# Failure ledger — append-only CSV, one row per (run_date, ticker, reason)
# ============================================================================
#
# WHY A CSV AND NOT jack.db:
#   · jack.db is owned by the always-on Next server through better-sqlite3. A
#     second process writing it invites lock contention with the 60s scheduler
#     tick and couples this script to a schema that migrates on app restart.
#   · The pull must survive being killed mid-run. Append-only text is crash-safe
#     in a way an interrupted transaction is not.
#   · The digest query is a group-by over at most a few thousand rows. That does
#     not need a database.
#   · It stays greppable at 3am when the alert says 800 failed and you want to
#     know why without starting a Node process.
#
# Anomalies (corporate actions) are recorded in the SAME ledger under a distinct
# kind so one file answers "what went wrong lately", but they are counted and
# reported separately — a dividend is not a failure.

LEDGER_COLUMNS = ("run_date", "ticker", "kind", "reason")


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def record_ledger(rows: List[Tuple[str, str, str, str]]) -> None:
    """Append rows to the failure ledger. Never raises — a ledger problem must
    not turn a partially successful pull into a failed one."""
    if not rows:
        return
    try:
        ensure_state_dir()
        is_new = not FAILURE_LEDGER.exists()
        with FAILURE_LEDGER.open("a", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            if is_new:
                writer.writerow(LEDGER_COLUMNS)
            for row in rows:
                writer.writerow(row)
            fh.flush()
            os.fsync(fh.fileno())
    except OSError as exc:
        log(f"WARNING: could not write failure ledger: {exc}")


def load_ledger() -> List[dict]:
    if not FAILURE_LEDGER.is_file():
        return []
    try:
        with FAILURE_LEDGER.open("r", encoding="utf-8", newline="") as fh:
            return list(csv.DictReader(fh))
    except OSError as exc:
        log(f"WARNING: could not read failure ledger: {exc}")
        return []


def build_digest(today: date) -> Tuple[str, int]:
    """Weekly repeat-failure digest. Returns (message, n_repeat_offenders).

    Counts DISTINCT run dates per ticker inside the trailing window, so a single
    night that recorded a ticker twice cannot inflate it to "repeated".
    """
    rows = load_ledger()
    cutoff = today - timedelta(days=DIGEST_WINDOW_DAYS)

    by_ticker: Dict[str, set] = {}
    reasons: Dict[str, str] = {}
    for row in rows:
        if row.get("kind") != "FAIL":
            continue
        run_date = parse_iso_date(row.get("run_date", ""))
        if run_date is None or run_date <= cutoff:
            continue
        ticker = (row.get("ticker") or "").upper()
        if not ticker:
            continue
        by_ticker.setdefault(ticker, set()).add(run_date)
        reasons[ticker] = (row.get("reason") or "")[:80]

    repeat = sorted(
        ((t, len(d)) for t, d in by_ticker.items() if len(d) >= DIGEST_MIN_FAILED_DAYS),
        key=lambda kv: (-kv[1], kv[0]),
    )

    if not repeat:
        return (
            f"📋 <b>JACK Tiingo weekly digest</b>\n"
            f"No ticker failed on {DIGEST_MIN_FAILED_DAYS}+ days in the last "
            f"{DIGEST_WINDOW_DAYS}. Corpus looks healthy.",
            0,
        )

    lines = [
        f"📋 <b>JACK Tiingo weekly digest</b>",
        f"{len(repeat)} ticker(s) failed on {DIGEST_MIN_FAILED_DAYS}+ of the last "
        f"{DIGEST_WINDOW_DAYS} days — candidates for pruning (delisted / acquired / renamed):",
        "",
    ]
    for ticker, days in repeat[:40]:
        lines.append(f"· <b>{ticker}</b> — {days}d · {reasons.get(ticker, '')}")
    if len(repeat) > 40:
        lines.append(f"… and {len(repeat) - 40} more (see {FAILURE_LEDGER.name})")
    lines.append("")
    lines.append("Prune by removing the ticker's CSV from the corpus folder.")
    return "\n".join(lines), len(repeat)


# ============================================================================
# The pull
# ============================================================================

class TickerResult:
    __slots__ = ("ticker", "status", "rows_written", "reason", "split_note")

    def __init__(self, ticker: str, status: str, rows_written: int = 0,
                 reason: str = "", split_note: str = "") -> None:
        self.ticker = ticker
        self.status = status  # OK | UP_TO_DATE | SKIPPED | FAIL
        self.rows_written = rows_written
        self.reason = reason
        # Non-empty only when splitFactor != 1.0 — the ticker needs a re-seed.
        self.split_note = split_note


def pull_one(path: Path, token: str, today: date, dry_run: bool) -> Tuple[TickerResult, bool]:
    """Pull and append one ticker. Returns (result, hit_connection_layer_error).

    Never raises. Every failure mode becomes a FAIL result with a reason string.
    """
    ticker = path.stem.upper()

    header = read_header(path)
    if not header:
        return TickerResult(ticker, "FAIL", reason="unreadable or empty CSV"), False

    lower = [c.lower() for c in header]
    missing_cols = [c for c in REQUIRED_COLUMNS if c.lower() not in lower]
    if missing_cols:
        return TickerResult(ticker, "FAIL", reason=f"corpus header missing {missing_cols}"), False

    last = last_bar_date(path, header)
    if last is None:
        # No data rows. We refuse to invent a start date and backfill 15 years by
        # accident; seeding is a deliberate act (see ONE-TIME SEED).
        return TickerResult(
            ticker, "FAIL",
            reason="no data rows — seed this file with at least one bar",
        ), False

    # ---- APPEND-FROM-LAST-DATE + GAP SELF-HEAL --------------------------------
    # start = the day AFTER the last local bar; end = today. Tiingo's startDate is
    # inclusive, so this asks for exactly the bars we are missing and nothing we
    # already hold. One night behind -> a one-day window -> ~1 bar. Four nights
    # behind -> a four-day window -> all four bars. The window is derived from the
    # file, not from "today", which is what makes a missed night self-heal on the
    # next run instead of leaving a permanent hole.
    start = last + timedelta(days=1)
    if start > today:
        return TickerResult(ticker, "UP_TO_DATE"), False

    if dry_run:
        span = (today - start).days + 1
        return TickerResult(
            ticker, "SKIPPED",
            reason=f"dry-run: would request {start} .. {today} ({span}d window)",
        ), False

    body: Optional[str] = None
    last_err = ""
    hit_connection_error = False

    for attempt in range(RETRIES_PER_TICKER + 1):
        try:
            body = fetch_raw(ticker, start, today, token)
            break
        except ConnectionLayerError as exc:
            hit_connection_error = True
            last_err = f"connection: {exc}"
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", errors="replace")[:120].strip()
            except Exception:  # noqa: BLE001
                pass
            last_err = f"HTTP {exc.code}" + (f": {detail}" if detail else "")
            # 4xx is a statement about this ticker (404 unknown/delisted, 403 not
            # entitled). Retrying cannot change it. 5xx and 429 are worth a retry.
            if 400 <= exc.code < 500 and exc.code != 429:
                break
        except Exception as exc:  # noqa: BLE001 — one ticker must never kill the run
            last_err = f"{type(exc).__name__}: {exc}"

        if attempt < RETRIES_PER_TICKER:
            time.sleep(RETRY_BACKOFF_SECONDS)

    if body is None:
        return TickerResult(ticker, "FAIL", reason=last_err or "unknown fetch failure"), hit_connection_error

    bars, guard_error = validate_payload(body)
    if guard_error is not None:
        # Structural guard rejected it. Nothing is written to disk.
        return TickerResult(ticker, "FAIL", reason=guard_error), hit_connection_error

    assert bars is not None
    # Defence in depth: the request window already excludes them, but never
    # append a bar at or before the last local date.
    fresh = [b for b in bars if b["_date"] > last]
    split_note = detect_split(fresh) or ""

    if not fresh:
        return TickerResult(ticker, "UP_TO_DATE", split_note=split_note), hit_connection_error

    try:
        written = append_bars(path, header, fresh)
    except OSError as exc:
        return TickerResult(ticker, "FAIL", reason=f"write failed: {exc}"), hit_connection_error

    return TickerResult(ticker, "OK", rows_written=written,
                        split_note=split_note), hit_connection_error


def discover_tickers(data_dir: Path) -> List[Path]:
    return sorted(p for p in data_dir.glob("*.csv") if p.is_file())


def build_alert(today: date, ok: int, up_to_date: int, failures: List[TickerResult],
                splits: List[TickerResult], bars_written: int, elapsed: float,
                total: int) -> str:
    """The pull ALWAYS alerts — clean or dirty. Silence is indistinguishable from
    a dead scheduler, which is the failure this alert exists to catch."""
    succeeded = ok + up_to_date
    if not failures:
        head = f"✅ <b>Tiingo pull: {succeeded}/{total} clean</b>"
    else:
        head = f"⚠️ <b>Tiingo pull: {succeeded} OK, {len(failures)} FAILED</b>"

    lines = [
        head,
        f"{today.isoformat()} · {bars_written} new bars · {elapsed / 60:.1f} min",
        f"updated {ok} · already current {up_to_date}",
    ]

    if failures:
        lines.append("")
        lines.append(f"<b>Failed ({len(failures)}):</b>")
        for res in failures[:ALERT_SAMPLE_SIZE]:
            lines.append(f"· {res.ticker} — {res.reason[:70]}")
        if len(failures) > ALERT_SAMPLE_SIZE:
            lines.append(f"… and {len(failures) - ALERT_SAMPLE_SIZE} more (see {FAILURE_LEDGER.name})")

    # Splits put a permanent step in a raw series, so they are always surfaced.
    # Dividends are not detected at all — see the module docstring.
    if splits:
        lines.append("")
        lines.append(f"<b>⚠ SPLITS ({len(splits)})</b> — raw history now has a step; re-seed these tickers:")
        for res in splits[:ALERT_SAMPLE_SIZE]:
            lines.append(f"· {res.ticker} — {res.split_note[:70]}")
        if len(splits) > ALERT_SAMPLE_SIZE:
            lines.append(f"… and {len(splits) - ALERT_SAMPLE_SIZE} more")

    lines.append("")
    lines.append("<i>Pull is advisory — the ingest floor guard decides whether the board updates.</i>")
    return "\n".join(lines)


def run_pull(data_dir: Path, today: date, dry_run: bool) -> int:
    # ---- FATAL 1: no token --------------------------------------------------
    token = env("TIINGO_API_KEY")
    if not token:
        msg = ("🛑 <b>Tiingo pull ABORTED</b>\nTIINGO_API_KEY is not set "
               "(checked environment and .env.local). No requests attempted.")
        log("FATAL: TIINGO_API_KEY not set.")
        send_telegram(msg)
        return 2

    if not data_dir.is_dir():
        msg = (f"🛑 <b>Tiingo pull ABORTED</b>\nCorpus directory not found: "
               f"{data_dir}\nSee the ONE-TIME SEED notes in tiingo_pull.py.")
        log(f"FATAL: corpus directory not found: {data_dir}")
        send_telegram(msg)
        return 2

    trading, why = is_trading_day(today)
    if not trading:
        log(f"{today.isoformat()} is not a trading day ({why}) — no-op.")
        return 0
    log(f"{today.isoformat()}: {why}. Corpus: {data_dir}")

    tickers = discover_tickers(data_dir)
    if not tickers:
        msg = (f"🛑 <b>Tiingo pull ABORTED</b>\nNo CSV files in {data_dir}. "
               f"Corpus not seeded?")
        log("FATAL: corpus directory contains no CSV files.")
        send_telegram(msg)
        return 2

    log(f"{len(tickers)} tickers discovered. Pacing {PACING_SECONDS}s"
        + (" (DRY RUN — no requests, no writes)" if dry_run else ""))

    started = time.time()
    ok: List[TickerResult] = []
    up_to_date: List[TickerResult] = []
    skipped: List[TickerResult] = []
    failures: List[TickerResult] = []
    splits: List[TickerResult] = []
    bars_written = 0
    consecutive_connection_errors = 0

    for idx, path in enumerate(tickers, start=1):
        result, conn_error = pull_one(path, token, today, dry_run)

        if conn_error and result.status == "FAIL":
            consecutive_connection_errors += 1
        else:
            consecutive_connection_errors = 0

        # ---- FATAL 2: total network failure ---------------------------------
        if consecutive_connection_errors >= NETWORK_OUTAGE_STREAK:
            elapsed = time.time() - started
            log(f"FATAL: {consecutive_connection_errors} consecutive connection-layer "
                f"failures — treating as total network outage. Aborting at {idx}/{len(tickers)}.")
            record_ledger([(today.isoformat(), r.ticker, "FAIL", r.reason) for r in failures])
            send_telegram(
                f"🛑 <b>Tiingo pull ABORTED — network unreachable</b>\n"
                f"{consecutive_connection_errors} consecutive connection failures at "
                f"ticker {idx}/{len(tickers)}.\n"
                f"{len(ok)} tickers updated before the abort ({bars_written} bars) — those writes stand.\n"
                f"Last error: {result.reason[:100]}"
            )
            return 3

        if result.status == "OK":
            ok.append(result)
            bars_written += result.rows_written
        elif result.status == "UP_TO_DATE":
            up_to_date.append(result)
        elif result.status == "SKIPPED":
            skipped.append(result)
        else:
            failures.append(result)
            log(f"  FAIL {result.ticker}: {result.reason}")

        if result.split_note:
            splits.append(result)

        if idx % 100 == 0:
            log(f"  {idx}/{len(tickers)} · {len(ok)} updated · "
                f"{len(up_to_date)} current · {len(failures)} failed "
                f"({time.time() - started:.0f}s)")

        # Pace only when we actually made a request.
        if not dry_run and result.status != "UP_TO_DATE" and idx < len(tickers):
            time.sleep(PACING_SECONDS)

    elapsed = time.time() - started

    if dry_run:
        log(f"DRY RUN complete: {len(skipped)} tickers would be requested, "
            f"{len(up_to_date)} already current, {len(failures)} unreadable.")
        for res in skipped[:10]:
            log(f"  {res.ticker}: {res.reason}")
        for res in failures[:10]:
            log(f"  FAIL {res.ticker}: {res.reason}")
        return 0

    # Persist failures AND anomalies for the weekly digest.
    ledger_rows: List[Tuple[str, str, str, str]] = []
    ledger_rows += [(today.isoformat(), r.ticker, "FAIL", r.reason) for r in failures]
    ledger_rows += [(today.isoformat(), r.ticker, "SPLIT", r.split_note) for r in splits]
    record_ledger(ledger_rows)

    log(f"Done in {elapsed / 60:.1f} min: {len(ok)} updated ({bars_written} bars), "
        f"{len(up_to_date)} already current, {len(failures)} failed, "
        f"{len(splits)} splits (re-seed).")

    send_telegram(build_alert(today, len(ok), len(up_to_date), failures, splits,
                              bars_written, elapsed, len(tickers)))

    # ALWAYS PROCEED: partial success is success. Exit 0 so the orchestrator
    # continues to the detector — the Phase 4 floor guard owns the "is this
    # enough data?" decision, not this script. Only the two fatal conditions
    # above (2 = cannot start, 3 = network gone) exit non-zero.
    return 0


# ============================================================================
# Entry point
# ============================================================================

def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="JACK Phase 1 — incremental Tiingo EOD pull into the VPS-local corpus."
    )
    parser.add_argument("--data-dir", type=Path, default=None,
                        help=f"Corpus directory (default: $JACK_CORPUS_DIR or {DEFAULT_DATA_DIR})")
    parser.add_argument("--date", type=str, default=None,
                        help="Run date YYYY-MM-DD (default: today). Testing aid.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report the planned request window per ticker. No requests, no writes.")
    parser.add_argument("--digest", action="store_true",
                        help="Emit the weekly repeat-failure digest and exit. Makes no requests.")
    args = parser.parse_args(argv)

    run_date = date.today()
    if args.date:
        parsed = parse_iso_date(args.date)
        if parsed is None:
            log(f"Invalid --date: {args.date!r}")
            return 2
        run_date = parsed

    if args.digest:
        message, count = build_digest(run_date)
        log(message.replace("<b>", "").replace("</b>", "").replace("<i>", "").replace("</i>", ""))
        send_telegram(message)
        return 0

    data_dir = args.data_dir or Path(env("JACK_CORPUS_DIR") or DEFAULT_DATA_DIR)
    return run_pull(data_dir.expanduser().resolve(), run_date, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
