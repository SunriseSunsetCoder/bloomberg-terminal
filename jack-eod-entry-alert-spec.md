# JACK — EOD Close-Confirmed Entry Alert — Implementation Spec

**For: Claude Code on the Win10 dev box (`C:\Repos\bloomberg-terminal`).**
**Type: code-only change (no new deps). Deploys via the normal two-box flow.**

---

## Why this exists (the problem)

Today the alert layer announces *exits* at the 18:00 ET EOD run (stop-hit, target-hit,
time-stop, earnings) but has **no EOD entry alert**. The only entry signal is the
intraday HEADS-UP entry-trigger (`prevClose < breakout AND tngoLast >= breakout`),
which is footer-labeled "not a system signal" because it fires on an *intraday cross*
that frequently reverses before the close.

The backtest that produces the frozen 2.90 raw-R reference fires on a **daily CLOSE
strictly above the rim** within the 15-bar confirm window, and fills the **next day's
open**. Because the board's PENDING→LIVE state is only recomputed on a full VALIDATE
re-run (weekly, Friday), real fires that happen Mon–Thu are invisible until the weekly
snapshot — by which point the trade is either extended or has pulled back and reads
pending again. Net effect: the operator misses parity entries, and the JSCORE
live-realized arm (A) drifts below the paper arm (B) as pure execution slippage.

**This feature closes that gap:** at the 18:00 EOD run, for each pending, in-window
setup whose *close today* is strictly above its rim, fire a SYSTEM alert telling the
operator to buy the next session's open — exactly the backtest fire/fill.

---

## Hard parity mandate (read first — do not skip)

**DO NOT re-implement the fire rule.** The fire condition already lives in
`replaySetup` (the JSCORE paper-replay arm), corrected in the 2026-07-31 replay-parity
fix: `CONFIRM_WINDOW_BARS = 15`, strict `close > breakout`, search anchored on the
**first bar dated strictly after `handle_low_date`** (NOT index 0 — a weekend handle
low makes `bars[0]` already h_idx+1), status resolves to `fired | deferred | never_fired`.

If the alert re-implements this independently, the alert and the paper arm **will**
drift and you'll have re-created the exact class of bug the parity fix removed.

**Required first step:** locate the fire-detection logic inside `replaySetup` (likely
in `lib/jack/outcome-tracker.ts` or a sibling in `lib/jack/`). If it is not already a
standalone, reusable helper, **extract it** into one, e.g.:

```
detectFire(bars, handleLowDate, breakout): {
  status: 'fired' | 'deferred' | 'never_fired',
  fireBarIndex: number | null,   // 1-based bar count since handle low (1 = first bar after handle_low_date)
  fireClose: number | null,
  fireDate: string | null        // et date of the confirming close
}
```

…and refactor **both** `replaySetup` **and** the new EOD entry alert to call it. That
makes parity structural — they cannot disagree. Confirm the existing 48-check replay
selftest still passes after the extraction (behavior must be identical).

---

## Where it hooks

The 18:00 ET EOD SYSTEM path in the alerts monitor (same pass that emits stop/target/
time-stop/earnings; rides the price-refresh scheduler). Note the input-set difference:

- **Existing exit alerts** iterate **OWNED positions**.
- **This entry alert** iterates the **PENDING setup set** — a *new loop*.

Use the existing **run-scoped, owned-excluded** pending set from the 2026-07-26 alert
pending-set fix (`getCurrentRunId` / `getCurrentBoard` → latest run with ≥1 decision;
owned-exclusion = currently-owned). Do **not** hand-roll a pending query — reuse
`getPendingSetups()` (or whatever the fix left as the canonical accessor) so this stays
run-scoped and never fires on retired/stale setups. Verify the actual symbol names in
the repo before wiring.

---

## Per-setup logic (inside the new EOD loop)

For each eligible pending setup:

1. **Rim required.** If `breakout_level` is NULL (the pre-7/17 rimless cohort), **skip**
   — cannot confirm a close-above-rim. Do not throw. (Optionally count skipped-for-null
   and include in the OPERATIONAL summary.)

2. **Get the daily bars** through today from the **same EOD source the outcome tracker
   already uses** (Tiingo EOD). **Use the official daily CLOSE — never `tngoLast` / the
   intraday value.** Using the intraday value would reproduce the noisy HEADS-UP behavior
   this feature is meant to replace.

3. **Run `detectFire(bars, handle_low_date, breakout_level)`.**
   - `never_fired` (window of 15 bars elapsed, no confirming close) → no entry alert.
     (Optional, out of MVP scope: a one-time "window expired unfired" info note.)
   - `deferred` (still inside window, not yet closed above rim) → no alert; it may fire
     a later day.
   - `fired` → proceed to step 4.

4. **De-dupe (once per setup, not once per day).** Entry confirmation is a one-time
   lifetime event, unlike the daily approaching-stop alerts. So the anti-spam marker
   must be keyed on **setup identity, not et-date**:

   ```
   jack:alert:entry_confirmed:{TICKER}:{handle_low_date}
   ```

   (Use the same ticker+handle_low_date normalization the ingest/backfill helpers use.)
   Set a long/no TTL so it fires **exactly once** per setup. Follow the existing
   discipline: **set the marker only on a successful send.** If the marker already
   exists → skip.

5. **Parity vs late-entry distinction** (directly serves the operator's problem):
   - `fireDate === today` → **ENTRY CONFIRMED**, message says *buy next session's open*
     (this is on-parity).
   - `fireDate < today` (fired earlier, still in window, marker not yet set — e.g. first
     run after deploy) → **LATE ENTRY**, message says *fired {fireDate}, N sessions ago;
     entering now is OFF-parity vs the backtest*. Still fire it once (it surfaces exactly
     the missed entries), but label it honestly so the operator knows the slippage.

---

## Alert message (SYSTEM tier)

Reuse the existing SYSTEM formatter/fields for consistency (tier, P-rank, stop,
t05_target, shares/size bucket — whatever the exit alerts already include). Shape:

```
✅ ENTRY CONFIRMED — {TICKER}
Close {close} > rim {breakout_level}  (bar {fireBarIndex}/15 since handle low {handle_low_date})
ACTION: buy next session's OPEN  (backtest fill)
{tier} · P{priority} · stop {stop} · t05 {t05_target} · size {sizeBucket}
```

Late-entry variant header/action:
```
⚠️ LATE ENTRY — {TICKER}  (fired {fireDate}, {N} sessions ago — OFF-parity)
```

Footer: mark this as a **system signal** (explicitly the opposite of the HEADS-UP
entry-trigger's "not a system signal" footer), so the operator knows this one is
actionable. Same Telegram trade channel (`-1003974425876`).

---

## Optional (nice-to-have, not required for MVP)

Once `entry_confirmed` fires for a setup, the intraday HEADS-UP entry-trigger for that
same ticker+handle_low_date is redundant. If cheap, suppress it (check the
`entry_confirmed` marker before sending the HEADS-UP entry-trigger). Skip if it
complicates the HEADS-UP path.

---

## Failure discipline (match existing alert code)

Never throws. Missing rim → skip. EOD fetch failure → reuse the existing OPERATIONAL
alert path (don't invent a new one). Redis failure → graceful, no crash. A failure on
one setup must not abort the rest of the loop or the other EOD alerts.

---

## Selftest (add `scripts/jack-entry-alert-selftest.ts`, pure-function, mirror the JSCORE/replay selftest style)

Cover, at minimum:

1. Close strictly above rim, within window, no prior marker → **FIRES** (close 101, rim 100, bar 3/15).
2. Close **equal** to rim → **no fire** (strict `>`; close 100.00, rim 100.00).
3. Close below rim within window → **no fire**.
4. Intraday **high** above rim but **close** below → **no fire** (proves it uses CLOSE, not high/last — the core point).
5. Close above rim but window **elapsed** (bar 16+) → **no fire** (`never_fired`).
6. Close above rim, within window, **marker already set** → **no fire** (once-only).
7. Rim NULL → **skip**, no fire, no throw.
8. Currently-**owned** ticker → **excluded**, no fire.
9. Setup not in the current run-scoped board → **excluded**.
10. Bar anchoring: handle_low_date on a Fri/weekend → first bar dated after it is **bar 1** (must match `detectFire`'s anchor, not index 0).
11. Boundary: bar **exactly 15/15**, close > rim → **FIRES**; bar **16** → `never_fired`.
12. `fireDate === today` → CONFIRMED wording; `fireDate < today` → LATE-ENTRY wording.

Also: re-run the existing **48-check replay-parity selftest** and all 14 selftests —
they must stay green after the `detectFire` extraction.

---

## First-run behavior to expect (call out to the operator)

On the first 18:00 run after deploy, any pending in-window setup already closing above
its rim will fire — as **LATE ENTRY** if its fire bar was a prior day. This is a
one-time catch-up burst and is *desired*: it surfaces exactly the entries that were
being missed. After that, each setup alerts once, on its confirming close.

---

## Deploy (two-box, code-only — no `npm install`)

1. Author + commit on Win10 dev (`C:\Repos\bloomberg-terminal`). Run the new selftest
   + existing selftests green **before** committing.
2. Push to main: commit, then on its own line `$env:BYPASS_PUSH_PROTECTION="1"`, then
   `git push`. (Direct-to-main-with-bypass is the reliable path.)
3. VPS (`C:\Users\Administrator\Desktop\bloomberg-terminal`): `git pull` → restart
   `npm run dev`. No rebuild/`npm install` (no dep change).
4. Verify on the VPS at the next 18:00 ET run: confirm entry alerts land in the trade
   channel, and that an equal-to-rim or intraday-only-poke setup does **not** fire.

---

## Symbols to verify against the actual code (I inferred these from the state doc; confirm before editing)

- `replaySetup` and its fire logic → `lib/jack/outcome-tracker.ts` (+ `validation-core.ts`).
- Pending-set accessor: `getPendingSetups` / `getCurrentRunId` / `getCurrentBoard`.
- The EOD SYSTEM alert emitter + shared Telegram send helper + Redis client wrapper.
- The EOD daily-close source used by `runOutcomeTracker`.
- Existing SYSTEM alert message formatter (reuse its field set).
- Constants `CONFIRM_WINDOW_BARS = 15`, `TIME_STOP_BARS = 120` (already defined — import, don't redefine).
