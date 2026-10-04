# S4b drill — pre-registration (frozen 2026-10-03, before any replication data is pulled)

Source: S4b in `SCREENS_LOG.md`. T3 X1 / T3 X2 were the best 2 of 15 trials on SPY + 11 sector SPDRs (2011-2023).
This drill tests whether they replicate on an INDEPENDENT ETF universe. The rule below is FROZEN; nothing in it may
change after this commit.

## R1. The frozen rule (exact; matches `s4b_event_study.ipynb` at commit b6a3749)
Daily bars: Tiingo adjusted O/H/L/C. All indicators are computed on adjusted closes, per ETF, causally.

- **Uptrend filter at the close of bar t:** C[t] > SMA200[t] AND SMA50[t] > SMA200[t].
  SMAs are simple means of the last 200 / 50 closes, including bar t; all must be present.
- **T3 trigger at the close of bar t:** C[t] < min(C[t-20], ..., C[t-1]).
  The close is strictly below the lowest close of the 20 prior bars, today excluded, all 20 present.
- **Entry:** at the OPEN of bar t+1 (the fill). Signal bars are such that the entry date is in 2011-01-03 .. 2023-12-29.
- **Exits** (bars counted from the entry bar e = t+1; the time stop is checked before the exit signal):
  - Time stop: the close of bar e+9 (10 bars held including the entry bar) closes the trade at that close.
  - **X1:** at the close of bar i (e ≤ i < e+9), if C[i] > SMA5[i] (SMA5 includes bar i) -> exit at the OPEN of bar i+1.
  - **X2:** at the close of bar i (e ≤ i < e+9), if RSI2[i] > 70 -> exit at the OPEN of bar i+1. RSI2 = Wilder RSI(2):
    the mean up/down close changes are EWM with alpha 0.5, adjust=False, and RSI = 100·up/(up+down), 50 if both are 0.
  - No disaster stop. A missing bar (gap / end of data) exits at the last available close.
- **Non-overlapping per ETF:** a new signal is taken only if its bar t ≥ the previous trade's exit bar.
- **Return:** gross = exit price / entry open − 1.
- **Cost:** 0.15% round trip, charged to the event only.
- **Excess per event** = gross − baseline − 0.15%.
  - The baseline is the mean return of a window with the SAME length (exit bar − entry bar) and the SAME exit price type
    (open for signal exits, close for time-stop / gap exits).
  - Baseline windows start on EVERY other uptrend day of the SAME ETF where T3 did not fire, with the signal day in the
    IS range and entry at that day's next open.
  - The baseline is gross.
- **Statistic:** pooled mean excess per event across ETFs (equal weight per event). Month-block bootstrap: 2,000
  resamples of entry months, 90% CI, q = 100 × share of bootstrap means > 0.

## R2. Pass criteria (ALL required)
- X1: q ≥ 95 AND CI90 lower bound > 0.
- X2: q ≥ 95 AND CI90 lower bound > 0.
- 2019-2023 mean excess > 0 for BOTH X1 and X2.

The per-year and qualifying-year leg of the screen is NOT part of the drill pass. It is reported only.

## R3. Reporting (descriptive, never part of the pass)
- Per year: n and mean excess.
- Per ETF: n and mean excess.
- **Regime check:**
  - events split by SPY's state on the signal day (SPY close above / below its SMA200);
  - results restricted to "SPY-weak years", meaning calendar years in which SPY closed below its SMA200 on ≥ 25% of
    trading days.

## R4. Validation and lockbox
- **Martingale world first:** the same null is validated on this universe, with 16 seeds, real listing spans and market
  drift (pack-2 generator). The check centres on gross excess and covers the T3 X1 / X2 rule only. Thresholds are
  fixed in the drill notebook before it runs. A fail means STOP, and the replication data is not evaluated.
- **IS:** 2011-2023. Every series is cut at load at 2024-12-31. Tiingo pulls request endDate = 2024-12-31.
- **Lockbox:** 2025-2026 data on the original 12 ETFs (SPY + 11 sector SPDRs) stays SEALED until the replication
  PASSES. It is then opened ONCE, for this frozen rule only. The replication universe's 2025+ data is sealed too.

## R5. Replication universes (rule frozen 2026-10-03, before any replication data is pulled)

### R5a. PRIMARY — 60 new ETFs (Tiingo adjusted daily)
- **Pool:** Tiingo `supported_tickers` rows with assetType ETF, a US exchange (NYSE, NYSE ARCA, NYSE MKT, AMEX,
  NASDAQ, BATS) and USD; first price date ≤ 2013-12-31 (trading by 2014-01-01); last date ≥ 2013-12-31. U1 (SPY +
  11 sector SPDRs) is excluded.
- **Ranking:** median daily dollar volume (raw close × raw volume) over calendar 2013, with ≥ 200 bars in 2013. Walk
  the ranked list and keep a fund unless an exclusion applies.
- **Exclusions:**
  - leveraged / inverse / volatility, by name (the pack-2 LEV pattern);
  - non-equity, by name: bond, treasury, muni, TIPS, floating-rate, loan, preferred, mortgage, aggregate, high-yield,
    corporate/credit, money market, bullion/commodity pools, currency trusts, dollar index, futures, covered-call /
    buy-write, allocation / target-date;
  - **near-duplicates of U1:** 2013 daily-return correlation > 0.95 with any U1 ETF.
- **Size and cap:** take the first **60** survivors, with **at most 20 country/region funds** (non-US underlying, by
  name). Funds beyond the cap are skipped.
- **Survivorship:** the ranking is point-in-time (2013). Funds that close later stay in until their last bar.
- The resulting list is printed, saved as `replication_universe.csv`, and frozen by sha256 in this file and in the
  notebook BEFORE any outcome is computed.

#### R5a amendment — rule v2 (2026-10-03, at universe review, BEFORE the freeze; no outcomes computed)
The first list (v1) had 4 classification errors: BNY (a single stock), AMJ (an ETN), MINT (short-maturity bond) and
CWB (convertible bond). Tiingo's `assetType` is unreliable: LLL, TSS and VR are single stocks listed only as ETF rows.
Added rules, applied in rank order while filling:
- **Ticker reuse:** exclude a ticker with more than one Tiingo `supported_tickers` row (mixed histories).
- **Fund identity:** the current Tiingo name must carry a fund marker (ETF / Fund / Trust / Index / Portfolio / Shares
  or a fund-issuer brand). The current entity's Tiingo start date must be ≤ 2013-01-02, so the 2013 history used for
  ranking belongs to the fund named today.
- **ETNs:** exclude ETN / ETNs / exchange-traded notes / ETN brands (iPath, ETRACS, ELEMENTS, VelocityShares).
- **Non-equity, added:** convertible, maturity, duration, ultra-short, short-term.

The list is refilled to 60 from the next-ranked candidates under the same rules, using cached 2013 data. The v1 list
is kept as `replication_universe_v1_superseded.csv`. It was never approved or frozen.

#### R5a amendment — rule v3 (2026-10-03, at universe review, BEFORE the freeze; no outcomes computed)
- **The error:** v2 #59 NKY ("Precidian MAXIS Nikkei 225 Index ETF") was labelled US-underlying because the
  country/region classifier had no index-name markers. Its 2013 correlation with U1 was −0.02 (stale prices).
- **Fix:** the classifier also matches country-index names: Nikkei, TOPIX, STOXX, DAX, Hang Seng, KOSPI, Sensex,
  Nifty, Bovespa, IBEX, CAC 40, ASX, TSX, Kokusai, World / All-World.
- **Effect:** re-checking all 60 v2 names, only NKY changes class. It becomes non-US, the 20-fund cap is already full,
  so the rule excludes it, and #60 is refilled by rule.
- **Not changed:** gold-miner and agribusiness industry funds (GDX, GDXJ, MOO) are global-holding industry funds that
  trade in North American hours. They're not country/region funds and stay as they are.

### R5b. SECONDARY — the existing stock universe (no new data)
- **Universe:** top 300 stocks by trailing 60-bar dollar volume (t-60..t-1), point-in-time. This is pack-2's U2: same
  asset file and overrides.
- **Rule:** the same frozen T3 rule (R1), measured against the same stock's own baseline. Signals AND baseline days
  require U2 membership on the signal day.
- **Labelled "SURVIVORSHIP-BIASED IN FAVOUR OF DIP-BUYING".** Survivors' dips recovered by construction.

### R5c. Pre-registered reading
| primary (ETFs) | secondary (stocks) | reading |
|---|---|---|
| PASS | any | **primary evidence: the T3 rule replicates** |
| FAIL | PASS | likely survivorship: does not replicate |
| FAIL | FAIL | does not replicate |

**"Replication passes" (R4 lockbox trigger) = the PRIMARY passes R2.**

### R5d. Validation for BOTH universes (martingale world, before either is evaluated)
- **Setup:** 16 seeds per universe; real listing spans; market drift; stocks keep their real volume (U2 membership).
  Per exit (X1, X2), on GROSS excess.
- **Centring:** mean excess |t| < 2.5, and mean q in [40, 60] with |t| < 2.5.
- **False pass:** the share of seeds meeting the gross R2 pass (both exits q ≥ 95 and CI90 lower bound > 0, era > 0)
  must be ≤ 10%.
- **Power:** +1.0%/bar planted for 3 bars after a > 2σ down close. Both exits must reach q ≥ 95 in ≥ 3 of 4 seeds.
- **Gating:** each universe is gated on its own validation. A fail means that universe is not evaluated.
- **Trials:** 4 (2 universes × X1/X2), appended to the screens trial log.

## R6. Results log (append only)
| step | date | result | commit |
|---|---|---|---|
| universe rule frozen | 2026-10-03 | v3 list approved: 60 ETFs, `replication_universe.csv` sha256 `c19109be7f9d2f7e5a250cbec1e07670eb36f02a28f3f29eecb9eae7c733f9c7` | this commit |
| martingale validation (replication universe) | | | |
| replication (IS 2011-2023) | | | |
| lockbox 2025-26, original 12 (only if replication passes) | | | |
