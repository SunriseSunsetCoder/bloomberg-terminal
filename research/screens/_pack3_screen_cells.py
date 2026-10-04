# Cell sources for screen pack 3 (market intraday momentum, last half-hour, MES / MNQ).
# Imported by _build_notebooks.py. Edit HERE, then rebuild.


def build(SETUP):
    S = SETUP.strip("\n")
    CELLS = [
        ("markdown", r'''
# Screen pack 3 — market intraday momentum (last half-hour) on MES and MNQ (TRIALS)

Pre-registered 2026-10-04, after Step 0 (`pack3_step0.ipynb`).

**Data:**
- **Columns:** ONLY DateTime / Open / High / Low / Close / Volume; every other column is ignored (possible
  look-ahead).
- **Clock:** ET, close-labelled bars.
- **Back-adjusted (additive):** everything is computed in POINTS (signals, P&L, costs); $ per micro is derived from
  points. There are no percent returns on price levels.
- **Lockbox:** rows ≥ 2025-01-01 ET are cut at load. **IS = 2021-02-10 .. 2024-12-31.**

**Prices** (closes of close-labelled bars):
- C16(prev) = the 16:00-labelled bar of the previous trading date.
- C1530 and C1000 = the 15:30- and 10:00-labelled bars of the date.
- C16 = the 16:00-labelled bar of the date.

**Signals and trade:**
- **PRIMARY:** S = C1530 − C16(prev).
- **SECONDARY:** S2 = C1000 − C16(prev).
- **Trade:** sign(S) from the 15:30 close to the 16:00 close, flat overnight. P&L = sign × (C16 − C1530) − cost.
- **Cost per round trip:** 1 tick of slippage each way + $1.24 commission. That's MES 0.5 + 1.24/5 = **0.748 pt**
  and MNQ 0.5 + 1.24/2 = **1.12 pt**.
- **$ per micro** = points × $5 (MES) or × $2 (MNQ).

**Exclusions:**
- Sessions missing any needed bar (rolls need no other treatment on additive back-adjusted data).
- Early-close days (last RTH bar ≤ 14:00 ET), plus the trading session after each.

**Reported per instrument × signal (4 TRIALS):**
- n, hit rate, gross / net points, and a month-block 90% CI on the net mean;
- per year: n, mean net points and $ P&L per micro;
- baseline: always long for the last 30 min;
- descriptive splits: |signal| terciles (IS edges), and trailing 20-session realised-vol terciles (causal, in points);
- the sign-shuffle permutation percentile (signs permuted within each year).

**Verdict (pre-registered):** *worth drilling* iff ALL of:
- net mean > 0 AND month-block CI90 lower bound > 0;
- net mean > 0 in ≥ 3 of the 4 IS years;
- net mean over 2022-2024 > 0.

**Null validation FIRST (standing rule; fail = STOP).**
- **Worlds:** 16 martingale 1-minute worlds on each instrument's real IS session calendar: arithmetic random walk
  in points, overnight + U-shaped intraday volatility, small drift, scale from the real sd of the two windows.
- **Checks per instrument × signal:**
  - centring of the sign-shuffle percentile over seeds: mean in [40, 60] and |t| < 2.5;
  - GROSS verdict false-pass rate ≤ 10%. Gross because net is negative by construction.
- **Power (per signal):** a planted continuation (last-30-min drift = +0.10 × sd(last 30) × sign of THAT signal) must
  pass the gross verdict in ≥ 3 of 4 seeds.
- **Gating:** each instrument × signal runs on real data only if its validation passed.
'''),
        ("code", "# ===== Cell 0 — config =====\n" + S + r'''
import time
MDC = Path(os.environ.get('PACK3_MDC_DIR', '/content/drive/MyDrive/Market Data Collector'))
FILES = {'MES': MDC/'MES_1min_2000Days.csv', 'MNQ': MDC/'MNQ_1min_2000Days.csv'}
P3_DIR = OUT_DIR/'pack3'; P3_DIR.mkdir(parents=True, exist_ok=True); P3_PROTO = P3_DIR/'pack3_protocol.json'
ET = 'America/New_York'
CUT_ET = pd.Timestamp('2025-01-01', tz=ET)             # LOCKBOX
IS_START, IS_END = pd.Timestamp('2021-02-10'), pd.Timestamp('2024-12-31')
IS_YEARS = [2021, 2022, 2023, 2024]; MIN_POS_YEARS = 3; LATE = (2022, 2024)
MULT = {'MES': 5.0, 'MNQ': 2.0}; TICK = 0.25; COMMISSION = 1.24
COST_PTS = {k: 2 * TICK + COMMISSION / m for k, m in MULT.items()}   # MES 0.748, MNQ 1.12
SIGNALS = {'PRIMARY': 'C1530', 'SECONDARY': 'C1000'}                 # signal = that close - prior C16
N_PERM, BOOT_REPS, CI_LEVEL = 2000, 2000, 0.90
P3_SEEDS = int(os.environ.get('P3_SEEDS', 16)); P3_POWER_SEEDS = int(os.environ.get('P3_POWER_SEEDS', 4))
PLANT_K = 0.10                                          # power: last-30 drift = PLANT_K x sd(last 30) x sign(that signal)
FALSE_PASS_MAX = 0.10
TRIAL_LOG, TRIAL_RET = OUT_DIR/'screens_trial_log.csv', OUT_DIR/'screens_trial_returns.csv'
print('cost per round trip (points):', COST_PTS)
'''),
        ("code", r'''
# ===== Cell 1 — load (raw OHLCV only, cut at load) -> one row per IS session =====
def load_sessions(path):
    hdr = pd.read_csv(path, nrows=0).columns
    low = {c.lower().strip(): c for c in hdr}
    need = ['datetime', 'open', 'high', 'low', 'close', 'volume']
    missing = [k for k in need if k not in low]; assert not missing, f'missing columns {missing} in {list(hdr)}'
    d = pd.read_csv(path, usecols=[low[k] for k in need])            # raw columns ONLY (derived ones ignored)
    d.columns = need
    t = pd.to_datetime(d['datetime'], errors='coerce')
    t = (t.dt.tz_convert(ET) if t.dt.tz is not None else t.dt.tz_localize(ET, ambiguous='NaT', nonexistent='NaT'))
    d = d.assign(et=t).dropna(subset=['et'])
    d = d[d['et'] < CUT_ET]                                          # LOCKBOX: cut at load
    et = d['et']; date = et.dt.tz_localize(None).dt.normalize(); mins = et.dt.hour * 60 + et.dt.minute
    d = d.assign(date=date, mins=mins)
    rth = d[(d.mins > 9 * 60 + 30) & (d.mins <= 17 * 60)]
    last_rth = rth.groupby('date')['mins'].max()
    trade_dates = last_rth.index                                     # dates with RTH bars
    early = last_rth[last_rth <= 14 * 60].index                      # early-close days
    pick = {'C1000': 10 * 60, 'C1530': 15 * 60 + 30, 'C16': 16 * 60}
    X = pd.DataFrame(index=trade_dates)
    for k, m in pick.items():
        X[k] = d[d.mins == m].drop_duplicates('date', keep='last').set_index('date')['close'].reindex(trade_dates)
    X['C16_prev'] = X['C16'].shift(1)                                # previous TRADING date's 16:00 close
    X['early'] = X.index.isin(early); X['after_early'] = X['early'].shift(1, fill_value=False)
    # causal trailing 20-session realised vol of close-to-close changes, in points (up to the previous session)
    X['rv20'] = (X['C16'] - X['C16_prev']).rolling(20, min_periods=15).std().shift(1)
    X = X[(X.index >= IS_START) & (X.index <= IS_END)]
    ok = X[['C1000', 'C1530', 'C16', 'C16_prev']].notna().all(axis=1) & ~X.early & ~X.after_early
    info = dict(raw_rows=len(d), first=str(et.iloc[0]), last_pre_cut=str(et.iloc[-1]), is_dates=len(X),
                early=int(X.early.sum()), after_early=int(X.after_early.sum()),
                missing_bar=int((~X[['C1000', 'C1530', 'C16', 'C16_prev']].notna().all(axis=1)).sum()), kept=int(ok.sum()))
    return X[ok].copy(), info


SESS = {}
for inst, path in FILES.items():
    t0 = time.time(); SESS[inst], info = load_sessions(path)
    print(f'{inst}: {info}  [{time.time()-t0:.0f}s]')
    assert SESS[inst].index.max() <= IS_END
'''),
        ("code", r'''
# ===== Cell 2 — strategy + statistics (points) =====
def month_ci(x, months, seed=0):
    x = np.asarray(x, float); ub, inv = np.unique(months, return_inverse=True)
    Sm = np.bincount(inv, weights=x); Cn = np.bincount(inv).astype(float)
    idx = np.random.default_rng(seed).integers(0, len(ub), (BOOT_REPS, len(ub))); mb = Sm[idx].sum(1) / Cn[idx].sum(1)
    a = (1 - CI_LEVEL) / 2
    return float(np.quantile(mb, a)), float(np.quantile(mb, 1 - a))


def strat(X, sig_col, cost):
    s = X[sig_col] - X['C16_prev']; side = np.sign(s); last30 = X['C16'] - X['C1530']
    m = side != 0
    g = (side * last30)[m]; n_ = g - cost
    return pd.DataFrame({'sig': s[m], 'side': side[m], 'last30': last30[m], 'gross': g, 'net': n_, 'rv20': X['rv20'][m]})


def evaluate(T, seed=0, gross=False):
    v = T['gross'] if gross else T['net']; yr = T.index.year; mo = T.index.to_period('M').astype(str)
    lo, hi = month_ci(v.to_numpy(), np.asarray(mo), seed)
    py = v.groupby(yr).mean().reindex(IS_YEARS)
    late = v[(yr >= LATE[0]) & (yr <= LATE[1])].mean()
    verdict = bool(v.mean() > 0 and lo > 0 and (py > 0).sum() >= MIN_POS_YEARS and late > 0)
    return dict(n=len(v), mean=float(v.mean()), lo=lo, hi=hi, hit=float((v > 0).mean()), per_year=py,
                late=float(late), n_pos_years=int((py > 0).sum()), verdict=verdict)


def perm_pct(T, seed=0, gross=False):
    """Sign-shuffle null: permute the trade sides WITHIN each year (keeps each year's long/short counts)."""
    rng = np.random.default_rng(seed); col = 'gross' if gross else 'net'
    l30 = T['last30'].to_numpy(); side = T['side'].to_numpy(); yr = T.index.year.to_numpy()
    cost = (T['gross'] - T[col]).to_numpy()
    real = T[col].mean(); groups = [np.nonzero(yr == y)[0] for y in np.unique(yr)]
    sims = np.empty(N_PERM)
    for i in range(N_PERM):
        sp = side.copy()
        for gi in groups: sp[gi] = rng.permutation(side[gi])
        sims[i] = (sp * l30 - cost).mean()
    return float(100 * (sims < real).mean())
'''),
        ("markdown", "## Null validation — martingale 1-minute worlds (must pass before real data)"),
        ("code", r'''
# ===== Cell 3 — worlds on the real IS calendar; 16 seeds + power =====
MINS = np.arange(18 * 60 + 1 - 24 * 60, 16 * 60 + 1)                 # 18:01 prev day .. 16:00 (minutes vs midnight)
RTH0, RTH1 = 9 * 60 + 30, 16 * 60
prof = np.where(MINS <= RTH0, 0.35, 1.0 + 1.5 * np.exp(-(MINS - RTH0) / 30.0) + 1.0 * np.exp(-(RTH1 - MINS) / 30.0))
i1000, i1530, i1600 = (np.nonzero(MINS == m)[0][0] for m in (10 * 60, 15 * 60 + 30, 16 * 60))


def world(inst, seed, plant=0.0, plant_sig='C1530'):
    X = SESS[inst]; n = len(X); rng = np.random.default_rng(40_000 + seed)
    real_day_sd = (X['C16'] - X['C16_prev']).std()
    unit = real_day_sd / np.sqrt((prof ** 2).sum())                  # per-minute scale so the session sd matches real
    inc = rng.normal(0.0, 1.0, (n, len(MINS))) * (unit * prof)[None, :]
    inc += 0.02 * real_day_sd / len(MINS)                            # small positive drift (martingale + drift)
    if plant:
        pre = inc[:, :(i1530 if plant_sig == 'C1530' else i1000) + 1].sum(1)   # that signal in the world (close - C16prev)
        sd30 = float(np.sqrt(((unit * prof[i1530 + 1:i1600 + 1]) ** 2).sum()))   # sd of the last-30-min change
        inc[:, i1530 + 1:i1600 + 1] += (plant * sd30 * np.sign(pre))[:, None] / (i1600 - i1530)
    path = np.cumsum(inc, axis=1)                                    # relative to the previous 16:00 close (= 0)
    W = pd.DataFrame({'C16_prev': 0.0, 'C1000': path[:, i1000], 'C1530': path[:, i1530], 'C16': path[:, i1600]}, index=X.index)
    W['rv20'] = X['rv20']
    return W


VAL = {}
for inst in FILES:
    for sname, scol in SIGNALS.items():
        pcts, passes = [], []
        for s in range(P3_SEEDS):
            T = strat(world(inst, s), scol, COST_PTS[inst])
            pcts.append(perm_pct(T, s, gross=True)); passes.append(evaluate(T, s, gross=True)['verdict'])
        pc = np.array(pcts); t_ = float(stats.ttest_1samp(pc, 50.0).statistic) if pc.std() > 0 else np.nan
        fp = float(np.mean(passes)); null_ok = bool(40 <= pc.mean() <= 60 and abs(t_) < 2.5 and fp <= FALSE_PASS_MAX)
        det = []
        if null_ok:
            for s in range(P3_POWER_SEEDS):
                T = strat(world(inst, 1000 + s, plant=PLANT_K, plant_sig=scol), scol, COST_PTS[inst])
                det.append(evaluate(T, s, gross=True)['verdict'])
        power_ok = bool(sum(det) >= math.ceil(0.75 * P3_POWER_SEEDS))   # plant follows THIS signal's sign
        VAL[f'{inst}_{sname}'] = dict(mean_pct=float(pc.mean()), t=t_, false_pass=fp, null_ok=null_ok,
                                      power_det=[bool(x) for x in det], power_ok=power_ok, ok=bool(null_ok and power_ok))
        print(f'{inst} {sname:9s}: perm pct mean {pc.mean():5.1f} (t {t_:+.2f}) | gross false-pass {fp:.0%} | '
              f'null {"PASS" if null_ok else "FAIL"} | power {sum(det)}/{len(det)} -> {"OK" if VAL[f"{inst}_{sname}"]["ok"] else "STOP"}')
json.dump(dict(written_utc=pd.Timestamp.now(tz='UTC').isoformat(), n_seeds=P3_SEEDS, **VAL), open(P3_PROTO, 'w'), indent=1, default=float)
'''),
        ("markdown", "## Real IS data (gated per instrument × signal)"),
        ("code", r'''
# ===== Cell 4 — real IS results =====
PRO = json.load(open(P3_PROTO)); assert PRO['n_seeds'] >= 16 or os.environ.get('PACK2_TEST') == '1'
RES = {}
for inst in FILES:
    X = SESS[inst]; cost = COST_PTS[inst]; mult = MULT[inst]
    base = (X['C16'] - X['C1530']); print(f'\n===== {inst}  (cost {cost:.3f} pt RT; ${mult:.0f}/pt) — IS sessions {len(X)}')
    print(f'  baseline always-long last 30 min: gross {base.mean():+.3f} pt, net {base.mean() - cost:+.3f} pt / trade; '
          f'per year net $/micro: ' + ', '.join(f'{y}: {((base[base.index.year == y] - cost).sum() * mult):+,.0f}' for y in IS_YEARS))
    for sname, scol in SIGNALS.items():
        key = f'{inst}_{sname}'
        if not PRO[key]['ok']:
            print(f'  {sname}: STOPPED by its validation — not evaluated'); continue
        T = strat(X, scol, cost); ev = evaluate(T, 7); pp = perm_pct(T, 7)
        RES[key] = (T, ev, pp)
        print(f'  {sname}: n={ev["n"]} hit {ev["hit"]:.1%} | gross {T.gross.mean():+.3f} pt | net {ev["mean"]:+.3f} pt '
              f'CI90 [{ev["lo"]:+.3f}, {ev["hi"]:+.3f}] | 2022-24 net {ev["late"]:+.3f} | years>0 {ev["n_pos_years"]}/4 | '
              f'sign-shuffle pct {pp:.1f} -> {"WORTH DRILLING" if ev["verdict"] else "not worth drilling"}')
        yt = pd.DataFrame({'n': T.net.groupby(T.index.year).size(), 'mean_net_pt': T.net.groupby(T.index.year).mean(),
                           'usd_per_micro': T.net.groupby(T.index.year).sum() * mult}).reindex(IS_YEARS)
        print('    per year:'); print(yt.round(3).to_string().replace('\n', '\n    '))
        edges = T.sig.abs().quantile([1 / 3, 2 / 3]).to_numpy()
        tq = pd.cut(T.sig.abs(), [-np.inf, *edges, np.inf], labels=['low', 'mid', 'high'])
        rq = pd.qcut(T.rv20, 3, labels=['low', 'mid', 'high'])
        print('    |signal| terciles (IS edges {:.2f} / {:.2f} pt): '.format(*edges)
              + ', '.join(f'{k}: n={int((tq == k).sum())} net {T.net[tq == k].mean():+.3f}' for k in ['low', 'mid', 'high']))
        print('    trailing-20 realised-vol terciles: '
              + ', '.join(f'{k}: n={int((rq == k).sum())} net {T.net[rq == k].mean():+.3f}' for k in ['low', 'mid', 'high']))
        T.to_csv(P3_DIR/f'trades_{key}.csv')
'''),
        ("code", r'''
# ===== Cell 5 — verdicts + trial log =====
now = pd.Timestamp.now(tz='UTC').isoformat(); rows, rets = [], []
for key, (T, ev, pp) in RES.items():
    inst, sname = key.split('_'); cid = f'pack3|IMOM|{inst}|{sname}'
    m = T.net.groupby(T.index.to_period('M').astype(str)).sum() * MULT[inst]          # monthly $ per micro
    rows.append(dict(kind='trial', config_id=cid, pack='pack3', screen='intraday-momentum', universe=inst, rule=sname,
                     n=ev['n'], n_months=len(m), WR=ev['hit'], avg_net=ev['mean'], sd=m.std(), skew=m.skew(), kurt=m.kurt(),
                     sr_monthly=m.mean() / m.std() if m.std() > 0 else np.nan, pct_null=pp, verdict=ev['verdict'],
                     backfilled=False, note='net points per trade; monthly series in $ per micro', logged_at=now))
    rets += [dict(config_id=cid, month=mm, ret=v) for mm, v in m.items()]
if rows:
    def append_log(path, df, key='config_id'):
        if path.exists():
            old = pd.read_csv(path, dtype={key: str}); new = df[~df[key].isin(old[key])]
            pd.concat([old, new], ignore_index=True).to_csv(path, index=False); return len(new)
        df.to_csv(path, index=False); return len(df)
    LOG = pd.DataFrame(rows); RET = pd.DataFrame(rets); RET['key'] = RET.config_id + '|' + RET.month
    n_new = append_log(TRIAL_LOG, LOG); append_log(TRIAL_RET, RET, key='key')
    print(f'trial log: +{n_new} new | cumulative trials {int((pd.read_csv(TRIAL_LOG).kind == "trial").sum())}')
print('\nVERDICTS (net > 0 AND CI90 lo > 0 AND >= 3/4 IS years > 0 AND 2022-24 > 0):')
for key in [f'{i}_{s}' for i in FILES for s in SIGNALS]:
    if key in RES: print(f'  {"WORTH DRILLING    " if RES[key][1]["verdict"] else "not worth drilling"}  {key}')
    else: print(f'  STOPPED (validation)  {key}')
'''),
    ]
    return CELLS
