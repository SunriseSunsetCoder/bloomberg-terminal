# JACK Session B — Implementation Spec (outcome tracking + interactive decisions)

**For:** Claude Code, working the `SunriseSunsetCoder/bloomberg-terminal` repo.
**Read first:** `SESSION_B_HANDOFF.md` and `PROJECT_STATE.md` at repo root. This spec supersedes the handoff's *recommendations* where they differ — the 5 open decisions are now resolved (below).
**VPS path:** `C:\Users\Administrator\Desktop\bloomberg-terminal` · **Win10 dev:** `C:\Repos\bloomberg-terminal`

---

## 0. Resolved decisions (these are final)

| # | Decision | Resolution |
|---|----------|-----------|
| 1 | How the tracker runs | **Manual trigger now** (button in JACK UI → POST route). Scheduling deferred. |
| 2 | Outcome definition | **Theoretical replay for ALL setups** (universe baseline) **AND log real user fills** for trades taken. Both R's computed. |
| 3 | Resolution window | **90 trading days** (conservative). Applies to BOTH the resolution gate and the forward replay scan — see §2. |
| 4 | Mark-as-traded / fill UI | **Full interactive rows now** — TRADED/PASSED/WATCHED controls + inline entry/exit fill fields per setup. Rendered from the parsed **JSON decisions block**, not from markdown. Pulls Session C's interactive UI forward. |
| 5 | Backfill correctness test | **4 known winners** (3 from May 2026 + 1 recent). Tickers + approx entry dates supplied by user at runtime — NOT needed to build; needed only to run the correctness test. |

**Net scope:** Session B is now outcome-tracker **plus** an interactive decision surface with fill logging. Roughly 1.5–2× the handoff's original B. This is deliberate.

---

## 1. Prerequisite / ordering (do not skip)

The cleanup branch `jack-cleanup-post-enrichment` (strip TEMP `[jack-tiingo]` logging + `.env.local.example` keys) must be **merged to `origin/main` first**. Then:

```
git fetch origin
git checkout main
git pull origin main          # get the cleanup merge
git checkout -b jack-session-b-outcomes   # branch off FRESH main
```

Rationale: two-machine bridge burned us once already this session — a branch based on stale local `main` nearly reverted the persistence layer. **Always `git fetch && rebase origin/main` before pushing.** Local `main` is not reliably current.

---

## 2. Deliverable 1 — Outcome tracker (the core)

**IMPORTANT — read the live schema first.** Before writing anything, open `lib/db/schema.sql`, `lib/db/read.ts`, `lib/db/write.ts` and confirm the **exact current column names** on the `outcomes`, `decisions`, and `setups` tables. This spec names columns from the handoff doc, which may not be verbatim. Reconcile and use the real names.

### 2a. Schema additions (additive only — do NOT alter existing columns)

The `outcomes` table already has theoretical fields (per handoff: `fired`, `fire_date`, `entry_price_actual`, `exit_price`, `exit_date`, `exit_reason`, `R_realized`, `max_favorable_pct`, `max_adverse_pct`). Decision 2 requires **user-fill** fields. Add (names to confirm against schema; distinguish clearly from the theoretical columns):

- `user_entry_price` REAL NULL
- `user_exit_price` REAL NULL
- `user_exit_date` TEXT NULL
- `user_R_realized` REAL NULL  (computed from user fills + the setup's stop)
- (`decisions.user_action` already exists per handoff — TRADED/PASSED/WATCHED. Confirm.)

Design question to confirm with user (see §6): do user fills belong on `outcomes` (one row per setup — recommended, since you trade a setup once) or on `decisions` (per validation-run decision)? Recommend **outcomes**, keyed to `setup_id`, with `user_action` staying on `decisions`. Confirm before writing.

### 2b. Replay logic (theoretical, runs for ALL resolved setups)

```
For each setup with no outcome row AND handle_low_date older than 90 trading days:
  1. Fetch daily OHLCV from handle_low_date forward, ~90 trading days.
  2. fired = first day High >= breakout_level.
       - none in window → fired=0, exit_reason='never_fired', no R. Write & stop.
  3. entry_date = next trading day after fire_date; entry_price = that day's Open.
  4. Scan entry_date forward, up to 90 trading days FROM ENTRY:
       - if Low  <= stop   → exit_reason='stop',   exit_price=stop,   R = -1
       - if High >= target → exit_reason='target', exit_price=target, R = +(target-entry)/(entry-stop)
       - TIE (both touched same day) → assume STOP first (conservative; document it)
       - track max_favorable_pct (highest High) and max_adverse_pct (lowest Low)
  5. neither hit within window → exit_reason='timeout', exit_price=last close, R = mark-to-market.
  6. Write outcome row.
```

**Window consistency (Decision 3):** the forward scan in step 4 uses **90 trading days from entry**, matching the resolution gate. A target/stop hit late in the window must NOT be truncated and mislabeled a timeout. Do not hardcode 60 anywhere — the handoff's draft said 60; we chose 90.

### 2c. User-fill R (Decision 2)

When a setup has `user_entry_price` + `user_exit_price` logged, compute `user_R_realized = (user_exit_price - user_entry_price) / (user_entry_price - stop)`. This is the **execution-quality** number, sitting alongside theoretical R. The comparison theoretical-R vs user-R answers "was the setup good?" vs "did I trade it well?"

### 2d. New functions / route

- `app/api/jack-outcomes/route.ts` — POST, guarded by `isPersistenceAvailable()` (early-return on Vercel, same pattern as jack-validation). Reads setups needing outcomes, replays each, writes. Returns summary: `{ processed, fired, target, stop, timeout, never_fired }`.
- `lib/db/read.ts` → `getSetupsNeedingOutcomes(resolutionDays=90)`.
- `lib/db/write.ts` → `insertOutcome(outcome)` (unique on `setup_id`); `updateUserFills(setupId, entry, exit, exitDate)`.
- Reuse the **now-fixed** EOD route `app/api/tiingo/eod/[ticker]/route.ts` for price history (confirm it returns enough history — may need a `startDate` param; Tiingo daily supports `&startDate=`).

---

## 3. Deliverable 2 — Interactive decision rows (Decision 4)

**Render from the JSON block, not the markdown.** The JSON-first block shipped in the truncation fix is the structured, `setup_id`-keyed source. The interactive table binds to that parsed JSON — do NOT scrape rendered markdown for row data (fragile, and the whole reason we front-loaded the JSON).

Per-row controls:
- **Action:** TRADED / PASSED / WATCHED → writes `decisions.user_action` via a small POST endpoint (`markDecisionUserAction` helper already exists in read.ts per handoff — confirm, wire it).
- **Fill fields:** entry price + exit price + exit date inputs, shown/enabled when action = TRADED → writes `outcomes` user-fill columns via `updateUserFills`.

Keep the human-readable markdown summary too (it's useful), but the **interactive table is the source of truth for writes**. Minimal, clean; this is a utility surface, not a redesign. No browser storage (localStorage/sessionStorage forbidden in this codebase — React state only).

Endpoints for the row writes: small POST routes or extend an existing one, guarded by `isPersistenceAvailable()`.

---

## 4. Deliverable 3 — "Update Outcomes" trigger (Decision 1)

Small **"Update Outcomes"** button in the JACK view header/corner. On click → POST `/api/jack-outcomes` → toast/banner with the summary (`N processed · N target · N stop · N timeout · N never_fired`). Utility action, not a main flow.

---

## 5. Deliverable 4 — Backfill correctness test (Decision 5)

The correctness gate for the whole tracker. User supplies **4 known winners** (3 May 2026 + 1 recent), each all-hit-take-profit, as `ticker` + approx `entry_date`.

- The 3 May setups **predate persistence** → likely not in DB. Insert them as `setups` first (with breakout/entry/stop/target geometry from the original batch if available; user may need to supply).
- The recent winner may **already be in the DB** from a live run (e.g. if it's a run #5 ticker). Check before inserting — avoid duplicating a `setup_id`.
- Run the tracker over them. **PASS CONDITION: R = +target for all 4** (i.e. exit_reason='target', positive R matching the computed target). If any come back stop/timeout/never_fired, the replay logic is **wrong** and must be fixed before any other outcome is trusted.

Do not fabricate outcome data to make the test pass. The test failing is information.

---

## 6. Design questions to confirm with user BEFORE coding

Batch these (Tee's workflow: design approval before code):

1. **User-fill columns on `outcomes` (per-setup) vs `decisions` (per-run)?** Recommend `outcomes`. Confirm.
2. **EOD history depth** — does the existing `[ticker]` EOD route return ≥90 trading days, or does the tracker need a direct Tiingo call with `&startDate=`? Confirm approach.
3. **Never-fired / timeout in universe PF** — when computing universe PF later (Session C), are `never_fired` setups excluded (no trade) and `timeout` marked-to-market? Confirm the intended treatment so the schema captures what's needed now.
4. **Interactive table** — replace the markdown output entirely, or interactive table + markdown summary side by side? Recommend side-by-side (table authoritative for writes).
5. Anything on the 4 backfill setups' geometry the user must hand-supply (the May ones predate persistence).

---

## 7. Constraints (repo conventions — non-negotiable)

- Branch `jack-session-b-outcomes` off **fresh** `origin/main` (see §1). `git fetch && rebase origin/main` before every push.
- `git commit --no-verify` (Husky pre-commit uses pnpm, not on VPS).
- **npm only.** Do NOT reintroduce `pnpm-lock.yaml`.
- `.npmrc` keeps `legacy-peer-deps=true`. Untouched.
- Do NOT touch the `isPersistenceAvailable()` guard logic or existing schema columns. Schema changes are **additive only**.
- No localStorage/sessionStorage in any UI (forbidden in this codebase — React state only).
- Complete drop-in files preferred over partial diffs.

---

## 8. Testing (VPS localhost — has the API keys; Win10 clone does not)

- Smoke-test the replay on the **4 backfill winners** — that's the correctness gate (§5).
- The synthetic BK/AAPL test setups (handle_low_date late June 2026) are **not 90 days old** → won't resolve. Either use the backfilled winners, or temporarily lower the resolution window for a smoke test ONLY (revert to 90 after).
- Verify writes directly:
  `node -e "const db=require('better-sqlite3')('data/jack.db'); console.log(db.prepare('SELECT * FROM outcomes').all())"`
- Confirm interactive rows write `user_action` and fills correctly (query `decisions` + `outcomes` after clicking).
- Full flow: run a validation → mark a setup TRADED with fills → Update Outcomes → confirm both theoretical R and user R populate.

---

## 9. Methodology reminder (from PROJECT_STATE §4)

This is disciplined measurement for a systematic trader: **universe PF (all JACK-surfaced setups) vs selected PF (what you traded) vs execution (your fills vs theoretical).** Don't add features that undermine that. Don't fabricate outcomes. The backfill test is the correctness anchor — if it doesn't show R=+target for known winners, the logic is wrong and nothing downstream is trustworthy until it's fixed.

---

## 10. Session C preview (NOT this session)

Audit UI panel: universe stats vs selected stats vs execution stats (via `decision_outcomes` view + the new user-fill columns), decision-type outcome breakdown, per-ticker timeline drill-down. Much of C's interactive UI is being pulled forward into B (Decision 4), so C narrows to the analytics/audit views.
