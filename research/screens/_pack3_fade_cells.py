# Cell sources for the pack 3 fade OOS notebook (opens 2025-01-01+ ONCE for the frozen rule only).
# Imported by _build_notebooks.py. Edit HERE, then rebuild.


def build(SETUP):
    S = SETUP.strip("\n")
    CELLS = [
        ("markdown", r'''
# Pack 3 — "Fade the first half hour": OUT-OF-SAMPLE (lockbox 2025-01-01+, OPENED ONCE)

Frozen rule and pass criteria: `research/screens/PACK3_FADE_PREREG.md` (F1-F3, pushed before any further look).
This notebook evaluates ONLY that rule on 2025+ data: no baselines, no splits, no variants. It refuses to recompute
once `pack3/fade_oos_result.json` exists.

- **Rule:** side = −sign(C1000 − C16(prev)); trade from the 15:30 close to the 16:00 close; P&L in points net of cost
  (MES 0.748, MNQ 1.12); $ per micro = points × 5 / × 2.
- **Exclusions:** early-close days + the next session; sessions missing any of the four bars.
- **Pass (per instrument, OOS):** net mean > 0 AND month-block 90% CI lower bound > 0.
- **Before opening:** a file-size check (the files as pre-registered) and the IS result of the same rule (context only).
'''),
        ("code", "# ===== Cell 0 — config (FROZEN — must equal F1/F2) =====\n" + S + r'''
import time
MDC = Path(os.environ.get('PACK3_MDC_DIR', '/content/drive/MyDrive/Market Data Collector'))
FILES = {'MES': MDC/'MES_1min_2000Days.csv', 'MNQ': MDC/'MNQ_1min_2000Days.csv'}
FROZEN_BYTES = {'MES': 593_316_436, 'MNQ': 650_287_626}
P3_DIR = OUT_DIR/'pack3'; P3_DIR.mkdir(parents=True, exist_ok=True)
MARKER = P3_DIR/'fade_oos_result.json'
ET = 'America/New_York'
IS_START, IS_END, OOS_START = pd.Timestamp('2021-02-10'), pd.Timestamp('2024-12-31'), pd.Timestamp('2025-01-01')
MULT = {'MES': 5.0, 'MNQ': 2.0}; TICK = 0.25; COMMISSION = 1.24
COST_PTS = {k: 2 * TICK + COMMISSION / m for k, m in MULT.items()}
BOOT_REPS, CI_LEVEL = 2000, 0.90
'''),
        ("code", r'''
# ===== Cell 1 — guards: opened once; same files as pre-registered =====
if MARKER.exists():
    print(open(MARKER).read())
    raise RuntimeError('lockbox already opened once for the fade rule — result above. Do not recompute.')
for inst, f in FILES.items():
    sz = f.stat().st_size
    assert sz == FROZEN_BYTES[inst] or os.environ.get('PACK2_TEST') == '1', f'{inst}: {sz} bytes != pre-registered {FROZEN_BYTES[inst]}'
    print(f'{inst}: {f.name} {sz:,} bytes (pre-registered {FROZEN_BYTES[inst]:,})')
'''),
        ("code", r'''
# ===== Cell 2 — loader (raw OHLCV only; same definitions as pack3_screen.ipynb @ ce03b12) + the frozen rule =====
def load_dates(path):
    hdr = pd.read_csv(path, nrows=0).columns
    low = {c.replace('﻿', '').lower().strip(): c for c in hdr}
    need = ['datetime', 'open', 'high', 'low', 'close', 'volume']
    d = pd.read_csv(path, usecols=[low[k] for k in need]); d.columns = need      # raw columns ONLY
    t = pd.to_datetime(d['datetime'], errors='coerce')
    t = t.dt.tz_convert(ET) if t.dt.tz is not None else t.dt.tz_localize(ET, ambiguous='NaT', nonexistent='NaT')
    d = d.assign(et=t).dropna(subset=['et'])
    date = d['et'].dt.tz_localize(None).dt.normalize(); mins = d['et'].dt.hour * 60 + d['et'].dt.minute
    d = d.assign(date=date, mins=mins)
    rth = d[(d.mins > 9 * 60 + 30) & (d.mins <= 17 * 60)]
    last_rth = rth.groupby('date')['mins'].max(); dates = last_rth.index
    early = last_rth[last_rth <= 14 * 60].index
    X = pd.DataFrame(index=dates)
    for k, m in {'C1000': 600, 'C1530': 930, 'C16': 960}.items():
        X[k] = d[d.mins == m].drop_duplicates('date', keep='last').set_index('date')['close'].reindex(dates)
    X['C16_prev'] = X['C16'].shift(1)
    X['early'] = X.index.isin(early); X['after_early'] = X['early'].shift(1, fill_value=False)
    ok = X[['C1000', 'C1530', 'C16', 'C16_prev']].notna().all(axis=1) & ~X.early & ~X.after_early
    return X[ok].copy()


def fade(X, cost):
    side = -np.sign(X['C1000'] - X['C16_prev']); m = side != 0
    g = (side * (X['C16'] - X['C1530']))[m]
    return pd.DataFrame({'side': side[m], 'gross': g, 'net': g - cost})


def month_ci(x, months, seed=0):
    x = np.asarray(x, float); ub, inv = np.unique(months, return_inverse=True)
    Sm = np.bincount(inv, weights=x); Cn = np.bincount(inv).astype(float)
    idx = np.random.default_rng(seed).integers(0, len(ub), (BOOT_REPS, len(ub))); mb = Sm[idx].sum(1) / Cn[idx].sum(1)
    a = (1 - CI_LEVEL) / 2
    return float(np.quantile(mb, a)), float(np.quantile(mb, 1 - a))


ALL = {}
for inst, f in FILES.items():
    t0 = time.time(); ALL[inst] = load_dates(f); print(f'{inst}: loaded [{time.time()-t0:.0f}s]')
'''),
        ("code", r'''
# ===== Cell 3 — IS context (2021-02-10 .. 2024-12-31; already-seen data; NOT part of the pass) =====
for inst, X in ALL.items():
    T = fade(X[(X.index >= IS_START) & (X.index <= IS_END)], COST_PTS[inst])
    lo, hi = month_ci(T.net.to_numpy(), np.asarray(T.index.to_period('M').astype(str)), 3)
    py = T.net.groupby(T.index.year).mean()
    print(f'IS {inst}: n={len(T)} | gross {T.gross.mean():+.3f} pt | net {T.net.mean():+.3f} pt CI90 [{lo:+.3f}, {hi:+.3f}] | '
          f'per year net: ' + ', '.join(f'{y}: {v:+.3f}' for y, v in py.items()))
'''),
        ("markdown", "## The one OOS evaluation (lockbox 2025-01-01+)"),
        ("code", r'''
# ===== Cell 4 — OPEN ONCE: frozen fade rule on 2025-01-01+ =====
assert not MARKER.exists()
OUT = {}
for inst, X in ALL.items():
    O = X[X.index >= OOS_START]
    T = fade(O, COST_PTS[inst]); mult = MULT[inst]
    lo, hi = month_ci(T.net.to_numpy(), np.asarray(T.index.to_period('M').astype(str)), 11)
    q = pd.DataFrame({'n': T.net.groupby(T.index.to_period('Q')).size(),
                      'mean_net_pt': T.net.groupby(T.index.to_period('Q')).mean(),
                      'usd_per_micro': T.net.groupby(T.index.to_period('Q')).sum() * mult})
    passed = bool(T.net.mean() > 0 and lo > 0)
    OUT[inst] = dict(oos_first=str(T.index.min().date()), oos_last=str(T.index.max().date()), n=int(len(T)),
                     hit=float((T.net > 0).mean()), gross_mean=float(T.gross.mean()), net_mean=float(T.net.mean()),
                     ci90=[lo, hi], usd_total=float(T.net.sum() * mult), passed=passed,
                     per_quarter={str(k): dict(n=int(r.n), mean_net_pt=float(r.mean_net_pt), usd=float(r.usd_per_micro))
                                  for k, r in q.iterrows()})
    print(f'\nOOS {inst} ({OUT[inst]["oos_first"]} .. {OUT[inst]["oos_last"]}): n={len(T)} hit {OUT[inst]["hit"]:.1%} | '
          f'gross {T.gross.mean():+.3f} pt (context) | NET {T.net.mean():+.3f} pt CI90 [{lo:+.3f}, {hi:+.3f}] | '
          f'total ${OUT[inst]["usd_total"]:+,.0f} per micro -> {"PASS" if passed else "FAIL"}')
    print('  per quarter:'); print(q.round(3).to_string().replace('\n', '\n  '))
    T.to_csv(P3_DIR/f'fade_oos_trades_{inst}.csv')
opened = pd.Timestamp.now(tz='UTC').isoformat()
json.dump(dict(opened_utc=opened, rule='fade first half hour (PACK3_FADE_PREREG.md F1)', results=OUT),
          open(MARKER, 'w'), indent=1, default=float)
print('\nPaste into F4 of PACK3_FADE_PREREG.md:')
for inst, r in OUT.items():
    print(f'| {inst} | {opened[:16]} | {r["n"]} | {r["net_mean"]:+.3f} | [{r["ci90"][0]:+.3f}, {r["ci90"][1]:+.3f}] | '
          f'{"yes" if r["passed"] else "no"} | {r["usd_total"]:+,.0f} | |')
'''),
    ]
    return CELLS
