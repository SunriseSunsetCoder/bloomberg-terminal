# PROJECT_STATE.md — Bloomberg Terminal Repo

**Read this file first at the start of every session.** It's the shared context anchor between the user (Tee) and any Claude session working on this codebase — Claude Code, Claude.ai chat, or otherwise.

**Update this file at the end of every substantive session** in the "Recent decisions" and "Current status" sections. Do not delete prior entries — append.

---

## Table of contents

1. [Who this is for](#1-who-this-is-for)
2. [Repo architecture](#2-repo-architecture)
3. [Deployment topology](#3-deployment-topology)
4. [Methodology rules (non-negotiable)](#4-methodology-rules-non-negotiable)
5. [JACK panel architecture](#5-jack-panel-architecture)
6. [Current status](#6-current-status)
7. [Active work items](#7-active-work-items)
8. [Recent decisions](#8-recent-decisions)
9. [Kill list — do not retest](#9-kill-list--do-not-retest)
10. [Working style](#10-working-style)
11. [Key file locations](#11-key-file-locations)

---

## 1. Who this is for

**User:** Tee. Sr. Director at ICU Medical who runs a parallel systematic algorithmic trading operation.

**The bigger operation this repo supports:**
- Futures fleet: ~25-30 automated NinjaTrader 8 bots trading MES/MNQ/MBT/MCL/MGC micro futures
- Prop firm accounts: Bulenox, Apex, BluSky, Lucid + personal cash
- Custom C# AddOns: CommandCenter (fleet risk mgmt) + CopyRouter (trade copying, replaces Replikanto)
- Research pipeline: Python/Colab hypothesis testing → NT8 Strategy Analyzer validation → NinjaScript deploy → SIM tier → live prop tier
- ~1780 backtested Cup with Handle trades on the equity side (this repo's focus)

**What this repo does specifically:** Bloomberg Terminal clone — an operational dashboard layered on top of the trading operation. Multiple panels for market data, IV regime, fleet monitoring, news, movers, volatility, RMI, and JACK (swing setup validation for the equity book).

**This repo does NOT house:** the NT8 bot code (that's a separate GitHub repo `SunriseSunsetCoder/botfolio` — private), backtests (Colab notebooks in `MyDrive/Bukowski/` for equities and `MyDrive/Market Data Collector/` for futures), or the CommandCenter/CopyRouter AddOns.

---

## 2. Repo architecture

**Stack:**
- Next.js 16.2.6 (App Router, Turbopack)
- TypeScript, strict mode
- Jotai for state management
- React Query for server-state hooks
- Tailwind CSS + @tailwindcss/typography for prose styling
- Anthropic SDK for Claude API calls
- Upstash Redis (for IV regime caching in P5 and general market data)
- Tiingo API (EOD prices + news — free tier)
- Lucide React for icons
- Better-sqlite3 for JACK persistence (v1.3+)

**Directory layout:**
```
bloomberg-terminal/
├── app/
│   ├── api/                    ← Next.js API routes
│   │   ├── ai/                 ← Anthropic SDK proxy (used by IV panel)
│   │   ├── iv-regime/          ← P5 IV panel data
│   │   ├── options-signal/     ← P5 options signal
│   │   ├── jack-validation/    ← JACK panel data + Claude reasoning
│   │   └── tiingo/
│   │       ├── eod/[ticker]/   ← daily OHLCV proxy
│   │       └── news/[ticker]/  ← news headlines proxy
│   ├── page.tsx                ← root page renders the terminal
│   └── layout.tsx
├── components/
│   └── bloomberg/
│       ├── atoms/index.ts      ← Jotai state (currentViewAtom, etc.)
│       ├── hooks/              ← useMarketData, useIVRegime, useJackValidation, useTerminalUI
│       ├── views/              ← MarketView, IVView, JackView, FleetView, etc.
│       ├── layout/
│       │   ├── bloomberg-terminal.tsx   ← main component, wires views
│       │   └── terminal-header.tsx      ← header with panel buttons
│       └── lib/                ← shared utilities
├── contracts/                  ← JSON schemas for API responses
├── prompts/                    ← Claude prompt templates
├── lib/db/                     ← SQLite persistence layer (v1.3+)
│   ├── schema.sql              ← 4 tables + 1 view
│   ├── init.ts                 ← DB singleton, WAL mode
│   ├── env.ts                  ← Vercel vs VPS detection
│   ├── write.ts                ← upsertSetup, insertValidationRun, insertDecisions
│   └── read.ts                 ← diagnostic queries
├── data/                       ← SQLite DB file (gitignored)
│   └── jack.db                 ← created on first JACK validation
├── next.config.mjs
├── package.json
├── tailwind.config.ts
└── PROJECT_STATE.md            ← this file
```

**Panel identifiers used in `currentViewAtom` union:** `market`, `news`, `movers`, `volatility`, `rmi`, `iv`, `fleet`, `jack`.

**Header buttons (in current order):** CANCL, NEW, BLANC, NEWS, GMOV, GVOL, RMI, FLEET, IV, JACK, HELP, LIGHT/DARK.

**Keyboard shortcuts:** 1=market, 2=news, 3=movers, 4=volatility, 5=fleet, 6=IV, 7=JACK, ?=help.

**Established patterns for adding a new panel** (mirror the P5 IV work):
1. Contract at `contracts/<feature>-state.schema.json`
2. Route at `app/api/<feature>/route.ts`
3. Hook at `components/bloomberg/hooks/use<Feature>.ts`
4. View at `components/bloomberg/views/<feature>-view.tsx`
5. Add to view union in `components/bloomberg/atoms/index.ts`
6. Add `handle<Feature>View` in `components/bloomberg/hooks/useTerminalUI.ts`
7. Add button to `components/bloomberg/layout/terminal-header.tsx`
8. Wire render branch in `components/bloomberg/layout/bloomberg-terminal.tsx`

---

## 3. Deployment topology

**Two environments, both currently in use:**

**A. VPS localhost — where the user actually uses the terminal**
- Windows Server 2016 VPS
- `C:\Repos\bloomberg-terminal\` on the VPS
- `npm run dev` on port 3000
- SQLite persistence lives here in `data/jack.db`
- Full JACK functionality including DB writes
- User accesses via `http://localhost:3000`

**B. Vercel — Option B "keep it deployed but disabled features"**
- Auto-deploys from `main` branch push to GitHub
- URL: `bloomberg-terminal-navy.vercel.app`
- Hobby tier (free)
- SQLite persistence auto-disabled (SQLite requires persistent filesystem, Vercel serverless doesn't have one)
- JACK panel still functions on Vercel — Claude validates, tables render, banner shows "Persistence: disabled"
- User does NOT use this URL day-to-day but keeps deployment alive for optionality

**Local dev machine — Win10 with Claude Code**
- User uses Claude Code CLI here to make changes
- `C:\Repos\bloomberg-terminal\` on Win10 (git clone of the same repo)
- Claude Code makes edits, tests locally, commits, pushes
- Then user does `git pull` on the VPS to receive changes (same pattern as CommandCenter workflow)

**Persistence detection logic (`lib/db/env.ts`):**
- `process.env.VERCEL === "1"` → skip persistence (running on Vercel)
- `process.env.JACK_DISABLE_PERSISTENCE === "1"` → manual override for testing
- Otherwise → persistence enabled

**Config that matters for cross-environment:**
- `next.config.mjs`: `serverExternalPackages: ["better-sqlite3"]` (native module, not bundled)
- `package.json`: `better-sqlite3` in `optionalDependencies`, NOT `dependencies` (Vercel build tolerant of install failures)
- `.gitignore`: excludes `data/jack.db`, `data/jack.db-shm`, `data/jack.db-wal`

**GitHub repo:** `SunriseSunsetCoder/bloomberg-terminal` — private.

---

## 4. Methodology rules (non-negotiable)

These apply to ALL research and code decisions in this project. Failure to follow these is failure to follow the operation's core discipline.

**Research gates:**
- **PF ≥ 1.4** minimum for deployment
- **All backtest years positive** — no single year carrying the result
- **n ≥ 30 trades** minimum sample size
- **IS/OOS degradation < 30%** — if a strategy gets 30% worse out of sample, it fails
- **Bootstrap CI** and per-year × per-bucket grids (NOT aggregate PF alone) for validation

**Hypothesis-first, not data-mining:**
- Blind indicator hunting on equity index futures is dead (0-for-5)
- Define a specific trigger event first (calendar, academic anomaly, existing bot signal), then use ML/filters to refine
- Every research question needs a mechanism story before it's tested

**NULL results get FILED and RESPECTED:**
- Kill list is maintained (section 9 below)
- Dead archetypes are not retested
- Filing a NULL is a valid research outcome, not a failure

**Python is directional-only for stop-based or multi-rule bots:**
- NT8 Strategy Analyzer is ground truth for magnitude
- Python backtests can miss order-architecture interactions

**Selectivity is the edge:**
- Loosening entry criteria has consistently hurt performance
- When in doubt, be more restrictive not less

**Extreme-contrast labeling for feature research:**
- Use R > +0.3 vs R < -0.3 for winner/loser tests (as in QQE ML v2 meta-labeling)
- Excludes marginal trades where signal is drowned in noise

**Drop-one-bot robustness check** required for fleet-aggregate findings.

---

## 5. JACK panel architecture

JACK ("Swing Setup Validation — Cup with Handle t05") is the swing-trading equity panel. Named after a trader who concentrated capital, took gains, and moved on. **Tee does NOT actually concentrate — risk is bounded at $2K per trade** with portfolio-level caps.

**Strategy validated:** Bulkowski Cup with Handle, half-target exit variant (t05).
- Backtest: PF 2.09 IS / 1.70 OOS (19% degradation ✓)
- Win rate: 63%
- All years 2020-2026 positive
- Median hold: 20 days, p90 57 days
- 1780 trades in backtest

**Entry mechanics:** next-day open after confirmed breakout above cup rim. Stop below handle low. Target = breakout + 0.5 × cup depth.

**JACK's job:** take today's scanner output (CSV of Cup with Handle setups) and validate each one against context the backtest doesn't model — earnings risk, news catalysts, sector rotation, cross-asset confirmation, live price drift.

**Version history:**
- **v1 (May 2026):** Initial ship. Manual CSV paste, Claude validates all setups, one markdown table output.
- **v1.1:** Server-side validated filter (drop handle >15d), 30-cap by status priority.
- **v1.2:** Two-section output (Live + Pending), Tiingo integration for EOD prices + news headlines, structured prompt.
- **v1.3 (in progress):** SQLite persistence via better-sqlite3, structured JSON output from Claude, DBeaver-inspectable. Vercel-safe with `isPersistenceAvailable()` guard.

**Filter pipeline (server-side, before Claude):**
1. Parse CSV (auto-detect comma / tab / multi-space delimiter)
2. Drop setups where `handle_low_date` is >15 days old (**VALIDATED** filter, May 2026)
3. Split into Live (`just_fired` + `recent_breakout`) and Pending (`pending`) sections
4. Sort Live by status priority (`just_fired` > `recent_breakout`) — untested heuristic
5. Sort Pending by `handle_low_date` descending (freshest first) — untested heuristic, pending-ranking test returned NULL
6. Cap Live at 30 setups, Pending at 50 setups
7. Enrich survivors with Tiingo data (parallel fetch: EOD price + news)
8. Build sectioned prompt, send to Claude Sonnet 4.5
9. Parse Claude's JSON block from response, write to SQLite (VPS only)
10. Strip JSON block from markdown, return to UI

**Fixed thresholds (do not change without new research):**
- `MAX_HANDLE_DAYS = 15` (validated Q5 threshold from winner-vs-loser test)
- `MAX_LIVE_SETUPS = 30` (session cap math: $800K / ~$25K avg notional)
- `MAX_PENDING_SETUPS = 50` (pendings may not fire, larger cap)
- `DEFAULT_RISK_PER_TRADE = 2000` USD
- `INDIVIDUAL_CAP_MULTIPLIER = 100` (individual position notional cap = 100× risk = $200K at default)
- `SESSION_CAP_MULTIPLIER = 400` (session total notional cap = 400× risk = $800K at default)

**Data limits (v1.2/v1.3):**
- Tiingo fundamentals NOT fetched (requires paid add-on, free tier returns 400)
- Earnings dates via training-data inference only, cells labeled "verify on EM"
- Sector RS and cross-asset (2s10s, 10Y) via training-data inference — no live feed integrated
- These are documented in the prompt as by-design, NOT errors

**Session A (v1.3) SQLite schema:**
- `setups` (unique ticker + handle_low_date) — natural key + surrogate ID
- `validation_runs` (one row per VALIDATE click) — stores raw markdown for later re-parsing
- `decisions` (one row per setup × validation_run) — Claude's per-ticker output, plus user_action field
- `outcomes` (one row per setup, populated later by Session B) — realized outcome from Tiingo
- View `decision_outcomes` joins all three for analytical queries

**Session B (upcoming):** Tiingo outcome tracker — nightly job that reads price data for setups whose windows have passed, determines fire/no-fire, computes R_realized, writes to `outcomes` table. Plus "mark as traded" UI element.

**Session C (upcoming):** Audit UI panel showing universe stats vs your-selected stats. New button in terminal header. Per-ticker timeline drill-down.

---

## 6. Current status

**As of 2026-07-04, mid-Session A deploy.**

**What's shipped and working on VPS localhost:**
- Bloomberg Terminal Next.js 16.2.6 running on port 3000
- All panels except JACK: market, news, movers, volatility, RMI, fleet, IV
- JACK v1.2 with two-section output + Tiingo enrichment (working)
- Tiingo EOD + news integration
- Delimiter auto-detection for CSV parsing
- Result persistence via Jotai atom (survives view navigation)

**What's in-progress on VPS localhost (Session A):**
- SQLite persistence via better-sqlite3 (v1.3)
- Structured JSON output from Claude (schema in prompt)
- Files staged at `/mnt/user-data/outputs/jack-v1.3-vercel-safe/` (delivered via chat, not yet placed in repo)

**What's blocked on Vercel:**
- Last known deploy state: FAILED
- Root cause: better-sqlite3 native compilation on Vercel serverless
- Fix: `serverExternalPackages` in next.config.mjs + optionalDependencies in package.json + runtime guard in route
- All three fixes designed but NOT YET APPLIED to repo

**User has made 3 live trades so far from JACK output** (early May 2026 batch, before Session A build). Result: 3-for-3 take-profit. Sample size too small to conclude anything, but it's the seed batch that will get retroactively entered into DB via Session B outcome tracker.

**Kill list (do not retest):** See section 9.

---

## 7. Active work items

**Immediate (Session A completion):**
- [ ] Fix `next.config.mjs` — `serverExternalPackages: ["better-sqlite3"]` needs to be INSIDE the config object, not floating
- [ ] Move `better-sqlite3` from `dependencies` to `optionalDependencies` in `package.json`
- [ ] Install `better-sqlite3` and `@types/better-sqlite3` if not present
- [ ] Place 5 new files from `jack-v1.3-vercel-safe/`: `lib/db/schema.sql`, `lib/db/init.ts`, `lib/db/env.ts`, `lib/db/write.ts`, `lib/db/read.ts`
- [ ] Overwrite 2 files: `app/api/jack-validation/route.ts`, `prompts/cup-handle-t05-validation.md`
- [ ] Run `npm run dev` on VPS localhost, click VALIDATE, verify banner shows "Persistence: run #1"
- [ ] Verify DB via DBeaver connected to `data/jack.db`
- [ ] Commit + push, verify Vercel deploy succeeds
- [ ] Verify JACK on Vercel URL shows "Persistence: disabled"

**Session B (persistence layer, deferred):**
- [ ] `app/api/jack-outcomes/route.ts` — endpoint that reads setups needing outcomes, fetches Tiingo prices, determines fire/no-fire/target/stop, writes to `outcomes` table
- [ ] Manual "Update Outcomes" button in JACK UI
- [ ] "Mark as traded / passed / watched" UI element per decision row (writes `user_action` column)
- [ ] Backfill: retroactively enter 3 winning trades from May 2026 batch, verify outcome logic computes correct R_realized

**Session C (audit UI, deferred):**
- [ ] New header button (TRACK or HIST or STATS — TBD)
- [ ] View shows: universe PF vs your-selected PF, decision distribution over time, per-ticker timeline
- [ ] Uses `decision_outcomes` view as primary data source
- [ ] Session-cap-scaled charts (PF over time, WR by decision type, universe delta)

**Beyond Session A/B/C:**
- [ ] Finnhub integration for real earnings dates (replaces training-data inference)
- [ ] SPDR ETF prices via Tiingo for real sector RS (replaces training-data)
- [ ] FRED API for real 2s10s and 10Y (replaces training-data cross-asset)
- [ ] Per-ticker chart panel (Recharts or Lightweight Charts, click ticker in JACK table → side panel with candles + entry/stop/target lines)
- [ ] Multi-strategy support (other Bulkowski patterns beyond Cup with Handle)

**Speculative / on the horizon:**
- Direct scanner-to-JACK wiring (Python scanner writes to Redis / known location, JACK polls)
- Result persistence across browser sessions (wrap Jotai atom in `atomWithStorage`)

---

## 8. Recent decisions

**2026-07-04:**
- Confirmed VPS + Vercel dual-deploy strategy (Option B) rather than kill Vercel entirely
- SQLite via better-sqlite3 chosen over Turso, Postgres, etc. — VPS is source of truth
- Committed to Sessions A/B/C sequenced work for full persistence + outcome tracking + audit UI
- User switching to Claude Code CLI on Win10 dev machine to reduce manual file-placement bottleneck
- Repo cloned to `C:\Repos\bloomberg-terminal\` on Win10 (not Dropbox — plain local)

**2026-05-21 (Colab research):**
- Pending-snapshot ranking test: NULL. 5 features tested (`pct_to_breakout`, `days_pending`, `snapshot_position_in_handle`, `pending_slope_pct`, `pending_vol`), all |Cohen's d| < 0.20. No pending-side ranking criterion.
- Pending section uses freshness sort (untested, no edge claim).

**2026-05-20 (Colab research):**
- Winner-vs-loser feature test: **VALIDATED** filter — drop `days_since_handle_low > 15`. IS PF 2.31 (+0.21), OOS PF 1.90 (+0.20), preservation 96.7%, retention 80%.
- Key finding: `fire_date == handle_low_date` for all 1780 trades — so this filter also captures signal staleness. Single filter, single threshold.
- Within-day ranking test (prior): NULL.

**2026-05-19 (v1.2 build):**
- Two-section output shipped (Live + Pending)
- Tiingo integration: EOD prices + news headlines working
- Tiingo fundamentals removed — free tier returns 400 (paid add-on required)
- Prompt updated to reason from training data for earnings (label "verify on EM")

---

## 9. Kill list — do not retest

**Equity side (this repo's focus):**
- Cup with Handle within-day ranking (5+ setups per day) — no feature separates winners
- Cup with Handle pending-snapshot ranking — no feature separates winners
- Volume filters on Cup with Handle breakouts — empirically rejected across 1769 trades

**Futures side (relevant for terminal panels that display bot data):**
- Reversal/mean-reversion on equity index futures: Turtle Soup (16 variants NULL), Koroush spike-fade (5×5 grid NULL — MBT worst, killing "reversals alive on crypto" caveat)
- Morning breakout on equity index (0DTE gamma regime): OpeningSurge ES, 3FPS, IB Expansion — 2024 catastrophic
- Volume Price Analysis on equity index futures
- OB/order-book ML directional prediction (0-for-5, feature importance flat)
- NQ-ES pair spread mean reversion (non-stationary ratio, +14% drift 2022→2026)
- OvernightFade short-side except Monday
- ML meta-labeling on MBT wake-day edges (AUC 0.47-0.54)
- SHAP-derived strategies (0-for-1)
- SPY options overlay on QQE-long MES futures signals (21 variants, 2026 universally negative)
- QQE Options Overlay (all variants NULL, per-year stability failure)

---

## 10. Working style

**Communication:**
- Terse and technically dense. Verdict-first responses preferred.
- Push back on wrong reasoning immediately.
- Complete drop-in files preferred over diffs when explaining changes.
- Design approval required before code is written. All design questions asked at once before coding begins.
- Small ask: don't restate what the user just said as if it's a new insight.

**Methodology enforcement:**
- User will catch and reject untested claims. Don't bake untested assumptions into "polish" changes.
- If a change has untested behavior implications, label it as untested in code comments AND in output.

**Code preferences:**
- TypeScript strict mode. No silent failures.
- Explicit error handling — return typed errors, don't throw at API boundaries
- SQLite schema uses CHECK constraints to catch data regressions
- Files at reasonable length. Split when a file crosses ~600 lines.

**Documentation:**
- Filter rationales in code comments include the validation date and result
- E.g., "// VALIDATED FILTER (May 2026): IS PF 2.31, OOS PF 1.90, preservation 96.7%"
- This lets Claude Code sessions know provenance without full context reload

**Commit style:**
- Atomic commits per logical change
- Message format: `<panel/area>: <what changed>` (e.g., `jack: add SQLite persistence layer for Session A`)
- Include validation status if relevant (e.g., `deploy-ready` vs `SIM-testing` vs `research-only`)

**Git workflow:**
- Direct push to `main` is blocked by husky pre-push hook
- Feature branch workflow required for all code changes
- Branch naming: `<feature>-<short-desc>` (e.g., `jack-v1.3-persistence`, `iv-fix-cache-key`)
- Commits get squash-merged via GitHub PR
- Bypass only for docs-only changes: `$env:BYPASS_PUSH_PROTECTION=1; git push`

---

## 11. Key file locations

**In this repo (`C:\Repos\bloomberg-terminal\` on Win10 or VPS):**
- `PROJECT_STATE.md` — this file
- `app/api/jack-validation/route.ts` — main JACK backend
- `prompts/cup-handle-t05-validation.md` — the v5 prompt (edited through v1.2+ iterations)
- `contracts/jack-validation-response.schema.json` — response shape contract
- `lib/db/schema.sql` — SQLite tables (Session A onward)
- `components/bloomberg/views/jack-view.tsx` — JACK UI panel
- `components/bloomberg/hooks/useJackValidation.ts` — React Query hook with Jotai atom for persistence
- `.env.local` — API keys: `ANTHROPIC_API_KEY`, `TIINGO_API_KEY`

**External to this repo:**
- `botfolio` GitHub repo (private) — NT8 bot code, CommandCenter, CopyRouter
- Google Drive `MyDrive/Bukowski/` — Cup with Handle backtest data, Colab notebooks, results
  - `results/cup_handle_v2b_fires_with_clean_volume.csv` — feature pool
  - `results/cup_handle_v2b_exit_sweep/trades_t05.csv` — outcome R per trade
  - `results/winner_loser_test/` — Session A validation research artifacts
  - `results/pending_ranking_test/` — pending-snapshot ranking NULL artifacts
  - Per-ticker daily OHLCV: `<TICKER>.csv` at `MyDrive/Bukowski/` root (columns: Date, Open, High, Low, Close, Volume)
- Google Drive `MyDrive/Market Data Collector/` — futures market data
- Google Drive `MyDrive/Machine Learning/` — ML artifacts (QQE Pulse, UR discovery, etc.)

**Model to use for Claude calls in code:** `claude-sonnet-4-5`

---

## Update log (append below)

- **2026-07-04:** Initial write. PROJECT_STATE.md added as session-anchor for Claude Code workflow. All 8 sections filled in from current state as of mid-Session A deploy.

- **2026-07-04 (Session A complete):** JACK v1.3 SQLite persistence shipped to branch `jack-v1.3-persistence` (commit cb653e6), pushed for PR merge to main (PR dance same as v1.2). Five items done: (1) `lib/db/` — schema.sql (setups / validation_runs / decisions / outcomes + decision_outcomes view), init.ts (WAL singleton), write.ts, read.ts; (2) authored `lib/db/env.ts` persistence gate and wired route.ts persistence writes behind a Vercel guard (type-only imports at top, lazy `require("@/lib/db/write")` inside persistRun, early-return with "Persistence: disabled (running on Vercel)" when !isPersistenceAvailable()); (3) prompt appended with the v1.3 MACHINE-READABLE JSON block spec; (4) next.config.mjs `serverExternalPackages: ["better-sqlite3"]` moved INSIDE the config object; (5) better-sqlite3 moved from dependencies to optionalDependencies (Vercel install-tolerant). Verification approach: DB layer unit-tested against a live `data/jack.db` (schema load — 4 tables + view, upsert/insert/read, both guard paths, exact banner strings all confirmed), route tsc-clean for all new files; live Claude click-test gap acknowledged — no ANTHROPIC_API_KEY on the Win10 clone, deferred to VPS post-merge (~5% incremental confidence, repeats what v1.2 already proved about the Claude call). Intentional schema mismatch retained: Claude JSON contract uses `schema_version "1.3"` while the HTTP wrapper `JackValidationResponse.schemaVersion` stays `"1.2"` — Session B bumps the wrapper. The real test — better-sqlite3 native compile on Vercel serverless — runs when Vercel builds main after merge.
