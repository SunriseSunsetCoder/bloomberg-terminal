# Bloomberg Terminal — Product State

_The research + execution product as a whole. Rolls up into `futures-state.md`; its JACK module detail lives in `jack-state.md`. Last updated: 2026-07-26._

## What it is

A Bloomberg-terminal clone that surfaces validated swing-trade setups, position sizing, and automatic outcome tracking. Multi-tab terminal UI with a left sidebar. The flagship tab is **JACK** (Cup-with-Handle t05). Served locally at `http://localhost:3000`.

## Stack & infra

- **Next.js 16 + TypeScript + SQLite.** React Query (`@tanstack/react-query`) for client data; Upstash Redis for server caches; edge-runtime API routes where used.
- Repo: `bloomberg-terminal` (GitHub `SunriseSunsetCoder/bloomberg-terminal`). All code edits go through **Claude Code** (CLI); everything goes through git.
- Runs on two boxes: **Win10** (dev) and **VPS** (prod). **The VPS runs the app via `npm run dev` (Turbopack), NOT a prod build** — see Build gotchas below. Deploy to the VPS = `git pull` + restart the dev server (no build step in the normal path).
- Charts: `lightweight-charts` v4.

## Data pipeline & external services

- **Tiingo** EOD + news, via `/api/tiingo/eod/[ticker]?days=N&startDate=&raw=1`. Tiingo **IEX** intraday (batch `/iex/?tickers=...`) powers JACK's price-refresh — IEX is included in the Power plan at no extra cost; read `tngoLast` (not `last`, which is null after hours). NOTE: Tiingo **earnings** is a paid add-on we do NOT have — no earnings dates come from Tiingo despite older "EOD+news+earnings" labels.
- **Finnhub** free-tier earnings calendar (`/calendar/earnings?from=&to=&token=`, one call/day, ~1-month forward window on free — plenty) powers JACK's earnings alert. Plain HTTPS, no npm dependency, best-effort coverage (US-listed; a missing micro-cap just gets no alert). **Dormant until `FINNHUB_API_KEY` is set.**
- **Telegram** — JACK trade alerts push to a dedicated channel via Tee's existing bot (reused token). Simple HTTPS `sendMessage`. Detail in `jack-state.md`.
- **Scanner** — the Colab notebook **`cup_handle_weekly.ipynb`** (Drive `Bukowski` folder), run **weekly** by Tee. It computes `handle_score` + tier (Q3/Q4/Q5) + size bucket + R:R + priority/P-rank + sector and the setup geometry, and outputs the setup CSV that feeds the terminal. It also pulls per-ticker price CSVs + 11 SPDR sector ETFs + SPY into Drive. (A sibling notebook `cup_handle_active_scanner.ipynb` sits in the same folder — a separate/variant scanner; role not yet confirmed.)
- Sector map `ticker_sectors.json` (24,868 tickers, 99.7% coverage) — Tee uploads to Drive manually (inline Drive upload is unreliable, no delete tool).
- **Env lives in `.env.local`**: `TIINGO_API_KEY`, Upstash Redis url/token, `JACK_SELF_BASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_TRADE_CHAT_ID`, `FINNHUB_API_KEY`. Next loads it automatically for the app, but a standalone `npx tsx script.ts` does NOT — use `npx tsx --env-file=.env.local ...` (applies to `jack-iex-reachability`, `jack-telegram-test`, `jack-finnhub-test`); a "FAIL: … not set" from a bare `npx tsx` is a false negative, not a real missing key. Restart the dev server after any env change (env only loads at startup).

## Modules / tabs

- **JACK** — Cup-with-Handle t05 live + pending. The deep detail (strategy, sizing, selection, features, price-refresh, Telegram alerts, outcomes) is in `jack-state.md`.
- **Sector-strength panel (F1)** — main-page panel ranking 11 GICS SPDR ETFs on RS-3M vs SPY, Redis-cached 1hr. Context only, NOT a trade filter (see the sector-declaw note in `jack-state.md`).
- **Ask-AI box** — in-terminal Q&A, edge runtime, Vercel AI SDK + Anthropic. (Was silently broken; fixed by pinning `ai` to v4 — see pins below.)
- _(Other tabs exist in the terminal UI but aren't yet captured here — fill in as they're worked on.)_

## Version pins (do not bump without testing)

- `ai` → **^4.3.0** — v6 removed `toDataStreamResponse` and broke the ask-AI box.
- `@ai-sdk/anthropic@1.2`, `@ai-sdk/react@1.2`.
- `lightweight-charts` → **^4.2.3** — v5's `addSeries(CandlestickSeries)` is a breaking change vs v4's `addCandlestickSeries()` / `addHistogramSeries()`.
- `typescript.ignoreBuildErrors` → **false** (true had been hiding the `ai` breakage).

## Build gotchas (Node 24 + Turbopack — cost a long debug session 2026-07-24)

**The prod build (`npm run build`) currently fails on the VPS; the app runs fine because it's served via `npm run dev`.** The failure and what we learned:

- **Root cause: Node version.** The VPS runs **Node v24.15**. Next.js 16 is tested/supported on Node **20 & 22 LTS**. Under Node 24, `next build` aborts while prerendering the synthetic `/_global-error` and `/_not-found` pages with `InvariantError: Expected workStore to be initialized`. It reproduces only on the VPS (Node 24), not where Claude Code builds (Node 20/22) — that sandbox-vs-VPS split is what made it hard to chase. **The real fix for a prod build is downgrading the VPS to Node 22 LTS.** Not urgent, since the app runs via dev.
- Ruled out along the way: stale `.next` (wiped, still failed); `NODE_ENV` override in env/process (none present); a custom `app/global-error.tsx` (added, didn't fix it — synthetic `/_not-found` still failed).
- **Build script switched to `next build --webpack`** (secondary Turbopack workaround; got past `/_global-error` but not `/_not-found`, because the deeper cause is Node 24). Turbopack stays the default for `next dev`. Drop `--webpack` once on Node 22 and/or Next patches it.
- **Route-file export rule (enforced by the webpack build):** a Next `route.ts` may export ONLY route handlers (`GET`/`POST`/…) + allowed config (`maxDuration`/`dynamic`). Any other export is a type error (`Diff<…allowed…>` vs an index signature of `never`). Turbopack wasn't checking this and had been hiding a whole set. Fix: core logic was moved into `lib/jack/validation-core.ts` (CSV parse / filter / JSON-extract / row-build) and `lib/jack/outcome-tracker.ts` (`runOutcomeTracker`, `DEFAULT_RESOLUTION_DAYS`, etc.); route files now export only handlers.

## Deploy lessons

- **Dependency changes:** when a commit changes `package.json` to add/bump a dependency, every box that *builds* needs `npm install` before building (not pull-and-restart). `npm ls <pkg>` diagnoses a node_modules vs package.json mismatch. Root cause of both the `ai@6` "same error" and the `lightweight-charts` "Module not found". (Note: since the VPS runs via `dev`, dependency adds still need `npm install` there before restarting dev.)
- **Normal VPS deploy** (code-only, the common case): `git pull origin main` → restart the `npm run dev` server. No build, no install.

## In-repo memory files (Claude Code's, in the git repo — separate from these project docs)

App-level: `ai-sdk-v4-pin.md`, `lightweight-charts-v4-pin.md`, plus notes on the webpack switch / route-export rule / Node-24 build issue. JACK-level: `jack-sector-tier-priority.md`, `jack-owned-routing-auto-outcomes.md`, `jack-sector-declaw.md`, `jack-detail-enrichment-and-roadmap.md`, `jack-price-refresh.md`, `jack-telegram-alerts.md`.

## Note on where state lives

As of 2026-08-15 the state docs (`futures-state.md`, `bloomberg-terminal-state.md`, `jack-state.md`, `options-overlay-tier1.md`) live IN THE GIT REPO (root), consolidated to one place so Claude Code and the Cowork session share a single source of truth (Cowork edits them through the device bridge). They are no longer duplicated as claude.ai project docs. (Historical note: they were previously project docs that Claude Code could not write; that split is retired.)
