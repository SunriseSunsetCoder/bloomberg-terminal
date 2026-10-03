# Screens log — research/screens (append only)

All in-sample work: series cut at 2024-12-31 at load, IS entries 2011-2023 unless stated. Trials are logged in
`MyDrive/Bukowski/results/screens/screens_trial_log.csv`.

## Pack 1 — S1 turn-of-month, S2 pre-holiday, S3 Russell July (SPY / IJR−IWM)
- S3 was the only strong screen. It was drilled and **closed as a strategy**; see `S3_DRILL_PREREG.md` (P3, P5).
  The Dec-2026 / Jun-2027 / Dec-2027 forward tests stay registered, for the log only.
- S1 and S2 were not taken further.
- Trial log: pack 1 (8 rows) and the S3 drill grid (16 cells) were backfilled on 2026-10-03, flagged `backfilled`.

## Pack 2 — S4 dip-in-uptrend, S5 abnormal volume / quiet price, S6 overnight momentum (2026-10-03)
Notebooks: `screen_pack2_protocol.ipynb` (Step 0 U1 + martingale protocol) and `screen_pack2.ipynb` (gated real data).
- **Universes:**
  - U1 = SPY + 11 sector SPDRs (12; descriptive only). CEF/KYN/UTG were excluded as closed-end funds, and
    PAM/BNY/ERO reclassified as stocks.
  - U2 = top 300 stocks by trailing 60-bar $vol.
- **Selection null:** duration-matched. The own-exit version failed on drift worlds (holding-time × drift).

### Protocol — BINDING 64-seed run (2026-10-03 23:06 UTC; replaces the 16-seed run, archived `*_16seed_superseded`)
| family | mean pct | t | pass rate (≥90) | clustered binomial p |
|---|---|---|---|---|
| S4_T1 | 58.1 | 3.12 | 21.1% | 3.6e-06 |
| S4_T2 | 58.2 | 3.36 | 23.4% | 2.3e-08 |
| S4_T3 | 57.6 | 3.31 | 17.2% | 2.8e-04 |
| S5 | 45.0 | −1.94 | 14.1% | 0.036 |

- **Pooled pass rate:** S4 20.6%, S5 14.1% (≤ 15%).
- **Gates:**
  - S4: FAIL, on centring (|t| > 2.5) and the binomial.
  - S5: FAIL, on the binomial (centring passed).
  - **Both stay off real data. No reruns.**
- **Power:** NOT RUN. It runs only for screens whose null passed. The JSON's `power: false` means skipped, not failed.
- **Fixed horizons (S4 60, S5 20/60):** centred (|t| ≤ 1.7). Unused, since S4/S5 are off.
- **S6 protocol:** passed in both universes (U1 t −1.95, U2 t 0.04).

### Diagnosis (read from all 1,792 protocol records, 2026-10-03)
- **The S4 tilt is entirely the 10% disaster-stop variants:**
  - no stop: X1 49.6 (t −0.16), X2 49.8 (t −0.09);
  - stop: X1 65.3 (t 7.2), X2 67.1 (t 8.6).
- **It's independent of the trigger and the hold length:** T1/T2/T3 sit at 57.6-58.2, and X2 − X1 is 1.0 (t 0.7).
- **Likely mechanism, a fill artifact:**
  - The world's intrabar path has 12 discrete steps, and a stop fill at exactly the stop level after the path jumps
    through it gives the real trade free price improvement (≈ half a sub-step).
  - The duration-matched null trade carries no stop, so it gets none.
  - It scales with intrabar step size, i.e. with volatility, which is the only way volatility enters.
  - The same optimistic fill rule (fill at the stop when low ≤ stop, no slippage) flatters real-data backtests too.
- **S5:** failed on dispersion, not centring. U1 (12 ETFs, about 123 trades per config, 14% null misses) has 17-22% of
  its percentiles at ≥ 90 and 20-27% at ≤ 10. U2 S5_h60 leans conservative (39.1, t −3.3).

### Real data — S6 only (the gate allowed S6; `screen_pack2.ipynb`, run once)
| universe | months | avg net excess / month | months > 0 | verdict |
|---|---|---|---|---|
| U1 | 156 | −0.165% | 44% | not worth drilling |
| U2 | 156 | −0.295% | 47% | not worth drilling |

**S6 closed** in both universes. Trial log after this run: 26 trials (2 pack-2 S6 trials, plus 24 backfilled).

**Pack 2 outcome:** S4 and S5 are off real data (binding protocol). S6 was tested and closed. Nothing is worth
drilling.
