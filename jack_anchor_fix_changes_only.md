# days_since_handle_low Anchor Fix — Changes Only

File: cup_handle_weekly.ipynb (Colab). One-line change, two cells touched.

## Cell 1 — Step 1 config/freshness cell (id: uJzf7ONpNrZU)
Add one line so the data's as-of date is available downstream.

AFTER (add this line right after `last_date = df['Date'].max()`):
    ASOF_DATE = last_date

## Cell 2 — Step 5 pending/just_fired cell (id: 9SA4S7fnNrZW)
Swap the anchor from wall-clock now() to the data's as-of date.

BEFORE:
    pdf['days_since_handle_low'] = (pd.Timestamp.now() - pdf['handle_low_date']).dt.days

AFTER:
    pdf['days_since_handle_low'] = (ASOF_DATE - pdf['handle_low_date']).dt.days

## Notes
- ASOF_DATE = last price bar (SPY last date). NOT now(), NOT fires['entry_date'].max().
- Unit unchanged (calendar days). Only the anchor changed.
- Run cells top-to-bottom after editing.
- Verify: WST=7, WNC/DGX=9, no negatives, rerun gives identical numbers.
