# JACK — "Second-Chance" recovery-entry alert — Implementation Spec (as built)

**For: Claude Code on the Win10 dev box (`C:\Repos\bloomberg-terminal`).**
**Type: new EOD alert (Telegram) + one pure eval module + selftests. Read-only w.r.t. strategy state — no `decisions.section` writes, no signal/board changes.**
**Ship as its OWN commit, separate from the Basket Sizer. Not a new primary entry signal — a recovery signal for MISSED setups.**

> **Revision — fires on the ARMED state, not on the retest.** The original draft triggered on "pulled back to entry *today*". That is unusable in practice: the pass reads **daily** bars at 18:00, so a retest-day alert lands the evening *after* the intraday fill it describes — too late to place the order that produces the backtested fill. The run-up, by contrast, is a **persistent** state (max-high-since-entry crosses the threshold once and stays crossed), so it is reliably detectable at EOD. The alert therefore fires when a setup becomes **ARMED** — run-up banked, pullback still ahead — and the operator answers it with a **resting BUY limit at `entry`**, which catches the intraday pullback at the exact backtest price. Same trades, same fills, same 0.25 / 10-bar config; only the alert *moment* moved, from after-the-fact to actionable. Sections below are the as-built design.

---

## Goal

Alert when a setup that **fired but was never traded** has run up and is now positioned to pull back to its **original entry price** while still LIVE — a chance to re-enter a missed setup at the restored original R:R. Backtested full-universe (16,184 v2b fires, `cup_handle_15yr_history_1.ipynb` + the second-chance cell): re-entering on the pullback returns **+0.32R / PF 1.83** overall, and **+0.327R / WR 64.4% / PF 1.926** at the recommended config (run-up ≥25% toward t05, 10-bar window). This is **recovery of a missed entry**, NOT a replacement for the normal EOD entry (waiting-for-a-pullback as a replacement is *worse* — it sheds the ~12% of setups that run straight to target and never look back). Message it as such.

---

## Where it runs

The **18:00–18:15 ET EOD pass** (`lib/jack/price-schedule.ts`), right alongside `evaluateEntryConfirmations`. It's a daily-bar signal, so EOD only — never intraday. Guarded by the same `isTradingDay(now)` gate and once-per-ET-day Redis marker the EOD block already uses.

EOD is sufficient *because of the arming trigger*: arming is a monotone, persistent state, so seeing it a few hours after the close costs nothing. (The retest, by contrast, is an intraday event; the whole point of the revision is that we no longer try to detect it.) The operator's resting limit is what spans the gap between the EOD ping and the intraday pullback.

---

## Trigger — the ARMED state

**Candidate pool:** the full **run-scoped, owned-excluded board** — `getCurrentBoard()` → `[...live, ...pending]`, `retiredAt == null`, not owned, `isTradeableSetup({sizeBucket,tier})` (the SKIP gate; Q1/Q2 never qualify), and in the board's LIVE display group (`isInLiveDisplayGroup`).

> ⚠️ **Deliberately NOT `getPendingSetups()`** (which the original draft called for). That accessor returns `section='pending'` rows only, so a validated-LIVE setup never appears in it — the same trap that made the Basket Sizer render blank while the board showed LIVE (10).

**Fire gate:** the **shared `detectFire`** from `outcome-tracker.ts`, run over the bars we already fetch — **not** the `fired_at` column. The EOD pass only stamps `fired_at` on pending rows, so gating on it would silently exclude most of the board. `detectFire` also yields the entry price, so the quoted limit cannot disagree with the book.

Let `entry` = the confirmed fill (next open after the fire close — the same derivation the entry alert and `replaySetup` use), `stop` = setup stop, `t05` = the setup's target. Let `ei` = the entry bar index; walk daily bars from `ei` through today:

1. **Still LIVE — never hit target:** `max(high[ei..today]) < t05`. (If it ever tagged t05 → the trade worked without you; nothing left to recover.)
2. **Still LIVE — never stopped:** `min(low[ei..today]) > stop`.
3. **ARMED:** `max(high[ei..today]) ≥ entry + RUNUP_FRAC × (t05 − entry)` (default `RUNUP_FRAC = 0.25`). This is the "R:R has decayed, a pullback would restore it" condition — without a prior run-up it isn't a second chance, just a setup sitting near entry.
4. **Pullback still AHEAD:** no bar **strictly after `ei`** has `low ≤ entry`. If one has, the pullback already came and went and a limit placed tonight is chasing a past event. **The `ei` bar itself is excluded on purpose** — a bar that opens *at* `entry` almost always trades under it, so counting the entry bar would disqualify every setup.
5. **Fresh:** `today − ei ≤ RETEST_WINDOW_BARS` in trading bars (default `RETEST_WINDOW_BARS = 10`; the sweep showed the tightest window carries the best PF). This doubles as the life of the resting order.

All five → **SYSTEM alert: place a resting BUY limit at `entry`.** Reason codes for the not-eligible cases, in gate order: `missing_geometry` → `not_fired` → `no_entry_bar` → `hit_target` → `stopped` → `not_armed` → `already_retested` → `stale`. Constants `RUNUP_FRAC` and `RETEST_WINDOW_BARS` are named exports so they're tunable in one place.

**Optional early-warning (Phase 2, not built):** a HEADS-UP when `close[today]` is within `NEAR_ENTRY_PCT` (~2%) *above* entry — footer-labeled "approaching, arm your limit." Largely subsumed by the ARMED trigger, which already fires ahead of the pullback; revisit only if the arming ping proves too early in practice.

---

## Telegram message

Existing bot, existing trade channel (`-1003974425876`). Alert `type = 'second_chance'`, **SYSTEM** category (it's backtested, not a heads-up). Includes P-rank via `getPriorityRanks()`. The message is an **instruction to place an order**, not a report that something happened:

```
🔫 ARMED — {TICKER}  (P{n} · {tier})
Ran up {runup_pct}% toward t05 since firing, still live + un-traded.
Place a resting BUY limit: entry {entry}  ·  stop {stop}  ·  target(t05) {t05}  ·  R:R {rr}
Cancel if unfilled by {cancel_by}.
recovery of a missed entry; restores original R:R, doesn't improve it (backtested +0.33R / PF 1.93)
```

`rr = (t05 − entry)/(entry − stop)`. `cancel_by = entryDate + RETEST_WINDOW_BARS` **trading** days (`addTradingDaysISO`, weekends + NYSE holidays skipped) — calendar days would leave a GTC order alive past the window by a weekend every time. Keep the footer caveat: it's a recovery of a missed entry, not the primary signal.

**Dedup:** once-per-setup, `jack:alert:second_chance:{TICKER}:{handle_low_date}`, **no TTL**, checked BEFORE the bar fetch, marker set only on a successful send (same pattern as `entry_confirmed`). A setup **arms once** — max-high crosses the threshold a single time and stays crossed — so this maps naturally to one ping per setup for its lifetime.

---

## Reuse map / new code

- **Reuse:** `getCurrentBoard` (via `getCurrentRunId`), `getPriorityRanks`, `isTradeableSetup`, `isInLiveDisplayGroup`, `fetchDailyBars` + `detectFire`/`findTouchExit` in `outcome-tracker.ts`, `fireOnce`/`entryMarkerKey`-style dedup + the Telegram send path in `alerts.ts`. Rimless setups skipped (no rim → no fire → out of scope anyway); bars-fetch failure → `second_chance_bars_fetch` OPERATIONAL alert.
- **New pure module** `lib/jack/second-chance.ts` — `evalSecondChance(setup, bars, {runupFrac, windowBars})` returns `{ eligible, reason, entry, stop, t05, rr, barsSinceEntry, runupPct, armed, fireDate, entryDate, todayDate, entryIndex }`. PURE (no DB, no network, no Telegram) so it's unit-testable.
- **New in `alerts.ts`:** `evalSecondChanceAlert(...)` (pure message builder) and `evaluateSecondChance(...)` wiring that pulls the board set, calls the pure eval per setup, dedups, and sends — mirroring `evaluateEntryConfirmations`. Plus `addTradingDaysISO` for the cancel-by date.
- **Wire** `evaluateSecondChance` into the EOD block in `price-schedule.ts`, after `evaluateEntryConfirmations`.

**t05 note.** The draft's `breakout + 0.5×(full_target − breakout)` does not apply to this schema: there is no `full_target` column, and `setups.t05_target` **is** the t05 (the strategy targets breakout + 0.5× cup depth). Halving it again would understate every advertised R:R, so `t05 = row.target`.

---

## Guardrails

Read-only w.r.t. strategy: no writes to `decisions.section`, no board/signal/outcome changes, no new DB columns. Alert-only. Never says "place a limit" on a Q1/Q2 SKIP (the `isTradeableSetup` gate), never on a setup that hit target or stopped, never outside the freshness window. Per-setup try/catch and its own try/catch at the call site, so it can never suppress the entry or exit alerts. Graceful disable / never throws, like the other alert evaluators.

---

## Selftests (`scripts/jack-second-chance-selftest.ts`, pure)

Feed synthetic daily-bar fixtures to `evalSecondChance`:

- **Fires** when: armed (ran up ≥25% toward t05), no post-entry low ≤ entry, within 10 bars, never hit t05, never hit stop, tradeable, not owned.
- **Does NOT fire** when: target ever tagged (`hit_target`); stop ever tagged (`stopped`); run-up below the threshold (`not_armed`); a post-entry bar already traded down through entry (`already_retested`); armed on bar 11+ (`stale`); never fired (`not_fired`); missing geometry; setup is Q1/Q2 SKIP (`isTradeableSetup` false); setup is owned.
- **Boundaries:** run-up exactly at the 25% line arms (`≥`, and one cent under does not); a post-entry low exactly `== entry` counts as retested (`≤`, and one cent above still fires); `today − ei == 10` fires, `== 11` is stale.
- **The `ei`-bar exclusion:** the fixture's entry bar has `low < entry`, and the setup must still fire — without the strictly-after-`ei` guard nothing would ever arm.
- **Ordering:** a bar that blows through entry *and* the stop reports `stopped`, not `already_retested`; an `already_retested` result still reports `armed === true`.
- **R:R exactly reproduces** `(t05−entry)/(entry−stop)`; `runupPct` and `barsSinceEntry` correct.
- **Cancel-by:** `addTradingDaysISO` skips weekends (≠ +n calendar days) and agrees with the real NYSE calendar.
- **Dedup:** a second eval for the same `{TICKER, handle_low_date}` after a successful send does not re-fire.
- **Parity anchor:** continue the armed fixture through the pullback it anticipates — the resting limit fills at `entry`, `findTouchExit` from that bar reaches t05, the resulting R matches the advertised R:R, and the walk from the *original* entry bar resolves to the same exit price. The economics are unchanged; only the alert moment moved.

Run it plus the full suite; show the diff + green output; **stop for review before deploy.**

---

## Deploy (its own commit, after the Basket Sizer is out)

Explicit paths only (`lib/jack/second-chance.ts`, `scripts/jack-second-chance-selftest.ts`, the `price-schedule.ts` + `alerts.ts` edits, this spec) — never `git add -A`. `git commit --no-verify` → `$env:BYPASS_PUSH_PROTECTION="1"` on its own line → push → confirm `git log -1` → VPS `git pull` → restart `npm run dev`. No deps, no migration.

**First live run:** watch the trade channel at the next 18:00 ET for correctly-gated ARMED pings (and none on SKIP / resolved / already-retested / stale setups). The pass logs a reason histogram every evening regardless of whether anything fires — if everything reads `not_fired` the candidate pool is wrong; if everything reads `not_armed` or `already_retested`, the gate is working and the board simply has nothing armed. Expect zero pings on most days.

**If a pre-revision pass already ran:** the dedup marker shape is unchanged, so any setup that received a retest-day ping under the old trigger holds a marker and will never receive its ARMED ping. Clear `jack:alert:second_chance:*` to reset.

---

## Verified against the actual code

- `entry` derivation (next open after the fire close) comes from the shared `detectFire`, so the alert and the paper replay cannot quote different fills.
- `fetchDailyBars` covers from the handle-low date through today — wide enough for the `ei..today` walk.
- Board rows carry `stop`, `breakout`, `target` (= t05), `tier`, `sizeBucket`, `handleLowDate` — the fields the eval needs. There is no `full_target` column; see the t05 note above.
