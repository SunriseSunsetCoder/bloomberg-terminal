# JACK detector notebooks — VPS-runnable ports

These are the **validated Cup-with-Handle detector notebooks**, ported from Google
Drive (`MyDrive/Bukowski/`) so they can run headless on the VPS under papermill
instead of interactively in Colab.

Run them through `pipeline/run_detector.py`, never by hand — that script carries
the fail-loud guard that stops an unscored board from being published.

| File | Role |
|---|---|
| `cup_handle_active_scanner.ipynb` | The detector. Scans the per-ticker corpus for pending / just-fired setups. |
| `cup_handle_weekly.ipynb` | The orchestrator. Staleness filter, t05 re-pricing, handle score + size, watchlist + paste block. |

## What was changed in the port

**Only path and mount wiring.** Detection, scoring, filtering, sizing, ranking and
output columns are byte-identical to the Drive originals. Of the 8 scanner cells,
7 are untouched; of the 24 weekly cells, 21 are untouched.

### `cup_handle_active_scanner.ipynb`

| Cell | Change |
|---|---|
| new `[1]` id `papermill-parameters` | **Added.** Tagged `parameters`. Declares `DATA_DIR` / `OUT_DIR`, defaulting to the original Colab paths. |
| `[2]` id `NwSLomndmoEU` ("Cell 1 -- Setup") | `drive.mount` wrapped in `try/except ImportError` so it is skipped off-Colab. `DATA_DIR`/`OUT_DIR` now derive from the parameters instead of being hardcoded. Kept as **`str`** — the detector builds paths with f-strings. Every other line unchanged. |

Cells 2–6 (fires cache, SMA gate, the detector itself, the universe scan, the
save) read `DATA_DIR`/`OUT_DIR` but never reassign them, so they needed no edit.

### `cup_handle_weekly.ipynb`

| Cell | Change |
|---|---|
| new `[2]` id `papermill-parameters` | **Added.** Tagged `parameters`. Declares `DATA_DIR` / `OUT_DIR` / `SCANNER_ALREADY_RAN`, defaulting to the original Colab behaviour. |
| `[3]` id `uJzf7ONpNrZU` (config) | The two hardcoded path lines now derive from the parameters, coerced to **`Path`** — every constant below is built with `/`. `drive.mount` was already guarded. The handle-score helpers are unchanged. |
| `[7]` id `867Xx0L_NrZV` (Step 2) | The `%run` is now skipped when `SCANNER_ALREADY_RAN` is true. In Colab the flag stays `False` and the original `%run` path runs exactly as before. The trailing `DATA_DIR = Path('/content/...')` re-assert was removed. |
| `[11]` id `uNQ3jSl5NrZW` (Step 4) | Leading `DATA_DIR = Path('/content/...')  # re-assert after %run scanner` removed. |

Both removed re-asserts existed **only** to undo the scanner's clobbering of
`DATA_DIR` during `%run`. With the chain made explicit they have no purpose, and
leaving them would overwrite the papermill parameter with a Colab path.

## Why the parameters live in their own cell

papermill injects its override cell **immediately below** the cell tagged
`parameters`. Tagging the existing config cell would set `DATA_DIR` after
`OUT_DIR`, `FIRES_CSV`, `THRESHOLDS_JSON` and `WATCHLIST_CSV` had already been
derived from the original value — every one of them would still point at Drive.
A dedicated params cell above the derivation is the only placement that works.

## Why two papermill runs

`%run` is an IPython line magic; papermill executes one notebook top-to-bottom and
does not resolve it. So `run_detector.py` runs the scanner first, then the weekly
with `SCANNER_ALREADY_RAN=True`.

This is safe because the notebooks are coupled through a **file**, not shared
state: the scanner writes `<OUT_DIR>/cup_handle_active_setups.csv` and the weekly
reads it back into its own DataFrame. The weekly never reads a variable the
scanner defined (`_scanner_ok` is written in the scanner cell and read nowhere).

## Outputs are stripped

These notebooks are committed **output-free** — every `outputs` array is empty,
every `execution_count` is `null`, and Colab's per-cell `executionInfo` telemetry
is gone. Stale saved outputs in a notebook that now runs headless are a
confusion trap: someone opens the file, sees cell results from a Colab session
months ago, and reads them as current. papermill writes fresh outputs to
`pipeline/_out/<notebook>_<stamp>.ipynb` on every run, which is where you look
when a 19:00 run breaks.

Keep it that way — re-strip before committing if a notebook is ever opened and
run locally.

## Still Colab-compatible

Every default reproduces the original behaviour: open either notebook in Colab,
run top-to-bottom, and it mounts Drive and uses the Drive paths — the weekly still
`%run`s the scanner. The port adds a headless path; it does not remove the
interactive one.

## Data is not in git

The notebooks need a seeded corpus and the frozen `results/` artifacts, all
VPS-only and gitignored. The full seed list is in the module docstring of
`pipeline/run_detector.py` under **VPS-ONLY SEED**.
