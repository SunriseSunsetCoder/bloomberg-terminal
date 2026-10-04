# Lockbox register — research/screens (append only)

Every held-out data period, its status, and what has looked at it. Check this before claiming any result is
out-of-sample. **SPENT means seen:** it can never again serve as an unseen test for any rule.

| data | held-out period | status | spent by / opened for | date | record |
|---|---|---|---|---|---|
| MES & MNQ 1-min (`Market Data Collector/*_1min_2000Days.csv`, uploaded 2026-07-02) | 2025-01-01 .. end of file (2026-07-01) | **SPENT** | pack 3 "fade the first half hour" (failed OOS) | 2026-10-04 | `PACK3_FADE_PREREG.md` F4-F5 |
| IJR & IWM daily (Tiingo, `reference/oos/`) | 2025-01-01 .. 2026-09-30 | **SPENT** | S3 drill frozen (0, 20) rule, June 2025 / June 2026 recons (OOS read: mixed) | 2026-10-03 | `S3_DRILL_PREREG.md` P3 |
| SPY + 11 sector SPDRs daily (corpus / reference) | 2025-01-01 .. | SEALED: opens ONCE, only if the S4b drill PRIMARY passes R2 | reserved for the frozen S4b T3 rule | — | `S4B_DRILL_PREREG.md` R4, R7 |
| Bukowski daily corpus (stocks, all other ETFs) and the 60-ETF replication set | 2025-01-01 .. | SEALED | — | — | cut at load in every screens notebook |

Forward tests, registered but not yet happened (not lockboxes): S3 December 2026 / June 2027 / December 2027 recons,
logged only (`S3_DRILL_PREREG.md` P1, P4).
