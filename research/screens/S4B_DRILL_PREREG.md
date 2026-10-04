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

## R5. Replication universe
The selection rule is set by the design approval (next commit) and frozen BEFORE any replication price data is pulled.
It is a rule only: liquidity / listing / asset-class screens, never results.

## R6. Results log (append only)
| step | date | result | commit |
|---|---|---|---|
| universe rule frozen | | | |
| martingale validation (replication universe) | | | |
| replication (IS 2011-2023) | | | |
| lockbox 2025-26, original 12 (only if replication passes) | | | |
