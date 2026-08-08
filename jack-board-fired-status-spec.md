# JACK — Board "FIRED" status (reflect close-confirmed fires without a re-VALIDATE)

**For: Claude Code on the Win10 dev box (`C:\Repos\bloomberg-terminal`).**
**Type: additive code + one additive DB migration (auto-applied). Two-box deploy, no new deps.**

---

## Goal

A pending setup that has close-confirmed above its rim currently keeps showing as
**PENDING** on the board until the next weekly VALIDATE — the board lags reality. Make
the board reflect a fire as soon as the 18:00 EOD pass detects it, so a fired setup
shows as LIVE/actionable (and a fired-then-resolved one shows as done), **without
re-running VALIDATE and without changing any strategy/selection/sizing logic.**

---

## HARD ARCHITECTURAL MANDATE (read first)

**Do NOT mutate `decisions.section` to do this.** `section` ('live'|'pending') is not
just a display label — it is the SCOPING KEY the alert/refresh system runs on:
`getPendingSetups()` (lib/db/read.ts) returns the current run's `pending` rows, and that
set feeds (a) the intraday price refresh, (b) the intraday owned-... alerts' ticker
batch, and (c) the EOD entry-confirmation + earnings passes. Flipping a fired setup to
`section='live'` would drop it out of `getPendingSetups()` → its NOW price would stop
refreshing (the intraday monitor fetches only open positions + pending) and it would
leave the alert-eligible set. That is a silent regression.

Instead: **persist a fired FLAG, leave `section` untouched, and re-section for DISPLAY
ONLY in `combineJackDecisions` (lib/jack/combine-decisions.ts)** — the same pure layer
that already routes TRADED setups into Current Positions. The DB stays the source of
truth for scoping; the UI decides where a fired row is shown.

`outcomes.fired` is NOT usable here — it's populated only after the ~195-day resolution
gate (`getSetupsNeedingOutcomes`), so it's empty for recent setups. Use the shared
`detectFire` at EOD instead (already run in the entry pass).

---

## Reuse (don't re-detect)

`evaluateEntryConfirmations` (lib/jack/alerts.ts) ALREADY, at 18:00, loops the pending
set, fetches daily bars, and runs the shared `detectFire` (+ `findTouchExit` for the
late-resolved guard). Piggyback the flag persistence there — same detection that fires
the Telegram alert also writes the board flag. **No new Tiingo calls, no second loop.**

Note the existing short-circuit: that loop `continue`s before `detectFire` if the
once-per-setup Redis marker is already set (an already-alerted setup). So the flag is
naturally written **once, at first detection** — which is the intended behavior (see
"Resolution progression" below). Fire the alert first, then persist the flag, in the
same iteration.

---

## Schema (additive migration — mirror the existing pattern)

Add to the `decisions` table (both `lib/db/schema.sql` CREATE for fresh DBs AND
`ensureColumns(database, "decisions", [...])` in `lib/db/init.ts` `runMigrations`, so the
live VPS `jack.db` gets them on next open — that's how prior additive columns shipped):

- `fired_at        TEXT`    — ET date the close-confirmed fire was FIRST detected (NULL = not fired)
- `fire_close      REAL`    — the confirming close
- `fire_bar        INTEGER` — bar index within the 15-bar window (`fireBarIndex`, display)
- `fired_status    TEXT`    — 'confirmed' | 'late' | 'resolved' (mirrors the entry alert's three types)

The migration is additive-only (ALTER TABLE ADD COLUMN), auto-runs on every `getDb()`,
so **no manual DB step at deploy** — restart applies it.

---

## Persistence (lib/db/write.ts)

Add `markDecisionFired(decisionId, { firedAt, fireClose, fireBar, firedStatus })`:

- `UPDATE decisions SET fired_at=@firedAt, fire_close=@fireClose, fire_bar=@fireBar, fired_status=@firedStatus WHERE id=@decisionId AND fired_at IS NULL`
- Set-once (the `fired_at IS NULL` guard makes it idempotent — first fire wins, later
  passes are no-ops). Wrap in a transaction like the other writers.

Call it from `evaluateEntryConfirmations` right after the `fireOnce(...)` alert send,
using the current-run decision id for that setup. **You need the decisionId in the loop
** — `getPendingSetups()` currently returns `setupId` but not `decisionId`. Add
`decisionId` to `PendingSetupRow` (it's already available on `CurrentBoardRow`, which
`getPendingSetups` maps from — just carry it through). `firedStatus` = `'confirmed'` when
`fireDate === etDate`, `'resolved'` when the late-resolved guard found a stop/target
touch, else `'late'` — reuse the exact same branch logic `evalEntryConfirmed` already
computes so the board flag and the alert text can never disagree.

---

## Resolution progression (documented limitation — keep it simple)

Because the entry loop short-circuits after the first alert, `fired_status` is captured
once at first detection and not chased afterward. Consequence: a same-day `'confirmed'`
fire that later resolves stays `'confirmed'` on the board until the next weekly VALIDATE
(fresh decision rows) or until the user trades it (→ Current Positions). That's an
acceptable MVP: the `entry_resolved` alert and the eventual outcome tracker both cover
true resolution; the board's job here is "this fired, act or not." Do NOT add an
ongoing re-scan to keep the board status live — that fights the short-circuit and isn't
worth it. Just add a one-line code comment noting this.

---

## Read + API + client plumbing

- `lib/db/read.ts`: carry `firedAt`, `fireClose`, `fireBar`, `firedStatus` through
  `CurrentBoardRow` and `PendingSetupRow` (+ the `decisionId` add above). Display-only —
  they must NOT affect the owned/retired filters or the pending scoping in
  `getPendingSetups`.
- The API route that serves the board (locate it — likely `app/api/jack-validation` or
  whatever feeds `useJackValidation`): thread the four fields into the decision payload.
- `JackDecisionClient` (components/bloomberg/hooks/useJackValidation): add
  `firedAt: string | null`, `fireClose: number | null`, `fireBar: number | null`,
  `firedStatus: 'confirmed' | 'late' | 'resolved' | null`.

---

## Display routing (lib/jack/combine-decisions.ts) — PHASE 2

Keep the existing owned→"open" routing exactly as is (owned always wins). Then, for a
NON-owned run row:

- `firedStatus IN ('confirmed','late')` → re-section to **'live'** for display (set
  `section:'live'` on the returned client object, same technique as the `ownedUncovered`
  re-section). These are fired + actionable.
- `firedStatus === 'resolved'` → leave in its section (pending) but the row carries the
  flag so the view can show a muted "fired & resolved" tag — NOT actionable, must not
  join the actionable LIVE group.
- unfired (`firedStatus == null`) → unchanged.

Preserve the unit-tested invariant: every setup in exactly one section, owned still
routes to "open", nothing vanishes or double-renders. Add unit tests:
fired-confirmed→live, fired-late→live, fired-resolved→stays, owned+fired→still open,
unfired→unchanged.

---

## View badge (jack-view.tsx / the LIVE-PENDING table — PHASE 2)

Locate the board table component and render, on a row with `firedStatus` set, a small
badge matching existing styles:
- confirmed → `🔥 FIRED · buy next open` (+ `close {fireClose} · bar {fireBar}/15`)
- late → `🔥 FIRED {firedAt}` (off-parity note optional)
- resolved → muted `fired · resolved` tag

Match the existing badge/pill styling in that component; don't invent a new design
system.

---

## Phasing (so you can land value and stop)

- **PHASE 1 (core):** schema+migration, `markDecisionFired`, persist in
  `evaluateEntryConfirmations`, carry fields through read→API→client, and a minimal badge
  on the PENDING row IN PLACE (`🔥 FIRED · buy next open`). This alone makes the board
  honest. No `combine-decisions` change yet.
- **PHASE 2 (move to LIVE):** the `combineJackDecisions` re-section (confirmed/late →
  live display group; resolved handling) + its unit tests + the richer badge.

Build Phase 1, show me green selftests + the diff, then Phase 2.

---

## Selftests

- New/extended: a write+read test that `markDecisionFired` sets the fields once
  (second call is a no-op) and `getCurrentBoard`/`getPendingSetups` carry them.
- Extend `scripts/jack-entry-alert-selftest.ts`: on a `fired` setup, assert the flag
  values that would be persisted match the alert classification (confirmed/late/resolved).
- Phase 2: `combine-decisions` routing unit tests (above).
- Re-run ALL existing selftests (the 48-check replay, the entry-alert 85, the
  pending-scope set, etc.) — all must stay green. The migration must not disturb them.

---

## Failure discipline

Persisting the flag must never throw out of the EOD pass or block the Telegram alert —
wrap `markDecisionFired` so a DB hiccup logs and continues (the alert already fired; the
flag can catch up next run only if `fired_at` is still NULL, which it will be). Never let
this pass corrupt `section` or the pending scoping.

---

## Deploy (two-box, code + auto-migration, no new deps)

1. Win10 dev: run all selftests green → `git add -A` → `git commit --no-verify -m "..."`
   (the pnpm pre-commit hook needs `--no-verify`) → `$env:BYPASS_PUSH_PROTECTION="1"` on
   its own line → `git push origin main` → confirm with `git log -1 --oneline`.
2. VPS: `git pull` → restart `npm run dev`. The additive migration auto-runs on the first
   `getDb()` (columns added to the live `jack.db`); no manual DB step.
3. Verify: after an 18:00 run, a fired pending setup shows the FIRED badge / moves to the
   LIVE display group; NOW prices still refresh on it (proves scoping intact); the entry
   Telegram alert still fires as before.

---

## Symbols confirmed by reading the code (2026-08-07)

- `decisions.section` CHECK ∈ ('live','pending'); board = current run's decisions split by section (`getCurrentBoard`/`getCurrentRunId`, lib/db/read.ts).
- `getPendingSetups()` = current run pending − currently-owned − retired; feeds refresh + alerts. **Scoping key — do not flip section.**
- `evaluateEntryConfirmations` (lib/jack/alerts.ts): already runs `detectFire` (+ `findTouchExit`) per pending setup at EOD; short-circuits on the once-per-setup Redis marker before detection.
- `combineJackDecisions` (lib/jack/combine-decisions.ts): pure display-routing layer; already re-sections owned→'open'. Add fired→'live' here.
- Migration pattern: `runMigrations`/`ensureColumns` in lib/db/init.ts (additive ALTER TABLE ADD COLUMN, idempotent, auto on `getDb`).
- `outcomes.fired` is resolution-gated (~195d) — NOT usable for live board status.
- Still to locate (I did not read these): the board API route feeding `useJackValidation`, and the LIVE/PENDING table component in `jack-view.tsx`. Thread the fields + render the badge there.
