# JACK t05 → Options overlay — Tier-1 finding (2026-07-29)

_Research question, not a build. Does the validated JACK stock edge survive as long options? Tier-1 = BS overlay on existing stock trades, estimated IV, no options data. Not financial advice._

## Setup
- Data: `trades_t05_15yr.csv` (Drive/Bukowski), 13,361 trades. **Taken = Q3∪Q4∪Q5 = 7,605** (CSV still tags Q3 `half`; treated as full per live SIZE_MAP).
- Stock baseline on taken: **PF 2.90, win 70.2%, avg R +0.56.**
- IV proxy = ATR-derived realized vol `σ=(ATR/entry)·√252`, ATR≈(entry−stop)/handle_depth_atr. Median 49%. Estimated, not real; stressed ±25%.
- Exit rule = mirror the stock (mark option at actual exit price/date). Structures: deep-ITM 0.80Δ, ATM, debit spread (long ATM / short at t05 target). Engine verified vs textbook BS.

## Result — edge mostly does NOT transfer
Profit factor (full universe):
- **Frictionless:** deep-ITM 1.7–1.9, ATM 1.2–1.5, spread 2.5–3.0. Structural edge partly survives; ATM weakest (modest +6% target barely clears ~11% ATM premium — the theta drag prior was right).
- **With realistic cost:** deep-ITM is the ONLY survivor and only for liquid names at tight spreads — PF ~1.25 at 2% half-spread (vs stock 2.90), <1.0 by 5%. ATM sub-1 in nearly all real cases. Spread collapses under any cost (4-leg bid/ask + early-exit residual time value), despite being best frictionless.
- Cost, not theta, is the killer. ~8% of taken trades <\$10, ~2% <\$5 (little/no options) — the microcap slice lives in the 5–10% spread band where nothing works.
- IV stress: ITM swings 1.53↔1.03 (±25% vol). Earnings-style −30% crush at winners → ITM 0.86. Fragile.

## Verdict: Tier-2 = qualified GO, narrow
Only two decisive questions Tier-1 can't answer (need real IV + real fills):
1. Deep-ITM on liquid subset — does ~1.25 PF hold with true chain IV/spreads? (If real liquid spreads ≥5%, it's dead — stop.)
2. Debit spread with net-mid fills + hold-to-expiry — can the best-frictionless result survive true 4-leg costs?
Scope to optionable/liquid names (ORATS/Polygon), deep-ITM + hold-to-expiry spreads only. Skip ATM and the microcap universe.

## Artifacts
Local session: `engine.py`, `sweep.py`, `results_matrix.csv`, `JACK_options_Tier1.md` (delivered to user). Reproducible from the trades export alone.
