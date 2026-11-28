#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
strategies/prefomc/prefomc_alert.py — PreFOMC SPY put-write PAPER alert (alerts only, no execution).

    python strategies/prefomc/prefomc_alert.py                    # the 15:45 ET run
    python strategies/prefomc/prefomc_alert.py --dry-run          # evaluate + print, no send, no write
    python strategies/prefomc/prefomc_alert.py --dry-run --date 2026-12-07 --spy-px 680
    python strategies/prefomc/prefomc_alert.py --check-calendar   # list upcoming SELL / CLOSE sessions
    python strategies/prefomc/prefomc_alert.py --status           # print the state file
    python strategies/prefomc/prefomc_alert.py --selftest         # offline checks, no network

Sibling of strategies/m2/m2_alert.py: same Telegram source, Tiingo IEX quote, data/<name>/
layout, .cmd wrapper and exit codes. STANDALONE: imports nothing from JACK or M2, and
nothing outside this repo (the FOMC list is this folder's own fomc_dates.json).

THE TRADE (frozen rule, paper, 1 contract)
    SELL 1 SPY put at 15:50 ET on the session TWO NYSE sessions before each scheduled FOMC
    decision day. Strike nearest 0.98 x SPY ($1 strikes). Expiry: first listed weekly >= 5
    days after the decision day, i.e. the first expiry on/after decision + 5 days.
    BUY TO CLOSE 09:35 ET on the decision day. No stop, roll or add.
    First trade: decision Wed 2026-12-09 -> SELL Mon 12-07 -> close 09:35 Wed 12-09.

MESSAGES (one 15:45 ET run per weekday; each type at most once per day)
    SELL    : entry session (decision is 2 sessions ahead) — decision date, SPY "@HH:MM IEX",
              strike, "first weekly on/after <decision + 5 days>", the 09:35 close date
    CLOSE   : session before the decision — "FOMC CLOSE tomorrow 09:35"
    WEEKLY  : every Friday session — next decision, its SELL day, SPY
    nothing on any other day, weekend or holiday.
    Without a usable price NO SELL is sent: a "SPY price unavailable — NO SELL alert" warning
    goes out instead (exit 3); a later run the same day that gets a price still sends the SELL.
    A half-day entry session still sends the SELL, flagged: 15:50 is past a 13:00 close.

SESSIONS + TIME
    pandas_market_calendars NYSE (holidays + early closes; already in pipeline/requirements.txt).
    ET via zoneinfo America/New_York, never the machine clock's zone.

DATA — Tiingo IEX, as in M2
    /iex/SPY tngoLast, stamped "@HH:MM IEX". NOT BROKER GROUND TRUTH: the strike is a guide,
    check the chain. A quote older than STALE_MINUTES while the market is open is refused.
    key: TIINGO_API_KEY from the environment, else .env.local / .env at the repo root.

TELEGRAM — the CommandCenter bot, read-only
    %USERPROFILE%\\Documents\\NinjaTrader 8\\CommandCenter\\telegram.json
    (UTF-8 BOM, keys botToken / chatId). Override with PREFOMC_TELEGRAM_CONFIG. Never written,
    the token is never logged. Missing / unreadable credentials -> exit 1 on EVERY session.

FILES (data/ is not tracked by git; override the folder with PREFOMC_DATA_DIR)
    data/prefomc/prefomc_state.json     which message types went out on which day
    data/prefomc/prefomc_trades.csv     the forward-test log: one prefilled SELL row per entry
                                        (premium / BTC row / pnl / spy_move_hold by hand)
    data/prefomc/logs/prefomc_YYYYMMDD.log

EXIT CODES (M2's)
    0 ok (including a weekend / holiday / nothing-due no-op)
    1 bad args, missing credentials, bad fomc_dates.json, trade-log write failed, crash
    2 a Telegram send FAILED                3 SPY price missing / stale when it was needed

TASK SCHEDULER (VPS clock must be US Eastern)
    schtasks /Create /TN "PreFOMC Alert" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 15:45 ^
        /RU Administrator /RL LIMITED /TR "\\"<repo>\\strategies\\prefomc\\prefomc_alert.cmd\\""
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import sys
import tempfile
import time as _time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except Exception as _exc:  # noqa: BLE001 — Windows has no tz database without the tzdata package
    sys.stderr.write("prefomc_alert: cannot load America/New_York — py -m pip install tzdata "
                     f"({type(_exc).__name__})\n")
    sys.exit(1)

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
DATES_PATH = HERE / "fomc_dates.json"
DATA_DIR = Path(os.environ.get("PREFOMC_DATA_DIR") or (REPO_ROOT / "data" / "prefomc"))
STATE_PATH = DATA_DIR / "prefomc_state.json"
LEDGER_PATH = DATA_DIR / "prefomc_trades.csv"
LOG_DIR = DATA_DIR / "logs"
M2_CALENDAR_PATH = REPO_ROOT / "strategies" / "m2" / "nyse_calendar.json"   # selftest cross-check only

TICKER = "SPY"
STRIKE_MULT = 0.98
STRIKE_INCREMENT = 1.0          # SPY lists $1 strikes around the money
EXPIRY_MIN_DAYS = 5             # expiry = first expiry on/after decision + this many days
ENTRY_SESSIONS_AHEAD = 2        # SELL when the decision is this many NYSE sessions ahead
ENTRY_TIME = "15:50"
CLOSE_TIME = "09:35"
STALE_MINUTES = 20
RUN_WINDOW = (time(15, 30), time(16, 15))
LIST_LOW_DAYS = 60              # warn when the last listed decision is this close
STATE_KEEP_DAYS = 90
TITLE = "FOMC SELL — SPY put-write (paper, 1 contract)"

SELL, CLOSE, WEEKLY = "SELL", "CLOSE", "WEEKLY"
SELL_NO_PRICE = "SELL_NO_PRICE"     # sent INSTEAD of a SELL when SPY cannot be read
EXIT_OK, EXIT_ERROR, EXIT_TELEGRAM, EXIT_NO_PRICE = 0, 1, 2, 3

LEDGER_FIELDS = ["logged_at", "date", "decision_date", "action", "strike", "expiry", "premium",
                 "spy_px", "pnl", "spy_move_hold", "notes", "price_source"]


# ============================================================================
# Log (same shape as M2)
# ============================================================================

_LOG_FILE: Optional[Path] = None


def log(msg: str) -> None:
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    try:
        print(line, flush=True)
    except Exception:  # noqa: BLE001 — a console encoding problem must not kill the run
        pass
    if _LOG_FILE is not None:
        try:
            _LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            with _LOG_FILE.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:  # noqa: BLE001
            pass


def et_now(utc: Optional[datetime] = None) -> datetime:
    return (utc or datetime.now(timezone.utc)).astimezone(ET)


# ============================================================================
# NYSE sessions (pandas_market_calendars)
# ============================================================================

class Nyse:
    """NYSE sessions with their ET close times, cached per calendar year."""

    def __init__(self) -> None:
        import pandas_market_calendars as mcal  # type: ignore  # here so --help works without it
        self._cal = mcal.get_calendar("NYSE")
        self._years: Dict[int, Dict[date, time]] = {}

    def _year(self, y: int) -> Dict[date, time]:
        if y not in self._years:
            s = self._cal.schedule(start_date=f"{y}-01-01", end_date=f"{y}-12-31")
            self._years[y] = {ts.date(): c.tz_convert(ET).time()
                              for ts, c in zip(s.index, s["market_close"])}
        return self._years[y]

    def is_session(self, d: date) -> bool:
        return d in self._year(d.year)

    def close_time(self, d: date) -> Optional[time]:
        return self._year(d.year).get(d)

    def is_early_close(self, d: date) -> bool:
        c = self.close_time(d)
        return c is not None and c < time(16, 0)

    def sessions_before(self, d: date, n: int) -> List[date]:
        """The n sessions strictly before d, oldest first."""
        out: List[date] = []
        cur = d - timedelta(days=1)
        while len(out) < n:
            if self.is_session(cur):
                out.append(cur)
            cur -= timedelta(days=1)
        return out[::-1]

    def session_on_or_after(self, d: date) -> date:
        while not self.is_session(d):
            d += timedelta(days=1)
        return d


# ============================================================================
# FOMC decision list (self-contained)
# ============================================================================

@dataclass
class Decisions:
    dates: List[date]
    tentative_years: List[int] = field(default_factory=list)

    def is_tentative(self, d: date) -> bool:
        return d.year in self.tentative_years

    def next_after(self, d: date) -> Optional[date]:
        return next((x for x in self.dates if x > d), None)


def load_decisions(path: Path = DATES_PATH) -> Decisions:
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    dates: List[date] = []
    for year, items in raw.get("decisions", {}).items():
        for s in items:
            d = date.fromisoformat(s)
            if str(d.year) != str(year):
                raise ValueError(f"{s} is filed under {year}")
            dates.append(d)
    if len(set(dates)) != len(dates):
        raise ValueError("duplicate decision dates")
    return Decisions(sorted(dates), [int(y) for y in raw.get("tentative_years", [])])


def calendar_problems(nyse: Nyse, decisions: Decisions, today: date) -> List[str]:
    out = [f"FOMC date {d} is not an NYSE session — no alert will fire for it"
           for d in decisions.dates if d > today and not nyse.is_session(d)]
    future = [d for d in decisions.dates if d > today]
    if not future:
        out.append("NO future FOMC dates in fomc_dates.json — add the next year")
    elif (future[-1] - today).days < LIST_LOW_DAYS:
        out.append(f"FOMC list ends {future[-1]} ({(future[-1] - today).days} days) — add the next year")
    return out


# ============================================================================
# The rule
# ============================================================================

def strike_for(px: float) -> float:
    """Nearest listed strike to 0.98 x px; an exact half rounds up."""
    return math.floor(px * STRIKE_MULT / STRIKE_INCREMENT + 0.5) * STRIKE_INCREMENT


def expiry_floor(nyse: Nyse, decision: date) -> date:
    """First NYSE session on/after decision + 5 days: the earliest expiry the rule allows."""
    return nyse.session_on_or_after(decision + timedelta(days=EXPIRY_MIN_DAYS))


@dataclass
class Plan:
    kind: str
    decision: Optional[date]


def plan_for(today: date, nyse: Nyse, decisions: Decisions) -> List[Plan]:
    """The messages due on `today`, in send order. Nothing on a non-session day."""
    if not nyse.is_session(today):
        return []
    out: List[Plan] = []
    for dec in decisions.dates:
        if dec <= today or (dec - today).days > 14 or not nyse.is_session(dec):
            continue
        entry, eve = nyse.sessions_before(dec, ENTRY_SESSIONS_AHEAD)
        if today == entry:
            out.append(Plan(SELL, dec))
        if today == eve:
            out.append(Plan(CLOSE, dec))
    if today.weekday() == 4:
        out.append(Plan(WEEKLY, decisions.next_after(today)))
    return out


# ============================================================================
# Config: Tiingo key + CommandCenter Telegram (as in M2)
# ============================================================================

def tiingo_key() -> Optional[str]:
    key = os.environ.get("TIINGO_API_KEY")
    if key:
        return key.strip()
    for name in (".env.local", ".env"):
        p = REPO_ROOT / name
        if not p.exists():
            continue
        for raw in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            m = re.match(r"\s*(?:export\s+)?TIINGO_API_KEY\s*=\s*(.*)\s*$", raw)
            if m:
                return m.group(1).strip().strip('"').strip("'") or None
    return None


def telegram_config_path() -> Path:
    override = os.environ.get("PREFOMC_TELEGRAM_CONFIG")
    if override:
        return Path(override)
    home = Path(os.environ.get("USERPROFILE") or Path.home())
    return home / "Documents" / "NinjaTrader 8" / "CommandCenter" / "telegram.json"


def load_telegram() -> Tuple[Optional[str], Optional[str], str]:
    """(token, chat_id, problem). Read-only; the file is CommandCenter's."""
    path = telegram_config_path()
    try:
        cfg = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None, None, f"telegram config not found: {path}"
    except Exception as exc:  # noqa: BLE001
        return None, None, f"telegram config unreadable ({type(exc).__name__}): {path}"
    token, chat = cfg.get("botToken"), cfg.get("chatId")
    if not token or chat in (None, ""):
        return None, None, f"telegram config missing botToken/chatId: {path}"
    return str(token), str(chat), ""


def send_telegram(text: str) -> Tuple[bool, str]:
    token, chat, problem = load_telegram()
    if problem:
        return False, problem
    body = urllib.parse.urlencode({"chat_id": chat, "text": text,
                                   "disable_web_page_preview": "true"}).encode("utf-8")
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                 data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
        return bool(payload.get("ok")), "" if payload.get("ok") else str(payload)[:200]
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}"          # never echo the URL: it holds the token
    except Exception as exc:  # noqa: BLE001
        return False, type(exc).__name__


# ============================================================================
# Tiingo IEX quote (as in M2)
# ============================================================================

@dataclass
class Quote:
    px: float
    at: datetime        # ET wall time of the quote
    source: str = "IEX"


def _get_json(url: str, key: str):
    req = urllib.request.Request(url, headers={"Authorization": f"Token {key}",
                                               "Content-Type": "application/json"})
    last: Exception = RuntimeError("no attempt")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            last = RuntimeError(f"HTTP {exc.code} from {url.split('?')[0]}")
            if exc.code < 500 and exc.code != 429:
                break
        except Exception as exc:  # noqa: BLE001
            last = RuntimeError(f"{type(exc).__name__} from {url.split('?')[0]}")
        _time.sleep(3 * (attempt + 1))
    raise last


def _parse_ts(ts: str) -> Optional[datetime]:
    """Tiingo stamps carry up to 9 fractional digits; fromisoformat takes 6."""
    if not ts:
        return None
    ts = re.sub(r"(\.\d{6})\d+", r"\1", ts.replace("Z", "+00:00"))
    try:
        dt = datetime.fromisoformat(ts)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


QUOTE_TS_FIELDS = ("lastSaleTimeStamp", "lastSaleTimestamp", "timestamp")   # M2's order


def quote_from_row(q: dict) -> Quote:
    px = q.get("tngoLast") or q.get("last")
    if px is None:
        raise RuntimeError("IEX quote has no tngoLast/last")
    for f in QUOTE_TS_FIELDS:
        stamp = _parse_ts(str(q.get(f) or ""))
        if stamp is not None:
            return Quote(float(px), et_now(stamp.astimezone(timezone.utc)))
    raise RuntimeError("IEX quote has no usable timestamp")


def fetch_quote() -> Quote:
    key = tiingo_key()
    if not key:
        raise RuntimeError("TIINGO_API_KEY not set")
    rows = _get_json(f"https://api.tiingo.com/iex/{TICKER}", key)
    if not isinstance(rows, list) or not rows:
        raise RuntimeError(f"IEX quote empty: {str(rows)[:120]}")
    return quote_from_row(rows[0])


def quote_problem(q: Quote, now: datetime, nyse: Nyse) -> str:
    """Empty when usable, else why not. `now` is ET."""
    if not (math.isfinite(q.px) and q.px > 0):
        return f"bad SPY price {q.px!r}"
    if q.at.date() != now.date():
        return f"IEX quote is from {q.at:%Y-%m-%d %H:%M} ET, not today"
    close = nyse.close_time(now.date())
    age = (now - q.at).total_seconds() / 60
    if close is not None and now.time() < close and age > STALE_MINUTES:
        return f"IEX quote @{q.at:%H:%M} is {age:.0f} min old (limit {STALE_MINUTES})"
    return ""


# ============================================================================
# State + trade log
# ============================================================================

def load_state(path: Optional[Path] = None) -> dict:
    path = path or STATE_PATH
    if not path.exists():
        return {}
    try:
        st = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:  # noqa: BLE001 — never guess: a lost state could double-send a SELL
        raise RuntimeError(f"state file unreadable ({type(exc).__name__}): {path} — fix or delete "
                           "it (deleting lets today's messages re-send)")
    return st if isinstance(st, dict) else {}


def save_state(state: dict, today: date, path: Optional[Path] = None) -> None:
    path = path or STATE_PATH
    cutoff = (today - timedelta(days=STATE_KEEP_DAYS)).isoformat()
    state["sent"] = {d: v for d, v in state.get("sent", {}).items() if d >= cutoff}
    state["last_run"] = datetime.now().isoformat(timespec="seconds")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".prefomc_state.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def append_ledger(row: dict, path: Optional[Path] = None) -> None:
    path = path or LEDGER_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=LEDGER_FIELDS)
        if new:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in LEDGER_FIELDS})


# ============================================================================
# Messages
# ============================================================================

def _d(d: date) -> str:
    return f"{d:%a} {d.isoformat()}"


def _px(q: Optional[Quote]) -> str:
    return f"{q.px:.2f} @{q.at:%H:%M} {q.source}" if q else "unavailable"


def msg_sell(dec: date, q: Quote, today: date, nyse: Nyse, decisions: Decisions) -> Tuple[str, dict]:
    k = strike_for(q.px)
    exp = expiry_floor(nyse, dec)
    lines = [TITLE,
             f"SELL 1 SPY put at {ENTRY_TIME} ET today, {_d(today)}",
             f"Decision: {_d(dec)} (2 NYSE sessions ahead)",
             f"SPY last: {_px(q)} — not broker ground truth, check the chain",
             f"Strike: {k:.0f}  (0.98 × {q.px:.2f} = {q.px * STRIKE_MULT:.2f}, nearest ${STRIKE_INCREMENT:g})",
             f"Expiry: first weekly on/after {_d(exp)} (decision + {EXPIRY_MIN_DAYS} days)",
             f"Close: BUY TO CLOSE {CLOSE_TIME} ET {_d(dec)}. No stop / roll / add."]
    if nyse.is_early_close(today):
        lines.insert(1, f"⚠ HALF DAY: NYSE closes {nyse.close_time(today):%H:%M} ET today — a "
                        f"{ENTRY_TIME} entry is past the close. Decide by hand; log what you did.")
    if decisions.is_tentative(dec):
        lines.append(f"⚠ {dec.year} FOMC dates are TENTATIVE in fomc_dates.json — confirm on "
                     "federalreserve.gov.")
    row = {"logged_at": datetime.now().isoformat(timespec="seconds"), "date": today.isoformat(),
           "decision_date": dec.isoformat(), "action": "SELL", "strike": f"{k:.0f}",
           "expiry": exp.isoformat(), "spy_px": f"{q.px:.2f}",
           "notes": "prefilled by the alert; expiry = first on/after (fix if a later one was used); "
                    "fill premium",
           "price_source": f"@{q.at:%H:%M} {q.source}"}
    return "\n".join(lines), row


def msg_sell_no_price(dec: date, today: date, reason: str) -> str:
    return (f"⚠ FOMC SELL day ({_d(today)}, decision {_d(dec)}) but SPY price unavailable — "
            f"NO SELL alert sent. {reason}. Rule: strike nearest 0.98 × SPY, sell {ENTRY_TIME} ET.")


def msg_close(dec: date, q: Optional[Quote], last_entry: Optional[dict]) -> str:
    held = ""
    if last_entry and last_entry.get("decision") == dec.isoformat():
        held = f" (the {last_entry.get('strike')} put sold {last_entry.get('date')})"
    return (f"FOMC CLOSE tomorrow {CLOSE_TIME} — BUY TO CLOSE the SPY put{held} at {CLOSE_TIME} ET "
            f"{_d(dec)}, FOMC decision day. SPY last {_px(q)}.")


def msg_weekly(nxt: Optional[date], q: Optional[Quote], nyse: Nyse, decisions: Decisions,
               problems: List[str]) -> str:
    if nxt is None:
        head = "FOMC put-write weekly — no next decision listed"
    else:
        entry = nyse.sessions_before(nxt, ENTRY_SESSIONS_AHEAD)[0] if nyse.is_session(nxt) else None
        head = (f"FOMC put-write weekly — next decision {_d(nxt)}"
                + (" (tentative)" if decisions.is_tentative(nxt) else "")
                + (f", SELL {_d(entry)} {ENTRY_TIME} ET" if entry else ""))
    text = f"{head} · SPY {_px(q)}"
    return text + ("\n⚠ " + "\n⚠ ".join(problems) if problems else "")


# ============================================================================
# Run
# ============================================================================

@dataclass
class Deps:
    """Everything run() touches outside itself — injected by the selftest."""
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
    fetch_quote: Callable[[], Quote] = fetch_quote
    send: Callable[[str], Tuple[bool, str]] = send_telegram
    credentials: Callable[[], Tuple[Optional[str], Optional[str], str]] = load_telegram
    append_ledger: Callable[[dict, Optional[Path]], None] = append_ledger
    state_path: Optional[Path] = None
    ledger_path: Optional[Path] = None
    dates_path: Path = DATES_PATH
    nyse: Optional[Nyse] = None


def run(args, deps: Optional[Deps] = None) -> int:
    deps = deps or Deps()
    real_now = et_now(deps.now())
    if getattr(args, "date", None):
        today = date.fromisoformat(args.date)
        now = datetime.combine(today, time(15, 45), tzinfo=ET)    # as if run on schedule
    else:
        now, today = real_now, real_now.date()
    log(f"PreFOMC run — ET {now:%Y-%m-%d %H:%M}"
        + (f" (--date; real ET {real_now:%Y-%m-%d %H:%M})" if getattr(args, "date", None) else "")
        + (" · DRY RUN" if args.dry_run else ""))

    try:
        nyse = deps.nyse or Nyse()
    except ImportError:
        log("ERROR: pandas_market_calendars missing — py -m pip install -r pipeline/requirements.txt")
        return EXIT_ERROR
    try:
        decisions = load_decisions(deps.dates_path)
    except Exception as exc:  # noqa: BLE001
        log(f"ERROR: cannot read {deps.dates_path}: {type(exc).__name__}: {exc}")
        return EXIT_ERROR
    problems = calendar_problems(nyse, decisions, today)
    for p in problems:
        log(f"WARNING: {p}")

    if not nyse.is_session(today):
        log(f"{today} is not an NYSE session — nothing to do.")
        return EXIT_OK
    if not getattr(args, "date", None) and not (RUN_WINDOW[0] <= now.time() <= RUN_WINDOW[1]):
        log(f"WARNING: running at {now:%H:%M} ET, outside the 15:30–16:15 window "
            "(manual run, or the VPS clock is not Eastern).")

    _, _, cred_problem = deps.credentials()
    if cred_problem:
        log(f"{'WARNING' if args.dry_run else 'ERROR'}: {cred_problem}")
        if not args.dry_run:
            return EXIT_ERROR

    state = load_state(deps.state_path)
    key = today.isoformat()
    sent_today = set(state.get("sent", {}).get(key, []))

    plans = plan_for(today, nyse, decisions)
    if not plans:
        log(f"no message due (next decision {decisions.next_after(today) or 'none listed'}).")
        return EXIT_OK

    quote: Optional[Quote] = None
    quote_err = ""
    if getattr(args, "spy_px", None) is not None:
        quote = Quote(float(args.spy_px), now, "manual")
    else:
        try:
            quote = deps.fetch_quote()
        except Exception as exc:  # noqa: BLE001
            quote_err = f"SPY quote failed ({str(exc)[:160]})"
    if quote is not None:
        quote_err = quote_problem(quote, now, nyse)
        if quote_err:
            quote = None
    log(f"SPY: {_px(quote)}" + (f" — {quote_err}" if quote_err else ""))

    rc = EXIT_OK
    for plan in plans:
        kind, dec = plan.kind, plan.decision
        if kind in sent_today:
            log(f"{kind}: already sent today — not re-sent")
            continue
        row: Optional[dict] = None
        if kind == SELL and quote is None:
            kind, text = SELL_NO_PRICE, msg_sell_no_price(dec, today, quote_err)
            rc = max(rc, EXIT_NO_PRICE)
            if kind in sent_today:
                log(f"{kind}: already sent today — not re-sent")
                continue
        elif kind == SELL:
            text, row = msg_sell(dec, quote, today, nyse, decisions)
        elif kind == CLOSE:
            text = msg_close(dec, quote, state.get("last_entry"))
        else:
            text = msg_weekly(dec, quote, nyse, decisions, problems)
        if kind in (CLOSE, WEEKLY) and quote is None:
            rc = max(rc, EXIT_NO_PRICE)

        log(f"ALERT {kind}:\n{text}")
        if args.dry_run:
            continue
        ok, why = deps.send(text)
        log(f"telegram: {'sent' if ok else 'NOT sent — ' + why}")
        if not ok:
            rc = max(rc, EXIT_TELEGRAM)
            continue
        sent_today.add(kind)
        state.setdefault("sent", {})[key] = sorted(sent_today)
        if row:
            state["last_entry"] = {"date": key, "decision": dec.isoformat(), "strike": row["strike"],
                                   "expiry": row["expiry"], "spy_px": row["spy_px"]}
            state["pending_log_row"] = row        # written below; retried next run if that fails
        save_state(state, today, deps.state_path)

    if args.dry_run:
        log("dry run: nothing sent, state and trade log NOT written.")
        return rc
    pending = state.get("pending_log_row")
    if pending:
        try:
            deps.append_ledger(pending, deps.ledger_path)
            state.pop("pending_log_row", None)
            save_state(state, today, deps.state_path)
            log(f"trade log: SELL row appended to {deps.ledger_path or LEDGER_PATH}")
        except Exception as exc:  # noqa: BLE001 — e.g. the CSV is open in Excel
            log(f"ERROR: trade log NOT written ({type(exc).__name__}: {exc}) — close the file and "
                "re-run; the alert will not re-send and the row is retried.")
            rc = max(rc, EXIT_ERROR)
    log(f"exit {rc}")
    return rc


def check_calendar() -> int:
    nyse, decisions = Nyse(), load_decisions()
    today = et_now().date()
    print(f"fomc_dates.json: {len(decisions.dates)} dates, years "
          f"{sorted({d.year for d in decisions.dates})}, tentative {decisions.tentative_years}")
    for dec in (d for d in decisions.dates if d > today and nyse.is_session(d)):
        e, c = nyse.sessions_before(dec, ENTRY_SESSIONS_AHEAD)
        print(f"  decision {_d(dec)}{' (tentative)' if decisions.is_tentative(dec) else ''}: "
              f"SELL {_d(e)} · CLOSE alert {_d(c)} · expiry on/after {_d(expiry_floor(nyse, dec))}")
    problems = calendar_problems(nyse, decisions, today)
    for p in problems:
        print(f"PROBLEM: {p}")
    print("OK" if not problems else f"{len(problems)} problem(s)")
    return EXIT_OK if not problems else EXIT_ERROR


# ============================================================================
# Selftest — offline, synthetic, no network (M2 style)
# ============================================================================

def selftest() -> int:
    global log
    passed = failed = 0

    def check(label: str, cond: bool, detail: object = "") -> None:
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"  OK   {label}")
        else:
            failed += 1
            print(f"  FAIL {label} {detail}")

    nyse = Nyse()
    tmp_root = Path(tempfile.mkdtemp(prefix="prefomc_selftest_"))
    real_log, log = log, (lambda msg: None)       # keep the report readable

    def at(d: date, hh: int = 15, mm: int = 45) -> datetime:
        return datetime(d.year, d.month, d.day, hh, mm, tzinfo=ET)

    class H:
        """One isolated run environment: temp files, fake clock / quote / Telegram."""
        n = 0

        def __init__(self, decs: Optional[Sequence[date]] = None, tentative: Sequence[int] = ()):
            H.n += 1
            self.dir = tmp_root / f"h{H.n}"
            self.dir.mkdir()
            self.sent: List[str] = []
            self.send_ok, self.creds_ok, self.quote_raises = True, True, False
            self.px, self.quote_at, self.ledger_raises = 678.42, None, False
            self.clock = at(date(2026, 12, 7))
            dates_path = DATES_PATH
            if decs is not None:
                by: Dict[str, List[str]] = {}
                for d in decs:
                    by.setdefault(str(d.year), []).append(d.isoformat())
                dates_path = self.dir / "fomc_dates.json"
                dates_path.write_text(json.dumps({"decisions": by,
                                                  "tentative_years": [str(y) for y in tentative]}),
                                      encoding="utf-8")
            self.deps = Deps(now=lambda: self.clock.astimezone(timezone.utc),
                             fetch_quote=self._quote, send=self._send,
                             credentials=lambda: ("t", "c", "") if self.creds_ok
                             else (None, None, "telegram config not found: X"),
                             append_ledger=self._ledger,
                             state_path=self.dir / "state.json", ledger_path=self.dir / "trades.csv",
                             dates_path=dates_path, nyse=nyse)

        def _quote(self) -> Quote:
            if self.quote_raises:
                raise RuntimeError("no network in the selftest")
            return Quote(self.px, self.quote_at or (self.clock - timedelta(minutes=1)))

        def _send(self, text: str) -> Tuple[bool, str]:
            if not self.send_ok:
                return False, "HTTP 500"
            self.sent.append(text)
            return True, ""

        def _ledger(self, row: dict, path: Optional[Path]) -> None:
            if self.ledger_raises:
                raise PermissionError("open in Excel")
            append_ledger(row, path)

        def run(self, d: date, hh: int = 15, mm: int = 45, dry_run: bool = False,
                spy_px: Optional[float] = None) -> int:
            self.clock = at(d, hh, mm)
            return run(argparse.Namespace(dry_run=dry_run, date=None, spy_px=spy_px), self.deps)

        def kinds(self) -> List[str]:
            return ["SELL_NO_PRICE" if t.startswith("⚠ FOMC SELL day") else
                    SELL if t.startswith("FOMC SELL") else CLOSE if t.startswith("FOMC CLOSE") else
                    WEEKLY if t.startswith("FOMC put-write weekly") else "?" for t in self.sent]

        def rows(self) -> List[dict]:
            p = self.deps.ledger_path
            if not p.exists():
                return []
            with p.open(encoding="utf-8", newline="") as fh:
                return list(csv.DictReader(fh))

    def days(a: date, b: date):
        while a <= b:
            yield a
            a += timedelta(days=1)

    def fired(decs, a: date, b: date, **kw) -> Tuple[Dict[date, List[str]], "H"]:
        h, out = H(decs, **kw), {}
        for d in days(a, b):
            k = len(h.sent)
            h.run(d)
            if len(h.sent) > k:
                out[d] = h.kinds()[k:]
        return out, h

    try:
        print("[1] first trade: decision Wed 2026-12-09")
        f, h = fired([date(2026, 12, 9)], date(2026, 11, 30), date(2026, 12, 18))
        check("fires exactly: Fri weekly, Mon SELL, Tue CLOSE, Fri weekly x2",
              f == {date(2026, 12, 4): [WEEKLY], date(2026, 12, 7): [SELL], date(2026, 12, 8): [CLOSE],
                    date(2026, 12, 11): [WEEKLY], date(2026, 12, 18): [WEEKLY]}, f)
        sell = next((t for t in h.sent if t.startswith("FOMC SELL")), "")
        for s in ("Decision: Wed 2026-12-09", "SPY last: 678.42 @15:44 IEX",
                  "Strike: 665  (0.98 × 678.42 = 664.85, nearest $1)",
                  "first weekly on/after Mon 2026-12-14", "BUY TO CLOSE 09:35 ET Wed 2026-12-09"):
            check(f"  SELL says {s!r}", s in sell, sell)
        check("  no TENTATIVE / HALF DAY flag", "TENTATIVE" not in sell and "HALF DAY" not in sell)
        close = next((t for t in h.sent if t.startswith("FOMC CLOSE")), "")
        check("  CLOSE: 'FOMC CLOSE tomorrow 09:35', names the 665 put sold 12-07",
              close.startswith("FOMC CLOSE tomorrow 09:35") and "the 665 put sold 2026-12-07" in close, close)
        check("  weekly names next decision + SELL day",
              "next decision Wed 2026-12-09, SELL Mon 2026-12-07 15:50 ET" in h.sent[0], h.sent[0])
        r = h.rows()
        check("  one prefilled SELL row", len(r) == 1 and list(r[0]) == LEDGER_FIELDS
              and (r[0]["action"], r[0]["strike"], r[0]["expiry"], r[0]["spy_px"], r[0]["decision_date"],
                   r[0]["premium"], r[0]["price_source"])
              == ("SELL", "665", "2026-12-14", "678.42", "2026-12-09", "", "@15:44 IEX"), r)
        f2, _ = fired(None, date(2026, 12, 1), date(2026, 12, 10))
        check("  the real fomc_dates.json: SELL 12-07, CLOSE 12-08",
              f2.get(date(2026, 12, 7)) == [SELL] and f2.get(date(2026, 12, 8)) == [CLOSE], f2)

        print("[2] holiday inside the window")
        f, h = fired([date(2027, 1, 20)], date(2027, 1, 11), date(2027, 1, 22))
        check("MLK Mon 01-18 closed: SELL moves to Fri 01-15 (with the weekly), CLOSE Tue 01-19",
              f == {date(2027, 1, 15): [SELL, WEEKLY], date(2027, 1, 19): [CLOSE],
                    date(2027, 1, 22): [WEEKLY]}, f)
        check("  nothing on the holiday", date(2027, 1, 18) not in f)
        check("  expiry on/after Mon 2027-01-25", "on/after Mon 2027-01-25" in h.sent[0], h.sent[0])
        f, _ = fired([date(2026, 11, 30)], date(2026, 11, 23), date(2026, 11, 30))
        check("Thanksgiving: decision Mon 11-30 -> SELL Wed 11-25, CLOSE Fri 11-27 (half day)",
              f == {date(2026, 11, 25): [SELL], date(2026, 11, 27): [CLOSE, WEEKLY]}, f)
        check("expiry floor landing on Christmas -> Mon 12-28",
              expiry_floor(nyse, date(2026, 12, 20)) == date(2026, 12, 28))
        f, h = fired([date(2026, 12, 29)], date(2026, 12, 21), date(2026, 12, 29))
        check("half-day entry (Thu 12-24) is sent and flagged",
              f.get(date(2026, 12, 24)) == [SELL] and "HALF DAY: NYSE closes 13:00 ET" in h.sent[0], f)

        print("[3] nothing fires on other days (real list, Nov 2026 - Mar 2027)")
        a, b = date(2026, 11, 2), date(2027, 3, 31)
        f, _ = fired(None, a, b)
        want: Dict[date, List[str]] = {}
        for dec in load_decisions().dates:
            if a <= dec <= b + timedelta(days=10):
                e, c = nyse.sessions_before(dec, 2)
                for d, k in ((e, SELL), (c, CLOSE)):
                    if a <= d <= b:
                        want.setdefault(d, []).append(k)
        for d in days(a, b):
            if d.weekday() == 4 and nyse.is_session(d):
                want.setdefault(d, []).append(WEEKLY)
        check("fired == entry + eve + Friday sessions, nothing else", f == want,
              {d: (f.get(d), want.get(d)) for d in set(f) | set(want) if f.get(d) != want.get(d)})
        check("  Good Friday 2027-03-26: no weekly", date(2027, 3, 26) not in f)
        h = H([date(2026, 12, 9)])
        rcs = [h.run(d) for d in (date(2026, 12, 5), date(2026, 12, 6), date(2026, 11, 26), date(2026, 12, 25))]
        check("  weekend / holiday: exit 0, nothing sent, no state file",
              rcs == [0] * 4 and not h.sent and not h.deps.state_path.exists(), rcs)
        f, h = fired([date(2027, 1, 27)], date(2027, 1, 25), date(2027, 1, 25), tentative=[2027])
        check("  a tentative-year SELL says TENTATIVE", "TENTATIVE" in h.sent[0], h.sent)

        print("[4] idempotency")
        h = H([date(2026, 12, 9)])
        rcs = [h.run(date(2026, 12, 7)), h.run(date(2026, 12, 7), mm=50)]
        check("task runs twice: one SELL, one log row", rcs == [0, 0] and h.kinds() == [SELL]
              and len(h.rows()) == 1, (rcs, h.kinds(), h.rows()))
        h = H([date(2027, 1, 20)])
        h.run(date(2027, 1, 15)); h.run(date(2027, 1, 15))
        check("two types on one day, run twice: each once", h.kinds() == [SELL, WEEKLY], h.kinds())
        h = H([date(2026, 12, 9)])
        h.run(date(2026, 12, 7)); h.quote_raises = True; h.run(date(2026, 12, 7), mm=55)
        check("re-run after the SELL with the quote down sends nothing", h.kinds() == [SELL], h.kinds())
        h = H([date(2026, 12, 9)]); h.send_ok = False
        rc1 = h.run(date(2026, 12, 7)); h.send_ok = True; rc2 = h.run(date(2026, 12, 7), mm=50)
        check("failed send: exit 2, nothing logged; the next run sends it once",
              rc1 == EXIT_TELEGRAM and rc2 == 0 and h.kinds() == [SELL] and len(h.rows()) == 1,
              (rc1, rc2, h.kinds()))
        h = H([date(2026, 12, 9)]); h.ledger_raises = True
        rc1 = h.run(date(2026, 12, 7)); h.ledger_raises = False; rc2 = h.run(date(2026, 12, 7), mm=50)
        check("trade log locked: exit 1, row kept and written next run, SELL not re-sent",
              rc1 == EXIT_ERROR and rc2 == 0 and h.kinds() == [SELL] and len(h.rows()) == 1,
              (rc1, rc2, h.kinds(), h.rows()))

        print("[5] dry run")
        h = H([date(2026, 12, 9)]); h.creds_ok = False
        rc = h.run(date(2026, 12, 7), dry_run=True)
        check("sends nothing, writes no state and no log, credentials only warned",
              rc == 0 and not h.sent and not h.deps.state_path.exists() and not h.deps.ledger_path.exists(), rc)
        try:
            main(["--date", "2026-12-07"])
            check("--date without --dry-run is refused", False)
        except SystemExit as exc:
            check("--date without --dry-run is refused", exc.code == 2, exc.code)
        h = H([date(2026, 12, 9)]); h.quote_raises = True
        rc = h.run(date(2026, 12, 7), spy_px=700.0)      # run() level; the CLI adds --dry-run
        check("--spy-px: no fetch, strike 686, stamped manual",
              rc == 0 and "Strike: 686" in h.sent[0] and "@15:45 manual" in h.sent[0], h.sent)

        print("[6] fail loud")
        h = H([date(2026, 12, 9)]); h.quote_raises = True
        rc = h.run(date(2026, 12, 7))
        check("no price: NO SELL, a warning instead, exit 3, no log row",
              rc == EXIT_NO_PRICE and h.kinds() == ["SELL_NO_PRICE"] and not h.rows(), (rc, h.kinds()))
        h.quote_raises = False; rc = h.run(date(2026, 12, 7), mm=48)
        h.quote_raises = True; h.run(date(2026, 12, 7), mm=49)
        check("  price back the same day: the SELL goes out once; the warning is not repeated",
              rc == 0 and h.kinds() == ["SELL_NO_PRICE", SELL], h.kinds())
        h = H([date(2026, 12, 9)]); h.quote_at = at(date(2026, 12, 7), 15, 10)
        rc = h.run(date(2026, 12, 7))
        check("stale quote (35 min, market open) refused", rc == EXIT_NO_PRICE and "35 min old" in h.sent[0], h.sent)
        h = H([date(2026, 12, 9)]); h.quote_at = at(date(2026, 12, 4), 15, 59)
        h.run(date(2026, 12, 7))
        check("yesterday's quote refused", "not today" in h.sent[0], h.sent)
        q = Quote(600.0, at(date(2026, 11, 27), 12, 59))
        check("half day after the close: the last quote is usable",
              quote_problem(q, at(date(2026, 11, 27)), nyse) == "")
        check("NaN price refused", quote_problem(Quote(float("nan"), at(date(2026, 11, 27))),
                                                 at(date(2026, 11, 27)), nyse) != "")
        h = H([date(2026, 12, 9)]); h.creds_ok = False
        rcs = [h.run(date(2026, 12, 7)), h.run(date(2026, 12, 2))]
        check("missing credentials: exit 1 on a SELL day AND a nothing-due day, nothing sent",
              rcs == [1, 1] and not h.sent and not h.deps.state_path.exists(), rcs)
        h = H([date(2026, 12, 9)]); h.deps.state_path.write_text("{not json", encoding="utf-8")
        try:
            h.run(date(2026, 12, 7))
            check("corrupt state file raises (main() logs it, exit 1)", False)
        except RuntimeError:
            check("corrupt state file raises (main() logs it, exit 1)", not h.sent)
        cfg = tmp_root / "telegram.json"
        cfg.write_bytes(b"\xef\xbb\xbf" + json.dumps({"botToken": "x:y", "chatId": -100123}).encode())
        os.environ["PREFOMC_TELEGRAM_CONFIG"] = str(cfg)
        try:
            check("telegram.json with BOM + numeric chatId reads", load_telegram() == ("x:y", "-100123", ""))
            cfg.write_text("{}", encoding="utf-8")
            check("telegram.json without keys is a problem", "missing botToken/chatId" in load_telegram()[2])
        finally:
            del os.environ["PREFOMC_TELEGRAM_CONFIG"]

        print("[7] rule + quote helpers")
        check("strike 678.42 -> 665", strike_for(678.42) == 665)
        check("strike 612.75 -> 600 (600.495)", strike_for(612.75) == 600)
        check("strike 612.76 -> 601 (600.505)", strike_for(612.76) == 601)
        q = quote_from_row({"tngoLast": 650.0, "lastSaleTimeStamp": "2026-12-01T15:40:00.123456789-05:00",
                            "timestamp": "2026-12-01T15:44:00-05:00"})
        check("IEX: lastSaleTimeStamp (9 fractional digits) wins", q.at.strftime("%H:%M") == "15:40", q)
        q = quote_from_row({"tngoLast": 650.0, "timestamp": "2026-12-01T20:44:00+00:00"})
        check("IEX: falls back to timestamp, converted to ET", q.at.strftime("%H:%M") == "15:44", q)
        check("ET: 20:45Z in December is 15:45 EST", et_now(datetime(2026, 12, 7, 20, 45, tzinfo=timezone.utc)).hour == 15)
        check("ET: 19:45Z in June is 15:45 EDT", et_now(datetime(2027, 6, 7, 19, 45, tzinfo=timezone.utc)).hour == 15)
        h = H([date(2026, 12, 9)])
        h.deps.now = lambda: datetime(2026, 12, 7, 3, 30, tzinfo=timezone.utc)   # Sun 22:30 ET
        check("03:30Z Monday is still Sunday in ET: nothing", run(argparse.Namespace(
            dry_run=False, date=None, spy_px=None), h.deps) == 0 and not h.sent)

        print("[8] fomc_dates.json")
        decs = load_decisions()
        check("includes 2026-12-09", date(2026, 12, 9) in decs.dates)
        check("2027 present and TENTATIVE", any(d.year == 2027 for d in decs.dates) and decs.is_tentative(date(2027, 1, 27)))
        check("every listed decision is an NYSE session", all(nyse.is_session(d) for d in decs.dates),
              [d for d in decs.dates if not nyse.is_session(d)])
        check("list-ending warning", "ends 2026-12-09" in calendar_problems(nyse, Decisions([date(2026, 12, 9)]), date(2026, 11, 27))[-1])

        print("[9] sessions agree with M2's calendar (the two alerts must not disagree on a holiday)")
        try:
            m2 = json.loads(M2_CALENDAR_PATH.read_text(encoding="utf-8"))
            through = date.fromisoformat(m2["calendar_through"])
            hol, early = set(m2["holidays"]), set(m2["early_closes"])
            start = date(2026, 1, 1)
            bad = [d.isoformat() for d in days(start, through) if d.weekday() < 5
                   and (nyse.is_session(d) == (d.isoformat() in hol)
                        or nyse.is_early_close(d) != (d.isoformat() in early))]
            check(f"pandas_market_calendars == strategies/m2/nyse_calendar.json, {start}..{through}",
                  not bad, bad[:10])
        except FileNotFoundError:
            check("strategies/m2/nyse_calendar.json present", False)
    finally:
        log = real_log
        import shutil
        shutil.rmtree(tmp_root, ignore_errors=True)

    print(f"\n{'ALL PASS' if failed == 0 else 'FAILURES'} — {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


# ============================================================================
# CLI
# ============================================================================

def main(argv: Optional[Sequence[str]] = None) -> int:
    global _LOG_FILE
    p = argparse.ArgumentParser(description="PreFOMC SPY put-write paper alert (alerts only).")
    p.add_argument("--dry-run", action="store_true", help="Evaluate and print; no send, no state or log write.")
    p.add_argument("--date", metavar="YYYY-MM-DD", help="Evaluate as if 15:45 ET on DATE (needs --dry-run).")
    p.add_argument("--spy-px", type=float, default=None, help="Use this SPY price, no fetch (needs --dry-run).")
    p.add_argument("--check-calendar", action="store_true", help="List upcoming SELL / CLOSE sessions; exit 1 on a problem.")
    p.add_argument("--status", action="store_true", help="Print the state file and exit.")
    p.add_argument("--selftest", action="store_true", help="Offline checks (no network).")
    args = p.parse_args(argv)

    if args.selftest:
        return selftest()
    if args.check_calendar:
        return check_calendar()
    if args.status:
        print(json.dumps(load_state(), indent=2))
        return 0
    if (args.date or args.spy_px is not None) and not args.dry_run:
        p.error("--date and --spy-px are for testing and need --dry-run")
    if args.date:
        try:
            date.fromisoformat(args.date)
        except ValueError:
            p.error(f"bad --date {args.date!r} (YYYY-MM-DD)")

    if not args.dry_run:
        _LOG_FILE = LOG_DIR / f"prefomc_{datetime.now():%Y%m%d}.log"
    try:
        return run(args)
    except Exception as exc:  # noqa: BLE001 — an unattended job must log, not stack-trace
        import traceback
        log(f"ERROR: {type(exc).__name__}: {exc}")
        for row in traceback.format_exc().splitlines():
            log(f"  | {row}")
        if not args.dry_run:
            send_telegram(f"PreFOMC: run crashed — {type(exc).__name__}: {exc}"[:500])
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
