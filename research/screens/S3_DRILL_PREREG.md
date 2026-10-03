# S3 drill — pre-registration (written 2026-10-03, before any 2025+ data is opened)

## P1. December 2026 Russell reconstitution — out-of-sample prediction (LOCKED)

- **Event:** FTSE Russell December 2026 reconstitution, effective after the close of **2026-12-11**.
  If FTSE Russell's official effective date differs, the official date governs; nothing else changes.
- **Entry:** IJR and IWM closes on the recon date (the "recon close").
- **Exit:** closes on the 20th NYSE trading day after the recon date.
- **Measure:** compounded IJR total return minus compounded IWM total return, Tiingo adjClose, gross of costs.
- **Prediction:** **IJR − IWM > 0.** Pass = strictly positive. Fail = zero or negative. One event, one outcome.
- **Secondary (recorded but doesn't decide pass/fail):** the drill's frozen primary rule (see P2), applied to the
  same event, plus its excess over the same-length baseline once that baseline exists.
- **No changes allowed.** This section is not edited after this commit. The result goes in P3 below once it happens.
- **Caveat:** this is Russell's first semi-annual December recon. A pass or fail tests whether the June effect
  carries over to a different event type, not the June rule itself.

## P1a. Context note (added 2026-10-03; context only — NOT a rule change, P1 stands as committed in 3233bf3)

- FTSE Russell has confirmed the dates: rank day 2026-10-30, preliminary lists 2026-11-13, effective after the
  close on 2026-12-11. Markets open reconstituted on 2026-12-14.
- The December review is lighter than June: style changes apply only to new additions/IPOs and R1000↔R2000
  movers. A smaller effect than in June is plausible.
- A single event is weak evidence either way. A pass doesn't validate the effect and a fail doesn't kill it.

## P4. Further forward tests (added 2026-10-03, LOCKED; same terms as P1)

The same rule as P1 applies: entry at the recon close, exit at the close of the 20th NYSE trading day after.
The measure is compounded IJR minus IWM total return (Tiingo adjClose, gross). The prediction is
**IJR − IWM > 0**, and strictly positive passes. The drill's frozen primary rule (P2) is the same (0, 20) cell, so
its excess over the same-year baseline is recorded as secondary. FTSE Russell's official effective date governs.

| event | expected effective date (after close) |
|---|---|
| June 2027 recon | 2027-06-25 (4th Friday of June under the historical rule; official date governs) |
| December 2027 recon | per FTSE Russell's published calendar (not yet published) |

No changes allowed. Results are appended to P3.

## P2. Drill primary rule — FROZEN 2026-10-03 (this commit), before any 2025+ IJR/IWM data was read

- **Event:** each June Russell recon. The date is the last Friday of June, one week earlier if that Friday is the 29th/30th
  (2025-06-27, 2026-06-26).
- **Primary cell (0, 20):** entry at the recon close; exit at the close 20 trading days after the recon.
  It was fixed from screen S3 and NOT re-picked from the drill grid.
- **Statistic:** spread = compounded IJR − IWM (adjusted total return). Baseline = mean spread of all other
  non-overlapping 20-bar windows that start in the same year. Excess = spread − baseline.
- **Costs (base):** 5bp round trip on both legs + IWM borrow 0.5%/yr × 20/252 (9.0bp per event).
- **OOS read (June 2025 + June 2026, opened ONCE by `s3_drill_oos.ipynb`):** *supports* = both events have excess net of
  base cost > 0; *mixed* = one does; *against* = neither. Raw spread > 0 is reported alongside.
- **OOS data opened:** IJR/IWM adjusted closes 2025-01-01 .. 2026-09-30 only, kept in `reference/oos/`. The 2026
  baseline is a partial year. Everything else stays sealed after 2024-12-31.
- **Gate:** the OOS notebook needs the in-sample null check passed (`null_check.json`). It reports, but is not
  gated on, the in-sample drill verdict.
- **Frozen files** (sha256 of the LF bytes as committed, i.e. the GitHub raw file):
  - `s3_drill_oos.ipynb` `c6018db225241c23311198ff651410d6269490c10cceb3138f51b84a30108f6f`
  - `s3_drill.ipynb` `f5144ba4e8b2bf5cae2b4aa0eb2dff992c5d99af98b9d4289d639509f870fd93`

  Any later change to the in-sample drill (e.g. null-gate parameters) must leave `s3_drill_oos.ipynb` and this
  rule untouched. Such a change is logged here as an amendment, and only before the OOS read.

## P3. Results log (append only)

| event | read on | IJR − IWM | pass? | secondary | commit |
|---|---|---|---|---|---|
| June 2025 recon (OOS, frozen rule) | | | | | |
| June 2026 recon (OOS, frozen rule) | | | | | |
| December 2026 recon (P1) | | | | | |
| June 2027 recon (P4) | | | | | |
| December 2027 recon (P4) | | | | | |
