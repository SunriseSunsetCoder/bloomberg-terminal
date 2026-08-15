# JACK — "Second-Chance" recovery-entry alert — Implementation Spec

**For: Claude Code on the Win10 dev box (`C:\Repos\bloomberg-terminal`).**
**Type: new EOD alert (Telegram) + one pure eval module + selftests. Read-only w.r.t. strategy state — no `decisions.section` writes, no signal/board changes.**
**Ship as its OWN commit, separate from the Basket Sizer. Not a new primary entry signal — a recovery signal for MISSED setups.**

---

## Goal

Alert when a setup that **fired but was never traded** pulls back to its **original entry price** while still LIVE — a chance to re-enter a missed setup at the restored original R:R. Backtested full-universe (16,184 v2b fires, `cup_handle_15yr_history_1.ipynb` + the second-chance cell): re-entering on the pullback returns **+0.32R / PF 1.83** overall, and **+0.327R / WR 64.4% / PF 1.926** at the recommended gate (run-up ≥25% toward t05, 10-bar window). This is **recovery of a missed entry**, NOT a replacement for the normal EOD entry (waiting-for-a-pullback as a replacement is *worse* — it sheds the ~12% of setups that run straight to target and never look back). Message it as such.

---

## Where it runs

The **18:00–18:15 ET EOD pass** (`lib/jack/price-schedule.ts`), right alongside `evaluateEntryConfirmations`. It's a daily-bar signal, so EOD only — never intraday. Guarded by the same `isTradingDay(now)` gate and once-per-ET-day Redis marker the EOD block already uses.

---

## Trigger — exact parity with the backtest

For each setup in the **run-scoped, owned-excluded PENDING set** (`getPendingSetups()` via `getCurrentRunId`/`getCurrentBoard`), that is **tradeable** (`isTradeableSetup({sizeBucket,tier})` — the SKIP gate; Q1/Q2 never qualify) and has **fired** (`fired_at` set, i.e. a prior close-confirmed fire), fire the recovery alert when ALL hold. Use the **shared helpers** so it can't drift from the book: `fetchDailyBars`, and the fire/exit primitives in `lib/jack/outcome-tracker.ts`.

Let `entry` = the confirmed fill (next open after the fire close — same value the entry alert used), `stop` = setup stop, `t05` = `breakout + 0.5×(full_target − breakout)`. Let `ei` = the entry bar index; walk daily bars from `ei` through today:

1. **Still LIVE — never hit target:** `max(high[ei..today]) < t05`. (If it ever tagged t05 → opportunity gone; do NOT alert. If it already resolved, the existing `entry_resolved` guard covers it.)
2. **Still LIVE — never stopped:** `min(low[ei..today]) > stop`.
3. **Ran up first:** at some bar in `(ei, today)`, `high ≥ entry + RUNUP_FRAC×(t05 − entry)` (default `RUNUP_FRAC = 0.25`). This is the "R:R decayed, now recovered" condition — without a prior run-up it's not a second chance, just a setup sitting at entry.
4. **Pulled back to entry TODAY:** `low[today] ≤ entry` (the retest touched the original entry level today — a limit at `entry` would fill).
5. **Fresh:** `today − ei ≤ RETEST_WINDOW_BARS` in trading bars (default `RETEST_WINDOW_BARS = 10`; the sweep showed the tightest window carries the best PF).

All five → **SYSTEM alert: recovery re-entry available.** Constants `RUNUP_FRAC` and `RETEST_WINDOW_BARS` are named exports so they're tunable in one place.

**Optional early-warning (Phase 2, off by default):** a HEADS-UP the evening *before* the touch — condition 4 replaced by `close[today]` within `NEAR_ENTRY_PCT` (~2%) *above* entry and not yet touched — footer-labeled "approaching, arm your limit." Keep separate from the SYSTEM trigger; do not build in Phase 1.

---

## Telegram message

Existing bot, existing trade channel (`-1003974425876`). New alert `type = 'second_chance'`, **SYSTEM** category (it's backtested, not a heads-up). Include P-rank via `getPriorityRanks()`. Format, e.g.:

```
🔁 SECOND CHANCE — {TICKER}  (P{n} · {tier})
Missed setup pulled back to entry — re-entry available.
Entry (limit): {entry}   Stop: {stop}   Target(t05): {t05}
R:R ≈ {rr}   ·  {bars_since_entry} bars since fire  ·  ran up {runup_pct}% then retested
Never hit target, never stopped — still live.
— recovery signal (backtested +0.32R / PF 1.83); restores original R:R, does not improve it.
```

`rr = (t05 − entry)/(entry − stop)`. Keep the footer caveat — it's a recovery of a missed entry, not the primary signal.

**Dedup:** once-per-setup, `jack:alert:second_chance:{TICKER}:{handle_low_date}`, **no TTL**, checked BEFORE the bar fetch, marker set only on a successful send (same pattern as `entry_confirmed`). A setup gets at most one recovery ping — if it pulls back, bounces, and pulls back again, we don't re-spam.

---

## Reuse map / new code

- **Reuse:** `getPendingSetups`, `getCurrentRunId`/`getCurrentBoard`, `getPriorityRanks`, `isTradeableSetup`, `fetchDailyBars` + the fire/exit primitives in `outcome-tracker.ts`, `fireOnce`/`entryMarkerKey`-style dedup + the Telegram send path in `alerts.ts`. Rimless setups skipped (no rim → no fire → not in scope anyway); bars-fetch failure → `second_chance_bars_fetch` OPERATIONAL alert.
- **New pure module** `lib/jack/second-chance.ts` — `evalSecondChance(setup, bars, {runupFrac, windowBars})` returns `{ eligible, reason, entry, stop, t05, rr, barsSinceEntry, runupPct }` or a not-eligible reason code (`hit_target` / `stopped` / `no_runup` / `no_retest` / `stale` / `resolved`). PURE (no DB, no network, no Telegram) so it's unit-testable. Plus `evaluateSecondChance(...)` wiring that pulls the pending set, calls the pure eval per setup, dedups, and sends — mirroring `evaluateEntryConfirmations`.
- **Wire** `evaluateSecondChance` into the EOD block in `price-schedule.ts`, after `evaluateEntryConfirmations`.

---

## Guardrails

Read-only w.r.t. strategy: no writes to `decisions.section`, no board/signal/outcome changes, no new DB columns needed (reads `fired_at` + geometry that already exist). Alert-only. Never says "buy" on a Q1/Q2 SKIP (the `isTradeableSetup` gate), never on a setup that hit target or stopped, never outside the freshness window. Graceful disable / never throws, like the other alert evaluators.

---

## Selftests (`scripts/jack-second-chance-selftest.ts`, pure)

Feed synthetic daily-bar fixtures to `evalSecondChance`:

- **Fires** when: ran up ≥25% toward t05, then today's low ≤ entry, within 10 bars, never hit t05, never hit stop, tradeable.
- **Does NOT fire** when: target ever tagged (`hit_target`); stop ever tagged (`stopped`); no prior run-up (`no_runup`); today's low never reached entry (`no_retest`); pullback happens on bar 11+ (`stale`); setup is Q1/Q2 SKIP (`isTradeableSetup` false); setup is owned.
- **R:R exactly reproduces** `(t05−entry)/(entry−stop)`; `runupPct` and `barsSinceEntry` correct.
- **Dedup:** second eval for the same `{TICKER, handle_low_date}` after a successful send does not re-fire.
- **Parity anchor:** on a fixture where the pullback+continuation hits t05, the re-entry R computed from `entry/stop/t05` matches a `findTouchExit` run from the retest bar (same engine, no drift).

Run it plus the full suite; show the diff + green output; **stop for review before deploy.**

---

## Deploy (its own commit, after the Basket Sizer is out)

Explicit paths only (`lib/jack/second-chance.ts`, `scripts/jack-second-chance-selftest.ts`, the `price-schedule.ts` + `alerts.ts` edits) — never `git add -A`. `git commit --no-verify` → `$env:BYPASS_PUSH_PROTECTION="1"` on its own line → push → confirm `git log -1` → VPS `git pull` → restart `npm run dev`. No deps, no migration. **First live run:** watch the trade channel at the next 18:00 ET for correctly-gated recovery pings (and none on SKIP / resolved / stale setups).

---

## To verify against the actual code before building

- Confirm how the entry alert derives `entry` (next open after the fire close) and reuse that exact derivation for `ei`/`entry` — the two must agree.
- Confirm `fetchDailyBars` window covers from the fire/entry date through today (extend if it's bounded shorter).
- Confirm `getPendingSetups` rows carry `fired_at`/`fire_bar`, `stop`, `breakout`, `full_target` (or `t05`) — the fields the eval needs; if `t05` isn't on the row, compute it from `breakout` + `full_target` the same way the board/entry alert does.
