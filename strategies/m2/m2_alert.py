#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
strategies/m2/m2_alert.py — M2 SPY mean-reversion PAPER alert (alerts only, no execution).

    python strategies/m2/m2_alert.py                       # the 15:45 ET run
    python strategies/m2/m2_alert.py --dry-run             # evaluate + print, no send, no state write
    python strategies/m2/m2_alert.py --set-flat            # manual override: not in a trade
    python strategies/m2/m2_alert.py --set-in-trade 2026-12-01 [--entry-px 640.12] [--strike 608]
    python strategies/m2/m2_alert.py --status              # print the state file
    python strategies/m2/m2_alert.py --selftest            # offline logic checks

STANDALONE. Imports nothing from JACK; stdlib only (no pip installs on the VPS).

THE TRADE
    SELL 1 SPY put ~30 DTE (20-45 window), strike ~0.95 x SPY. A short put is LONG
    delta — this is a bullish dip-buy after 3 lower closes above the 200-day, which is
    why the messages say "SELL SPY PUT (bullish dip)", not "short SPY".

RULES (today's ~15:45 price stands in for today's close in every calculation)
    filter : price > SMA200            (SMA200 / SMA5 include today's price)
    SETUP  : filter AND streak == 2     price < close[-1] < close[-2]
    ENTER  : filter AND streak >= 3     price < close[-1] < close[-2] < close[-3],
             flat, and NOT already entered on this streak (first-only: one ENTER per
             streak; it re-arms only when the streak resets with a higher close)
    EXIT   : in a trade AND (price > SMA5 OR hold day >= 5)
    WEEKLY : every Friday session, in addition to anything else
    In a trade, entry alerts are suppressed. No entry on the day of an exit.

STATE (data/m2/m2_state.json)
    ENTER sets in_trade automatically (paper forward-test: the record must not depend
    on remembering a hand edit). EXIT clears it. --set-flat / --set-in-trade override.
    hold_day is stored for reading but RE-DERIVED every run from entry_date and the
    daily bars (entry session = day 0), so a missed run cannot skew the count.
    Every SETUP / ENTER / EXIT / manual override is appended to data/m2/m2_trades.csv
    (once per event per session date). This script is the ONLY writer; the IV-tab M2
    panel reads the CSV and the state file and never writes either.

PARITY WITH THE PAGE (lib/m2/signal.ts)
    --emit-fixture writes strategies/m2/parity_fixture.json: synthetic cases with this
    file's outputs. scripts/m2-parity-check.ts asserts the TS port matches them exactly;
    --selftest fails if the committed fixture is out of date with this file.

DATA — Tiingo only, never yfinance, never the JACK corpus
    history : /tiingo/daily/SPY/prices, adjClose (dividend-adjusted — a quarterly
              ex-div drop must not count as a "lower close"). Adjustment only
              rewrites OLDER bars, so adjusted history + today's raw price is coherent.
              data/corpus/SPY.csv is NOT used: it splices adjusted and raw bars.
    today   : /iex/SPY tngoLast, stamped "@HH:MM IEX" in every message.
              THIS IS NOT BROKER GROUND TRUTH: a single-venue print ~15 min before
              the bell. The real close can differ, and so can the streak / SMA5 test.
              A quote older than STALE_MINUTES is refused (no evaluation).
    key     : TIINGO_API_KEY from the environment, else .env.local / .env at the repo root.

TELEGRAM — the CommandCenter bot, read-only
    %USERPROFILE%\\Documents\\NinjaTrader 8\\CommandCenter\\telegram.json
    (UTF-8 BOM, keys botToken / chatId). Override with M2_TELEGRAM_CONFIG. Never written.
    The task must therefore run as the user that owns that Documents folder.

FILES
    data/m2/m2_state.json · data/m2/m2_trades.csv · data/m2/logs/m2_YYYYMMDD.log
    (override the folder with M2_DATA_DIR). data/ is not tracked by git.

EXIT CODES
    0 ok (including a weekend / holiday no-op)   1 bad args / unexpected error
    2 evaluated, but the Telegram send FAILED     3 no evaluation (data missing / stale)

TASK SCHEDULER (VPS clock must be US Eastern)
    schtasks /Create /TN "M2 Alert" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 15:45 ^
        /RU Administrator /RL LIMITED /TR "\\"<repo>\\strategies\\m2\\m2_alert.cmd\\""
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = Path(os.environ.get("M2_DATA_DIR") or (REPO_ROOT / "data" / "m2"))
STATE_PATH = DATA_DIR / "m2_state.json"
LEDGER_PATH = DATA_DIR / "m2_trades.csv"
LOG_DIR = DATA_DIR / "logs"

TICKER = "SPY"
SMA_FILTER = 200
SMA_EXIT = 5
MAX_HOLD = 5            # EXIT when hold day >= this (entry session = day 0)
STRIKE_MULT = 0.95
STALE_MINUTES = 20
HISTORY_DAYS = 420      # calendar days fetched — comfortably > 200 sessions
TITLE = "M2 — SELL SPY PUT (bullish dip)"

# NYSE full closures and 13:00 early closes, from the JSON file the IV-tab M2 panel
# (lib/m2) also reads — one calendar, so the page and the alert agree on sessions.
# Weekends are handled separately. The script warns (log + Telegram, once) after
# calendar_through lapses.
CALENDAR_PATH = Path(__file__).resolve().parent / "nyse_calendar.json"
_CAL = json.loads(CALENDAR_PATH.read_text(encoding="utf-8"))
NYSE_HOLIDAYS = set(_CAL["holidays"])
NYSE_EARLY_CLOSES = set(_CAL["early_closes"])
CALENDAR_THROUGH = date.fromisoformat(_CAL["calendar_through"])
FIXTURE_PATH = Path(__file__).resolve().parent / "parity_fixture.json"


# ============================================================================
# Time (US Eastern without tzdata — Windows Python ships no zoneinfo database)
# ============================================================================

def _nth_sunday(year: int, month: int, n: int) -> date:
    d = date(year, month, 1)
    d += timedelta(days=(6 - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def et_now(utc: Optional[datetime] = None) -> datetime:
    """Current US Eastern wall time (naive). DST: 2nd Sun Mar 07:00Z -> 1st Sun Nov 06:00Z."""
    utc = utc or datetime.now(timezone.utc)
    y = utc.year
    dst_start = datetime.combine(_nth_sunday(y, 3, 2), datetime.min.time(), timezone.utc) + timedelta(hours=7)
    dst_end = datetime.combine(_nth_sunday(y, 11, 1), datetime.min.time(), timezone.utc) + timedelta(hours=6)
    offset = -4 if dst_start <= utc < dst_end else -5
    return (utc + timedelta(hours=offset)).replace(tzinfo=None)


def is_session(d: date) -> bool:
    return d.weekday() < 5 and d.isoformat() not in NYSE_HOLIDAYS


# ============================================================================
# Logging
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


# ============================================================================
# Config: Tiingo key + CommandCenter Telegram
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
    override = os.environ.get("M2_TELEGRAM_CONFIG")
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
# Tiingo
# ============================================================================

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
        time.sleep(3 * (attempt + 1))
    raise last


def fetch_history(key: str, today: date) -> List[Tuple[str, float]]:
    """Daily (date, adjClose) for sessions BEFORE today, oldest first."""
    start = (today - timedelta(days=HISTORY_DAYS)).isoformat()
    rows = _get_json(f"https://api.tiingo.com/tiingo/daily/{TICKER}/prices?startDate={start}", key)
    if not isinstance(rows, list):
        raise RuntimeError(f"daily history was not a list: {str(rows)[:120]}")
    out = []
    for r in rows:
        d = str(r.get("date", ""))[:10]
        px = r.get("adjClose")
        if d and px is not None and d < today.isoformat():
            out.append((d, float(px)))
    out.sort()
    return out


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


# Which IEX field dates the quote, in priority order. Tiingo documents the sale time
# as `lastSaleTimeStamp` (capital S); the lower-case spelling is accepted too. Before
# 2026-11-27 only `lastSaleTimestamp` was read, so the real field was missed and the
# age fell through to `timestamp`. lib/m2/signal.ts uses this SAME order (fixture-checked).
QUOTE_TS_FIELDS = ("lastSaleTimeStamp", "lastSaleTimestamp", "timestamp")


def quote_from_row(q: dict) -> Tuple[float, datetime]:
    """One IEX row -> (tngoLast, its ET wall time). Pure; parity-checked against lib/m2."""
    px = q.get("tngoLast") or q.get("last")
    if px is None:
        raise RuntimeError("IEX quote has no tngoLast/last")
    stamp = None
    for field in QUOTE_TS_FIELDS:
        stamp = _parse_ts(str(q.get(field) or ""))
        if stamp is not None:
            break
    if stamp is None:
        raise RuntimeError("IEX quote has no usable timestamp")
    return float(px), et_now(stamp.astimezone(timezone.utc))


def fetch_quote(key: str) -> Tuple[float, datetime]:
    """(tngoLast, its ET wall time)."""
    rows = _get_json(f"https://api.tiingo.com/iex/{TICKER}", key)
    if not isinstance(rows, list) or not rows:
        raise RuntimeError(f"IEX quote empty: {str(rows)[:120]}")
    return quote_from_row(rows[0])


# ============================================================================
# State + ledger
# ============================================================================

FLAT_STATE = {"in_trade": False, "entry_date": None, "entry_px": None, "strike": None,
              "hold_day": 0, "last_entry_streak_id": None, "last_alerts": {"date": None, "kinds": []},
              "last_run": None, "updated_by": None}


def load_state() -> dict:
    if not STATE_PATH.exists():
        return json.loads(json.dumps(FLAT_STATE))
    state = json.loads(STATE_PATH.read_text(encoding="utf-8-sig"))
    for k, v in FLAT_STATE.items():
        state.setdefault(k, json.loads(json.dumps(v)))
    return state


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(STATE_PATH.parent), prefix=".m2_state.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, STATE_PATH)


LEDGER_FIELDS = ["logged_at", "event", "session_date", "spy_px", "sma200", "sma5", "streak",
                 "strike", "hold_day", "reason", "price_source"]


def append_ledger(row: dict) -> None:
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    new = not LEDGER_PATH.exists()
    with LEDGER_PATH.open("a", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=LEDGER_FIELDS)
        if new:
            w.writeheader()
        w.writerow({"logged_at": datetime.now().isoformat(timespec="seconds"),
                    **{k: row.get(k, "") for k in LEDGER_FIELDS if k != "logged_at"}})


# ============================================================================
# The pure decision — no I/O, fully covered by --selftest
# ============================================================================

def plain_sum(xs: Sequence[float]) -> float:
    """Left-to-right float sum. NOT the builtin: Python 3.12+ sum() is compensated
    (Neumaier) while 3.11 is not, and JS adds left-to-right — the builtin would make
    the SMA doubles depend on the interpreter version. This is identical everywhere."""
    s = 0.0
    for x in xs:
        s += x
    return s


def lower_close_streak(closes: Sequence[float]) -> int:
    n, i = 0, len(closes) - 1
    while i > 0 and closes[i] < closes[i - 1]:
        n += 1
        i -= 1
    return n


def evaluate(history: Sequence[Tuple[str, float]], px: float, today: str, state: dict,
             stamp: str = "@15:45 IEX", early_close: bool = False, friday: bool = False
             ) -> Tuple[List[Tuple[str, str]], dict, List[dict]]:
    """Returns (alerts [(kind, text)], new_state, ledger_rows). Does not touch disk."""
    st = json.loads(json.dumps(state))
    dates = [d for d, _ in history] + [today]
    closes = [c for _, c in history] + [px]
    if len(closes) < SMA_FILTER + 4:
        raise RuntimeError(f"only {len(closes)} closes — need {SMA_FILTER + 4}")

    sma200 = plain_sum(closes[-SMA_FILTER:]) / SMA_FILTER
    sma5 = plain_sum(closes[-SMA_EXIT:]) / SMA_EXIT
    streak = lower_close_streak(closes)
    streak_id = dates[-1 - streak] if streak else None   # the close the streak fell from
    filt = px > sma200
    strike = round(STRIKE_MULT * px)
    late = ("\n⚠ Market closed early today — this price is the early close; act next session."
            if early_close else "")
    f2 = lambda x: f"{x:.2f}"  # noqa: E731

    alerts: List[Tuple[str, str]] = []
    ledger: List[dict] = []
    base = {"session_date": today, "spy_px": f2(px), "sma200": f2(sma200), "sma5": f2(sma5),
            "streak": streak, "price_source": stamp.strip("@ ")}
    exited_today = False

    if st["in_trade"] and st.get("entry_date"):
        # hold day = sessions since entry; entry session is day 0
        hold = sum(1 for d in dates if d > st["entry_date"])
        st["hold_day"] = hold
        if hold >= 1:
            reasons = []
            if px > sma5:
                reasons.append("close > SMA5")
            if hold >= MAX_HOLD:
                reasons.append(f"{hold}th session" if hold != 1 else "1st session")
            if reasons:
                reason = " + ".join(reasons)
                alerts.append(("exit",
                               f"M2 EXIT: buy to close the SPY put at today's close ({reason}). "
                               f"SPY {f2(px)} {stamp}, SMA5 {f2(sma5)}. "
                               f"Held {hold} session{'s' if hold != 1 else ''} "
                               f"(entered {st['entry_date']}"
                               + (f", strike {st['strike']}" if st.get("strike") else "") + ")." + late))
                ledger.append({**base, "event": "EXIT", "strike": st.get("strike") or "",
                               "hold_day": hold, "reason": reason})
                st.update({"in_trade": False, "entry_date": None, "entry_px": None,
                           "strike": None, "hold_day": 0, "updated_by": "auto:exit"})
                exited_today = True
    elif not exited_today:
        if filt and streak >= 3 and streak_id != st.get("last_entry_streak_id"):
            alerts.append(("enter",
                           f"{TITLE} — ENTER: SPY {f2(px)} {stamp}, {streak} lower closes above "
                           f"200d ({f2(sma200)}). SELL 1 SPY put ~30 DTE (20–45 window), "
                           f"strike ≈ 0.95×px = {strike}. Exit: first close > SMA5 or 5th session."
                           f"\n(paper: in_trade set automatically — --set-flat to undo)" + late))
            ledger.append({**base, "event": "ENTER", "strike": strike, "hold_day": 0,
                           "reason": f"{streak} lower closes, filter ON"})
            st.update({"in_trade": True, "entry_date": today, "entry_px": round(px, 2),
                       "strike": strike, "hold_day": 0, "last_entry_streak_id": streak_id,
                       "updated_by": "auto:enter"})
        elif filt and streak == 2:
            alerts.append(("setup",
                           f"{TITLE} may set up: SPY {f2(px)} {stamp}, 2 lower closes, above 200d "
                           f"({f2(sma200)}). One more lower close tomorrow = entry. Be ready 15:45." + late))
            ledger.append({**base, "event": "SETUP", "strike": "", "hold_day": "",
                           "reason": "2 lower closes, filter ON"})

    if friday:
        pos = (f"in trade since {st['entry_date']} (day {st['hold_day']}, strike {st['strike']})"
               if st["in_trade"] else "flat")
        alerts.append(("weekly",
                       f"M2 weekly: SPY {f2(px)} {stamp} vs 200d {f2(sma200)} — filter "
                       f"{'ON' if filt else 'OFF'}; lower-close streak {streak}; {pos}." + late))

    st["metrics"] = {"date": today, "px": round(px, 2), "sma200": round(sma200, 2),
                     "sma5": round(sma5, 2), "streak": streak, "filter_on": filt}
    return alerts, st, ledger


# ============================================================================
# The run
# ============================================================================

def run(args) -> int:
    now = et_now()
    today = now.date()
    log(f"M2 run — ET {now:%Y-%m-%d %H:%M} · data {DATA_DIR}" + (" · DRY RUN" if args.dry_run else ""))

    if today > CALENDAR_THROUGH:
        log(f"WARNING: NYSE calendar in m2_alert.py ends {CALENDAR_THROUGH} — extend it.")
        state = load_state()
        if not state.get("calendar_warned") and not args.dry_run:
            send_telegram(f"M2: holiday calendar ended {CALENDAR_THROUGH} — extend NYSE_HOLIDAYS.")
            state["calendar_warned"] = True
            save_state(state)

    if not is_session(today):
        log(f"{today} is not an NYSE session — nothing to do.")
        return 0
    if not (now.hour == 15 and now.minute >= 30) and not (now.hour == 16 and now.minute <= 15):
        log(f"WARNING: running at {now:%H:%M} ET, outside the 15:30–16:15 window "
            "(manual run, or the VPS clock is not Eastern).")

    early = today.isoformat() in NYSE_EARLY_CLOSES

    def no_eval(reason: str) -> int:
        log(f"NO EVALUATION: {reason}")
        if not args.dry_run:
            ok, why = send_telegram(f"M2: no evaluation today — {reason}")
            log(f"telegram: {'sent' if ok else 'NOT sent — ' + why}")
        return 3

    key = tiingo_key()
    if not key:
        return no_eval("TIINGO_API_KEY not set")
    try:
        history = fetch_history(key, today)
        px, q_et = fetch_quote(key)
    except Exception as exc:  # noqa: BLE001
        return no_eval(f"Tiingo fetch failed ({exc})")

    log(f"history: {len(history)} sessions through {history[-1][0] if history else '-'} · "
        f"quote {px:.2f} at {q_et:%Y-%m-%d %H:%M} ET")
    if q_et.date() != today:
        return no_eval(f"IEX quote is from {q_et.date()}, not today")
    age = (now - q_et).total_seconds() / 60
    if age > STALE_MINUTES and not early and not args.allow_stale:
        return no_eval(f"IEX quote is {age:.0f} min old (limit {STALE_MINUTES})")

    state = load_state()
    sent_today = state["last_alerts"]["kinds"] if state["last_alerts"].get("date") == today.isoformat() else []

    alerts, new_state, ledger = evaluate(history, px, today.isoformat(), state,
                                         stamp=f"@{q_et:%H:%M} IEX", early_close=early,
                                         friday=today.weekday() == 4)
    m = new_state["metrics"]
    log(f"SPY {m['px']} · SMA200 {m['sma200']} (filter {'ON' if m['filter_on'] else 'OFF'}) · "
        f"SMA5 {m['sma5']} · streak {m['streak']} · in_trade {new_state['in_trade']}"
        f" (hold {new_state['hold_day']})")

    send_failed = False
    for kind, text in alerts:
        if kind in sent_today:
            log(f"{kind}: already sent today — not re-sent")
            continue
        log(f"ALERT {kind}: {text}")
        if args.dry_run:
            continue
        ok, why = send_telegram(text)
        log(f"telegram: {'sent' if ok else 'NOT sent — ' + why}")
        if ok:
            sent_today.append(kind)
        else:
            send_failed = True
    if not alerts:
        log("no alert today.")

    if args.dry_run:
        log("dry run: state and ledger NOT written.")
        return 0

    # A same-day re-run must not double-log. ENTER/EXIT change state so they cannot
    # repeat, but SETUP would; dedupe every event per session date to be safe.
    lg = state.get("last_logged") or {}
    logged_today = list(lg.get("events", [])) if lg.get("date") == today.isoformat() else []
    for row in ledger:
        if row["event"] in logged_today:
            log(f"ledger: {row['event']} already logged today — not re-logged")
            continue
        append_ledger(row)
        logged_today.append(row["event"])
    new_state["last_logged"] = {"date": today.isoformat(), "events": logged_today}
    new_state["last_alerts"] = {"date": today.isoformat(), "kinds": sent_today}
    new_state["last_run"] = datetime.now().isoformat(timespec="seconds")
    save_state(new_state)
    if send_failed:
        log("RESULT: evaluated and state written, but a Telegram send FAILED (exit 2).")
        return 2
    return 0


def manual_set(args) -> int:
    state = load_state()
    if args.set_flat:
        append_ledger({"event": "MANUAL_SET_FLAT", "session_date": et_now().date().isoformat(),
                       "strike": state.get("strike") or "", "reason": "manual override"})
        state.update({"in_trade": False, "entry_date": None, "entry_px": None, "strike": None,
                      "hold_day": 0, "updated_by": "manual"})
    else:
        try:
            d = datetime.strptime(args.set_in_trade, "%Y-%m-%d").date()
        except ValueError:
            print(f"bad date {args.set_in_trade!r} (YYYY-MM-DD)", file=sys.stderr)
            return 1
        append_ledger({"event": "MANUAL_SET_IN_TRADE", "session_date": d.isoformat(),
                       "spy_px": args.entry_px or "", "strike": args.strike or "",
                       "reason": "manual override"})
        state.update({"in_trade": True, "entry_date": d.isoformat(), "entry_px": args.entry_px,
                      "strike": args.strike, "hold_day": 0, "updated_by": "manual"})
    save_state(state)
    print(json.dumps(state, indent=2))
    return 0


# ============================================================================
# Selftest — offline, synthetic series, no network
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
            print(f"  FAIL {label} {detail}")

    series = _series
    flat = json.loads(json.dumps(FLAT_STATE))
    top = _TOP

    print("[1] streak + time helpers")
    check("streak 3", lower_close_streak([5, 4, 3, 2]) == 3)
    check("equal close breaks the streak", lower_close_streak([5, 4, 4, 3]) == 1)
    check("EST in January", et_now(datetime(2026, 1, 15, 20, 45, tzinfo=timezone.utc)).hour == 15)
    check("EDT in July", et_now(datetime(2026, 7, 15, 19, 45, tzinfo=timezone.utc)).hour == 15)
    check("Thanksgiving is not a session", not is_session(date(2026, 11, 26)))
    check("Saturday is not a session", not is_session(date(2026, 11, 28)))
    check("9-digit Tiingo stamp parses",
          _parse_ts("2026-11-25T15:44:58.186520297-05:00") is not None)

    print("[2] SETUP on 2 lower closes above the 200d")
    h = series([top + 1])
    a, st, led = evaluate(h, top + 0.5, "2026-12-01", flat)
    a, st, led = evaluate(series([top + 1, top + 0.5]), top + 0.2, "2026-12-02", flat)
    check("setup fires", [k for k, _ in a] == ["setup"], str(a))
    check("  wording is the bullish put", "SELL SPY PUT (bullish dip)" in a[0][1])
    check("  no state change", st["in_trade"] is False)
    check("  ledger SETUP row", [r["event"] for r in led] == ["SETUP"], str(led))

    print("[3] ENTER on the 3rd lower close, sets in_trade, first-only")
    h3 = series([top + 1, top + 0.5, top + 0.2])
    a, st, led = evaluate(h3, top - 0.1, "2026-12-03", flat)
    check("enter fires", [k for k, _ in a] == ["enter"], str(a))
    check("  in_trade set automatically", st["in_trade"] and st["entry_date"] == "2026-12-03")
    check("  strike = round(0.95 x px)", st["strike"] == round(0.95 * (top - 0.1)))
    check("  ledger ENTER row", led and led[0]["event"] == "ENTER")
    # forced flat by hand, streak continues to 4: must NOT re-fire on the same streak
    st_flat = {**st, "in_trade": False, "entry_date": None}
    h4 = h3 + [("2026-12-03", top - 0.1)]
    a4, _, _ = evaluate(h4, top - 0.3, "2026-12-04", st_flat)
    check("4th lower close on the same streak does NOT re-fire", not a4, str(a4))
    # streak resets (higher close) then a fresh 3-streak re-arms
    h5 = h4 + [("2026-12-04", top - 0.3), ("2026-12-07", top + 0.4),
               ("2026-12-08", top + 0.3), ("2026-12-09", top + 0.2)]
    a5, _, _ = evaluate(h5, top + 0.1, "2026-12-10", st_flat)
    check("a NEW streak re-arms ENTER", [k for k, _ in a5] == ["enter"], str(a5))

    print("[4] filter OFF blocks entries")
    low = [((date(2025, 1, 1) + timedelta(days=i)).isoformat(), 300 - 0.5 * i + (0.3 if i % 2 else 0))
           for i in range(260)]
    lowv = low[-1][1]
    lh = low + [("2026-12-01", lowv - 1), ("2026-12-02", lowv - 2)]
    a, st, _ = evaluate(lh, lowv - 3, "2026-12-03", flat)
    check("downtrend: no setup, no enter", not a, str(a))

    print("[5] EXIT")
    in_trade = {**flat, "in_trade": True, "entry_date": "2026-12-03", "strike": 600}
    hx = h3 + [("2026-12-03", top - 0.1)]
    a, st, led = evaluate(hx, top - 0.05, "2026-12-03", in_trade)
    check("no exit on the entry day (hold 0)", not a and st["in_trade"], str(a))
    a, st, led = evaluate(hx, top + 2, "2026-12-04", in_trade)
    check("exit when price > SMA5", [k for k, _ in a] == ["exit"] and "SMA5" in a[0][1], str(a))
    check("  clears in_trade + ledger EXIT", not st["in_trade"] and led[0]["event"] == "EXIT")
    falling = hx + [("2026-12-04", top - 1), ("2026-12-07", top - 2), ("2026-12-08", top - 3),
                    ("2026-12-09", top - 4)]
    a, st, led = evaluate(falling, top - 5, "2026-12-10", in_trade)
    check("exit on the 5th session even below SMA5",
          [k for k, _ in a] == ["exit"] and "5th session" in a[0][1], str(a))
    check("  hold day derived from the bars", led[0]["hold_day"] == 5, str(led))
    a, st, _ = evaluate(falling[:-1], top - 4, "2026-12-09", in_trade)
    check("hold 4 below SMA5: stays in", not a and st["in_trade"] and st["hold_day"] == 4, str(a))
    a, _, _ = evaluate(falling[:-1], top - 4.5, "2026-12-09", {**in_trade})
    check("in a trade, a deep streak raises no entry alert", all(k != "enter" for k, _ in a))

    print("[6] Friday weekly + early close")
    a, _, _ = evaluate(series([top + 1]), top + 2, "2026-12-04", flat, friday=True)
    check("weekly fires on Friday", any(k == "weekly" and "filter ON" in t for k, t in a), str(a))
    a, _, _ = evaluate(series([top + 1, top + 0.5]), top + 0.2, "2026-11-27", flat, early_close=True)
    check("early-close note appended", a and "closed early" in a[0][1], str(a))

    print("[7] IEX timestamp field order (lastSaleTimeStamp first)")
    _, t = quote_from_row({"tngoLast": 650.0, "lastSaleTimeStamp": "2026-12-01T15:40:00-05:00",
                           "timestamp": "2026-12-01T15:44:00-05:00"})
    check("capital-S lastSaleTimeStamp wins", t.strftime("%H:%M") == "15:40", str(t))
    _, t = quote_from_row({"tngoLast": 650.0, "timestamp": "2026-12-01T20:44:00+00:00"})
    check("falls back to timestamp", t.strftime("%H:%M") == "15:44", str(t))

    print("[8] parity fixture is current (lib/m2 is checked against it)")
    try:
        committed = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        committed = None
    check("strategies/m2/parity_fixture.json matches this file's output — "
          "re-run --emit-fixture after any logic change",
          committed == json.loads(json.dumps(build_fixture())))

    print(f"\n{'ALL PASS' if failed == 0 else 'FAILURES'} — {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


# ============================================================================
# Parity fixture — the contract lib/m2/signal.ts is held to
# ============================================================================

def _series(tail: Sequence[float], base: float = 100.0, n: int = 260) -> List[Tuple[str, float]]:
    """Uptrend (so price sits above SMA200), alternating so the streak is 0, then tail."""
    d0 = date(2025, 1, 1)
    vals = [base + 0.1 * i + (0.3 if i % 2 else 0) for i in range(n)] + list(tail)
    return [((d0 + timedelta(days=i)).isoformat(), v) for i, v in enumerate(vals)]


_TOP = 100 + 0.1 * 259 + 0.3  # last value of the base series (i=259 is odd)


def _fixture_cases() -> List[dict]:
    flat = json.loads(json.dumps(FLAT_STATE))
    top = _TOP
    h3 = _series([top + 1, top + 0.5, top + 0.2])
    h4 = h3 + [("2026-12-03", top - 0.1)]
    hx = h4
    falling = hx + [("2026-12-04", top - 1), ("2026-12-07", top - 2), ("2026-12-08", top - 3),
                    ("2026-12-09", top - 4)]
    # the 3-streak in h3 falls from its top+1 close — that bar's date is the streak id
    entered = {**flat, "last_entry_streak_id": h3[-3][0]}
    in_trade = {**flat, "in_trade": True, "entry_date": "2026-12-03", "strike": 600}
    low = [((date(2025, 1, 1) + timedelta(days=i)).isoformat(), 300 - 0.5 * i + (0.3 if i % 2 else 0))
           for i in range(260)]
    lowv = low[-1][1]
    c = [
        ("quiet", _series([top + 1]), top + 0.5, "2026-12-01", flat, False),
        ("setup", _series([top + 1, top + 0.5]), top + 0.2, "2026-12-02", flat, False),
        ("enter", h3, top - 0.1, "2026-12-03", flat, False),
        ("same streak no re-fire", h4, top - 0.3, "2026-12-04", entered, False),
        ("new streak re-arms", h4 + [("2026-12-04", top - 0.3), ("2026-12-07", top + 0.4),
                                     ("2026-12-08", top + 0.3), ("2026-12-09", top + 0.2)],
         top + 0.1, "2026-12-10", entered, False),
        ("filter off", low + [("2026-12-01", lowv - 1), ("2026-12-02", lowv - 2)], lowv - 3,
         "2026-12-03", flat, False),
        ("entry day hold 0", hx, top - 0.05, "2026-12-03", in_trade, False),
        ("exit sma5", hx, top + 2, "2026-12-04", in_trade, False),
        ("exit 5th session", falling, top - 5, "2026-12-10", in_trade, False),
        ("hold 4 stays", falling[:-1], top - 4, "2026-12-09", in_trade, False),
        ("friday weekly", _series([top + 1]), top + 2, "2026-12-04", flat, True),
        ("equal close breaks streak", _series([top + 1, top + 0.5]), top + 0.5, "2026-12-02", flat, False),
    ]
    # Strike rounding: Python round() is half-to-even; these hit exact .5 products.
    for px in (610.0, 630.0, 650.0, 670.0, 641.3):
        c.append((f"strike rounding {px}", _series([], base=px - 40), px, "2026-12-01", flat, False))
    out = []
    for name, hist, px, today, state, friday in c:
        alerts, st, led = evaluate(hist, px, today, state, friday=friday)
        sma200 = plain_sum(([v for _, v in hist] + [px])[-SMA_FILTER:]) / SMA_FILTER
        sma5 = plain_sum(([v for _, v in hist] + [px])[-SMA_EXIT:]) / SMA_EXIT
        out.append({
            "name": name, "history": [[d, v] for d, v in hist], "px": px, "today": today,
            "friday": friday, "state": state,
            "expected": {
                "kinds": [k for k, _ in alerts],
                "sma200": sma200, "sma5": sma5,
                "streak": st["metrics"]["streak"], "filter_on": st["metrics"]["filter_on"],
                "strike": round(STRIKE_MULT * px),
                "state": {k: st.get(k) for k in ("in_trade", "entry_date", "strike", "hold_day",
                                                 "last_entry_streak_id")},
                "ledger": [{"event": r["event"], "hold_day": r["hold_day"], "strike": r["strike"]}
                           for r in led],
            },
        })
    return out


def build_fixture() -> dict:
    quotes = [
        {"tngoLast": 650.12, "lastSaleTimeStamp": "2026-12-01T15:44:58.186520297-05:00",
         "timestamp": "2026-12-01T15:45:01-05:00"},
        {"tngoLast": 650.12, "lastSaleTimestamp": "2026-12-01T20:40:00Z", "timestamp": "2026-12-01T20:44:00Z"},
        {"tngoLast": None, "last": 649.5, "timestamp": "2026-07-15T19:45:30.5+00:00"},
        {"tngoLast": 651.0, "timestamp": "2026-03-09T13:31:00+00:00"},
    ]
    qx = []
    for q in quotes:
        px, et = quote_from_row(q)
        qx.append({"row": q, "expected": {"px": px, "et": et.strftime("%Y-%m-%dT%H:%M:%S")}})
    utcs = ["2026-01-15T20:45:00", "2026-07-15T19:45:00", "2026-03-08T06:59:00", "2026-03-08T07:00:00",
            "2026-11-01T05:59:00", "2026-11-01T06:00:00"]
    return {
        "_comment": "GENERATED by `python strategies/m2/m2_alert.py --emit-fixture`. Do not edit. "
                    "scripts/m2-parity-check.ts asserts lib/m2/signal.ts reproduces every expected value.",
        "constants": {"sma_filter": SMA_FILTER, "sma_exit": SMA_EXIT, "max_hold": MAX_HOLD,
                      "strike_mult": STRIKE_MULT, "stale_minutes": STALE_MINUTES,
                      "quote_ts_fields": list(QUOTE_TS_FIELDS)},
        "streak": [{"closes": cl, "expected": lower_close_streak(cl)}
                   for cl in ([5, 4, 3, 2], [5, 4, 4, 3], [1, 2, 3], [3, 2, 1, 1], [9])],
        "et_now": [{"utc": u, "expected": et_now(datetime.fromisoformat(u).replace(tzinfo=timezone.utc))
                    .strftime("%Y-%m-%dT%H:%M:%S")} for u in utcs],
        "is_session": [{"date": d, "expected": is_session(date.fromisoformat(d))}
                       for d in ("2026-11-26", "2026-11-27", "2026-11-28", "2026-12-25", "2027-03-26",
                                 "2027-03-29")],
        "quotes": qx,
        "evaluate": _fixture_cases(),
    }


def emit_fixture() -> int:
    # One record per line: readable diffs without a line per bar (260-bar histories).
    fx = build_fixture()
    parts = []
    for k, v in fx.items():
        if isinstance(v, list):
            body = ",\n".join("  " + json.dumps(x, separators=(",", ":")) for x in v)
            parts.append(f" {json.dumps(k)}: [\n{body}\n ]")
        else:
            parts.append(f" {json.dumps(k)}: {json.dumps(v)}")
    FIXTURE_PATH.write_text("{\n" + ",\n".join(parts) + "\n}\n", encoding="utf-8")
    print(f"wrote {FIXTURE_PATH}")
    return 0


# ============================================================================

def main(argv: Optional[Sequence[str]] = None) -> int:
    global _LOG_FILE
    p = argparse.ArgumentParser(description="M2 SPY mean-reversion paper alert (alerts only).")
    p.add_argument("--dry-run", action="store_true", help="Evaluate and print; no send, no state write.")
    p.add_argument("--allow-stale", action="store_true",
                   help="Evaluate even on a stale IEX quote (testing only).")
    p.add_argument("--set-flat", action="store_true", help="Manual override: mark flat.")
    p.add_argument("--set-in-trade", metavar="YYYY-MM-DD", help="Manual override: in a trade since DATE.")
    p.add_argument("--entry-px", type=float, default=None)
    p.add_argument("--strike", type=float, default=None)
    p.add_argument("--status", action="store_true", help="Print the state file and exit.")
    p.add_argument("--selftest", action="store_true", help="Offline logic checks.")
    p.add_argument("--emit-fixture", action="store_true",
                   help="Write strategies/m2/parity_fixture.json for the lib/m2 parity check.")
    args = p.parse_args(argv)

    if args.selftest:
        return selftest()
    if args.emit_fixture:
        return emit_fixture()
    if args.status:
        print(json.dumps(load_state(), indent=2))
        return 0
    if args.set_flat or args.set_in_trade:
        return manual_set(args)

    _LOG_FILE = LOG_DIR / f"m2_{datetime.now():%Y%m%d}.log"
    try:
        return run(args)
    except Exception as exc:  # noqa: BLE001 — an unattended job must log, not stack-trace
        import traceback
        log(f"ERROR: {type(exc).__name__}: {exc}")
        for row in traceback.format_exc().splitlines():
            log(f"  | {row}")
        if not args.dry_run:
            send_telegram(f"M2: run crashed — {type(exc).__name__}: {exc}"[:500])
        return 1


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
    sys.exit(main())
