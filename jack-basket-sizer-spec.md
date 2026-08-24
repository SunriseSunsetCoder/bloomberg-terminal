# JACK — "Basket Sizer" page — Implementation Spec

**For: Claude Code on the Win10 dev box (`C:\Repos\bloomberg-terminal`).**
**Type: new page/tab + one pure sizing/aggregation module + selftests. No strategy/signal changes.**

---

## Goal

A dedicated **Basket Sizer** page in the JACK terminal that sizes the whole week's tradeable
setups at once — auto-pulled from the live board, conviction-tier-sized, filtered, and rolled
up with the operator's **existing open positions** so sector caps / buying power / heat / slots
reflect the *real book*, not just the new week. It's a planning tool: **read-only w.r.t.
strategy state** (no writes to `decisions.section`, no signal changes). The only optional
write is a "mark traded" convenience (Phase 2). Mirrors the standalone
`jack-sizing-calculator-v2.html` but live-fed and book-aware.

---

## Data sources (reuse — do NOT hand-roll)

- **New tradeable setups:** `getPendingSetups()` (lib/db/read.ts) — run-scoped, owned-excluded pending set. Each row has ticker, tier, sector, entry, stop, t05_target (`target`), breakout, priority, size_bucket. Compute **R:R = (target − entry) / (entry − stop)** live.
- **Open positions (already in motion):** `getOpenPositions()` (lib/db/read.ts) — currently-held (TRADED, no exit). Needed for the combined-book math below.
- **P-rank ordinals:** `getPriorityRanks()` (lib/db/analytics.ts) — the same Pn the board shows.
- **Sizing math:** `computeSizing(riskPerTrade, entry, stop)` + `isTradeableSetup({sizeBucket,tier})` (lib/jack/handle-score.ts). Extend for conviction-tiered risk (below).

---

## Sizing

- **Account size:** input, default **$70,000**, **persisted** (localStorage or user-settings — this is the real app, persistence is fine). Drives all dollar math.
- **Risk scheme toggle** (persisted): **Balanced** Q3 0.30% / Q4 0.50% / Q5 1.00% · **Aggressive** Q3 0.35% / Q4 0.55% / Q5 0.85%. **Q5 hard cap 1.0%.** Editable per-row risk% (defaults from tier+scheme).
- Per row: `risk$ = account × risk% ; shares = floor(risk$/(entry−stop)) ; position$ = shares×entry ; reward$ = shares×(target−entry)`. Reuse `computeSizing` where possible.

---

## Filters (toggles, persisted)

- **Live on/off** — ON: auto-fill rows from `getPendingSetups()`. OFF: manual rows (like the HTML tool).
- **Hide Q1/Q2** (skip-tier) — default ON (they're never traded anyway; `isTradeableSetup`).
- **R:R floor** — numeric input, default **1.0**; hide/flag rows below it. (Tune the default after the R:R backtest.)
- **Price ≥ $5** — default ON (liquidity floor).
- Sort tradeable rows by **P-rank** descending by default.

---

## Combined-book logic (THE important part — reflect the real book, not just the basket)

Roll `getOpenPositions()` in with the new basket for every capacity check:

- **Sector counts include open positions.** For each sector, count = (open positions in it) + (new basket rows in it); **cap 3**; show a **tickers-per-sector panel** ("Energy 3/3", "Health Care 2/3") that turns red at/over cap. A new row that would breach the cap is flagged (and skipped by "trim to fit").
- **Buying power:** `available = account − Σ(open-position notional)`. Flag when the new basket's Σ position$ exceeds `available` (needs margin). On a $70k book this binds well before 12 slots.
- **Portfolio heat:** `Σ risk$ (open + new) / account`, with a cap warning.
- **Slots used:** `open count + new count` of 12; show remaining.
- **Duplicate guard:** flag/skip any new setup whose ticker is already an open position (non-overlap).

---

## Extra features (approved additions)

- **"Trim to fit" button** — drop the **lowest-P-rank** new rows one at a time until the basket fits `available` buying power AND the 12-slot cap AND per-sector caps. So capital rationing always sheds your *worst* setups first. Show what got trimmed.
- **Totals + tiles:** Σ shares, Σ position$ (+ gross exposure %), Σ risk$ (+ heat %), Σ reward$ (+ reward:risk ×), slots used, buying power remaining.
- **Execution bridge:** **"Copy order list"** (ticker · shares · stop · entry · target, tab-separated) to clipboard + a **printable ticket view** — since Fidelity has no API, this is how the basket reaches the broker. 
- **(Phase 2, optional) "Mark traded"** per row → `markDecisionUserAction(decisionId,'TRADED')` so it routes to Current Positions and drops off next week. Gate behind a confirm; keep the page otherwise read-only.

---

## UI

New route/tab **"Basket Sizer"** (match the existing terminal nav + styling). Table columns in board order for fast scanning: **Ticker · Tier · Sector · Risk% · Stop · Entry/Now · Target · | · Risk$ · Reward$ · Shares · Position$ · %Acct · Stop% · R:R · ⚑**. Above/below: account + scheme + filter controls, the sector-count panel, the totals tiles, and the trim/copy buttons. Per-row flags: <$5, over-cap risk, R:R<floor, stop≥entry (error), duplicate-of-open. Include a persistent **"frictionless — sizes are ceilings"** note.

---

## Reuse map / new code

- **Reuse:** `getPendingSetups`, `getOpenPositions`, `getCurrentBoard`, `getPriorityRanks`, `computeSizing`, `isTradeableSetup`, `normalizeSizeBucket`.
- **New pure module** `lib/jack/basket.ts` — conviction tier-risk map, per-row sizing (risk/reward/shares/position), combined-book aggregation (sector counts incl. open, buying power, heat, slots, duplicates), the R:R floor filter, and the trim-to-fit selector. Keep it PURE (no DB/React) so it's unit-testable.
- **New page component** — reads the two DB accessors via an API route (or server component), passes rows to `basket.ts`, renders the table/panels.
- Do NOT duplicate the fire/scoping logic; this page only *reads* the run-scoped set.

---

## Guardrails

Read-only w.r.t. strategy: no writes to `decisions.section`, no changes to alerts/signals/outcomes. Sizing is display. The only write path is the optional Phase-2 "mark traded," which must reuse `markDecisionUserAction` and be confirm-gated. Never let this page mutate the board or the pending scope.

---

## Selftests (`scripts/jack-basket-selftest.ts`, pure)

- tier-risk map + Q5 cap; per-row shares/risk/reward math; R:R computed and floor filter.
- **sector count includes open positions** (2 open + 2 new in a sector → count 4, over cap).
- buying power = account − open notional; basket over `available` flags.
- portfolio heat (open + new); slots used (open + new) of 12.
- duplicate-of-open guard.
- **trim-to-fit** drops lowest-P-rank first until it fits buying power + slot + sector caps.
- Q1/Q2 hidden; hidden rows excluded from all totals.

---

## Phasing

- **Phase 1:** the page — live pull + tiered sizing + filters + combined-book (sector/buying-power/heat/slots/duplicate) + totals + sector panel + trim-to-fit + copy/print. (Everything above except "mark traded".)
- **Phase 2:** the optional "mark traded" write-back.

Build Phase 1, show the diff + green selftests, stop for review before Phase 2.

---

## Deploy (two-box, code-only)

Win10 commit (`--no-verify` for the pnpm hook) → `$env:BYPASS_PUSH_PROTECTION="1"` on its own line → push → confirm `git log -1`. VPS `git pull` → restart `npm run dev`. No deps, no migration.

## To verify against the actual code before building
- Confirm the terminal's nav/tab registration pattern (how existing JACK views/pages mount) and match it.
- Confirm `getPendingSetups`/`getOpenPositions` return the fields listed (esp. `target`/`breakout`/`priority`/`sizeBucket`/`sector`); if `target`/`breakout` aren't on the pending row shape, add them (display-only) the same way tier/priority were.
- Confirm `getPriorityRanks` keying (setupId) for the P-rank display + trim ordering.
