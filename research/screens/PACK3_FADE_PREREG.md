# Pack 3 follow-up — "Fade the first half hour": pre-registration (written 2026-10-04T03:07:01Z)

Written BEFORE any further look at the data, and before the lockbox (2025-01-01+) is opened. The rule below is FROZEN.

## Origin (in-sample, already seen)
In screen pack 3 (IS 2021-02-10 .. 2024-12-31), the SECONDARY signal (first half-hour momentum) was significantly
NEGATIVE: MNQ sign-shuffle pct 3.0 with 0/4 years positive; MES pct 12.7. The fade inverts it. **The direction was
chosen after seeing IS results**, which is exactly why the test is out-of-sample.

Proposed mechanism: dealer long-gamma dampening in the 0DTE era. A morning move is hedged against into the close.

## F1. Frozen rule (per instrument: MES, MNQ)
- **Data:** `MyDrive/Market Data Collector/MES_1min_2000Days.csv` (593,316,436 bytes) and `MNQ_1min_2000Days.csv`
  (650,287,626 bytes), the files as uploaded 2026-07-02.
  - **Columns:** ONLY DateTime / Open / High / Low / Close / Volume are used; derived columns are ignored.
  - **Clock and prices:** ET, close-labelled bars. Additive back-adjusted: everything is in POINTS.
- **Prices** (closes of close-labelled bars): C16(prev) = the 16:00 bar of the previous trading date; C1000, C1530,
  C16 = the 10:00, 15:30 and 16:00 bars of the date.
- **Signal:** S = C1000 − C16(prev). **Side = −sign(S)** (S = 0: no trade).
- **Trade:** from the 15:30 close to the 16:00 close, flat overnight.
  - **P&L per contract (points)** = side × (C16 − C1530) − cost.
  - **Cost per round trip:** 1 tick of slippage each way + $1.24 commission. That's MES 0.5 + 1.24/5 = **0.748 pt**;
    MNQ 0.5 + 1.24/2 = **1.12 pt**.
  - **$ per micro** = points × $5 (MES) or × $2 (MNQ).
- **Exclusions:**
  - early-close days (last RTH bar ≤ 14:00 ET), plus the trading session after each;
  - sessions missing any of the four bars.
  - A "trading date" is a date with RTH bars (09:31-17:00 ET). These definitions match `pack3_screen.ipynb` at
    commit `ce03b12`.

## F2. Pass criteria (per instrument, OOS)
- **OOS period:** 2025-01-01 through the last complete trading session in the files above.
- **Pass** = net mean per trade > 0 AND month-block bootstrap 90% CI lower bound > 0 (2,000 resamples of entry
  months).
- **Reported:** n, hit rate, net mean (points), CI90, per quarter (n, mean net points, $ per micro), total $ per micro.
  The gross mean is shown for context only.
- **MES and MNQ are highly correlated:** a pass on both is close to one result, not two independent ones.

## F3. Lockbox discipline
- The lockbox is opened **ONCE**, by `pack3_fade_oos.ipynb`, for this frozen rule ONLY.
- **No other rule is evaluated on 2025+ data:** no baselines, no splits, no variants. The notebook refuses to
  recompute once its result file exists.
- **Before opening:** the notebook checks the file sizes, and prints the IS (2021-02-10 .. 2024-12-31) result of this
  same rule. That's context only, since IS data has already been seen.

**Frozen OOS notebook:** `pack3_fade_oos.ipynb`, sha256 `8b43c14b56cb0d4347ba0cd4ab4657b7dce103c47d1e19490a1353fb7d2c05b8` (LF bytes as committed). It checks the
file sizes (F1), prints the IS context, then opens 2025+ once.

## F4. Results log (append only)
| instrument | opened (UTC) | OOS n | net mean (pt) | CI90 | pass? | $ per micro (total) | commit |
|---|---|---|---|---|---|---|---|
| MES | 2026-10-04T03:14 | 353 | −0.914 | [−2.504, +0.739] | **no** | −1,614 | F5 commit |
| MNQ | 2026-10-04T03:14 | 356 | −0.807 | [−7.935, +6.114] | **no** | −574 | F5 commit |

OOS window: 2025-01-02 .. 2026-07-01, from `pack3/fade_oos_result.json`.

| quarter | MES n | MES mean net (pt) | MES $/micro | MNQ n | MNQ mean net (pt) | MNQ $/micro |
|---|---|---|---|---|---|---|
| 2025Q1 | 57 | −3.244 | −924 | 58 | −1.904 | −221 |
| 2025Q2 | 59 | +3.349 | +988 | 59 | +17.452 | +2,059 |
| 2025Q3 | 59 | −3.625 | −1,069 | 59 | −7.951 | −938 |
| 2025Q4 | 59 | +0.862 | +254 | 60 | +2.642 | +317 |
| 2026Q1 | 59 | +0.616 | +182 | 59 | +5.795 | +684 |
| 2026Q2 | 59 | −3.333 | −983 | 60 | −18.808 | −2,257 |
| 2026Q3 | 1 | −12.248 | −61 | 1 | −109.370 | −219 |

Gross mean (context only): MES −0.166 pt, MNQ +0.313 pt. Hit rate: MES 45.0%, MNQ 47.2%.

## F5. Outcome (recorded 2026-10-04)
- **The fade hypothesis FAILED out of sample on BOTH instruments.** The net mean is negative and the CI90 includes 0
  for both, so neither meets "net > 0 AND CI90 lower bound > 0". **Screen pack 3 is CLOSED.**
- **LOCKBOX SPENT:** the MES/MNQ 1-minute data from 2025-01-01 onward (files as in F1) has now been SEEN. No future
  rule may claim that period as unseen or out-of-sample. See `LOCKBOX_REGISTER.md`.
