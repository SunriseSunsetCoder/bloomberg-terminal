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

## P2. Drill primary rule — FROZEN AT: _(not yet; filled in by the freeze commit, before the 2025/2026 June OOS
read and before 2026-12-11)_

## P3. Results log (append only)

| event | read on | IJR − IWM | pass? | secondary | commit |
|---|---|---|---|---|---|
| June 2025 recon (OOS, frozen rule) | | | | | |
| June 2026 recon (OOS, frozen rule) | | | | | |
| December 2026 recon (P1) | | | | | |
