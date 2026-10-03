# Cell sources for screen pack 2 (imported by _build_notebooks.py). Edit HERE, then rebuild.


def build(SETUP, HELPERS):
    S = SETUP.strip("\n")
    H = HELPERS.strip("\n")

    CONFIG = S + r'''
import re, io, zipfile, hashlib, time
from numba import njit, prange

IS_START, PURGE = pd.Timestamp('2011-01-01'), pd.Timestamp('2023-12-29')   # entries IS_START..PURGE; holds resolve <= cut
Y0, NY = 2011, 13                                         # years 2011..2023
ERAS = {'2011-2014': (2011, 2014), '2015-2018': (2015, 2018), '2019-2023': (2019, 2023)}; RECENT = '2019-2023'
COST = 0.0015                                             # round trip
TOP_U2 = 300                                              # U2 = top 300 stocks by trailing 60-bar $vol (t-60..t-1)
S4_HOLD, S4_STOP = 10, 0.10                               # 10-bar time stop; 10% disaster stop
S5_HOLDS = [20, 60]
S6_MIN_NAMES = 5                                          # top decile, at least 5 names
N_DRAWS, TRIES, DRAW_BATCH = int(os.environ.get('PACK2_DRAWS', 200)), 8, 50
PCT_PASS, MIN_YEARS = 90.0, 9                             # verdict: null pct >= 90; >= 9/13 years positive
FH_CANDIDATES = {'S4': [60], 'S5': [20, 60]}              # fixed-horizon excess (Stage 2b v2 method)
CI_LEVEL, BOOT_REPS = 0.90, 2000
P2_DIR = OUT_DIR/'pack2'; CACHE = P2_DIR/'cache'; CACHE.mkdir(parents=True, exist_ok=True)
ASSET_FILE, U1_FILE, PROTO_FILE = P2_DIR/'asset_class.csv', P2_DIR/'u1_etfs.csv', P2_DIR/'pack2_protocol.json'
UNIVS = ['U1', 'U2']
CONFIGS = ([dict(name=f'S4_{tg}_{ex}_{st}', screen='S4', family=f'S4_{tg}', trig=tg, mode=(0 if ex == 'X1' else 1),
                 hold=S4_HOLD, stop=(st == 'stop10'))
            for tg in ['T1', 'T2', 'T3'] for ex in ['X1', 'X2'] for st in ['nostop', 'stop10']]
           + [dict(name=f'S5_h{h}', screen='S5', family='S5', trig=None, mode=2, hold=h, stop=False) for h in S5_HOLDS])
'''

    CORE = H + r'''


# ---------------------------------------------------------------- panels (T x N), cut at load, cached
def load_panels():
    f_cache = CACHE/'panels_cut_2024-12-31.npz'
    if f_cache.exists():
        z = np.load(f_cache)
        cal = pd.DatetimeIndex(z['dates']); assert cal.max() <= CUT_DATE
        return [str(t) for t in z['tickers']], cal, {c: z[c].astype(np.float64) for c in 'OHLCV'}
    spy = load_px(DATA_DIR/'SPY.csv'); cal = pd.DatetimeIndex(spy['Date']); T = len(cal)
    arrs, tickers = {c: [] for c in 'OHLCV'}, []
    for f in sorted(glob.glob(f'{DATA_DIR}/*.csv')):
        try:
            d = load_px(f)
        except Exception:
            continue
        pos = cal.get_indexer(d['Date']); ok = pos >= 0
        if not ok.any(): continue
        tickers.append(Path(f).stem.upper())
        for c, col in zip('OHLCV', ['Open', 'High', 'Low', 'Close', 'Volume']):
            a = np.full(T, np.nan, np.float32); a[pos[ok]] = d[col].to_numpy(float)[ok]; arrs[c].append(a)
    P = {c: np.stack(arrs[c], axis=1) for c in 'OHLCV'}
    bad = ~(P['C'] > 0)
    for c in 'OHLC': P[c][bad] = np.nan
    np.savez(f_cache, tickers=np.array(tickers), dates=cal.values, **P)
    return tickers, cal, {c: P[c].astype(np.float64) for c in P}


def lag(X, n):
    Y = np.full_like(X, np.nan); Y[n:] = X[:-n]; return Y


def roll(X, w, how='mean', minp=None):
    r = pd.DataFrame(X).rolling(w, min_periods=minp)
    return getattr(r, how)().to_numpy()


def indicators(O, H, L, C, V):
    """All causal: values at row t use bars <= t; the *p ones use bars <= t-1."""
    I = {'S5': roll(C, 5), 'S50': roll(C, 50), 'S200': roll(C, 200)}
    C1 = lag(C, 1); d = C - C1
    au = pd.DataFrame(np.where(d > 0, d, 0.0)).where(np.isfinite(d)).ewm(alpha=0.5, adjust=False).mean().to_numpy()
    ad = pd.DataFrame(np.where(d < 0, -d, 0.0)).where(np.isfinite(d)).ewm(alpha=0.5, adjust=False).mean().to_numpy()
    tot = au + ad
    I['RSI'] = np.where(np.isfinite(d), np.where(tot > 0, 100 * au / np.where(tot > 0, tot, 1), 50.0), np.nan)
    TR = np.fmax(H - L, np.fmax(np.abs(H - C1), np.abs(L - C1)))
    I['ATRp'] = lag(roll(TR, 14), 1)
    I['VA50p'] = lag(roll(V, 50), 1)
    I['DV60p'] = lag(roll(C * V, 60), 1)
    I['LOW20p'] = roll(C1, 20, 'min')
    ON = np.log(O / C1); ON[~(np.abs(ON) < np.log(1.5))] = np.nan          # overnight bad prints dropped
    I['ON21'] = roll(ON, 21, 'sum', minp=18)
    return I


def universes(DV60p, is_stock, is_u1):
    T, N = DV60p.shape
    X = np.where(is_stock[None, :], DV60p, np.nan)
    U2 = np.zeros((T, N), bool)
    for t in range(T):
        idx = np.nonzero(np.isfinite(X[t]) & (X[t] > 0))[0]
        if len(idx) > TOP_U2: idx = idx[np.argpartition(-X[t, idx], TOP_U2 - 1)[:TOP_U2]]
        U2[t, idx] = True
    U1 = is_u1[None, :] & np.isfinite(DV60p) & (DV60p > 0)
    return {'U1': U1, 'U2': U2}


def fwd(C, h):
    F = np.full_like(C, np.nan); F[:-h] = C[h:] / C[:-h] - 1; return F


def build_ctx(O, H, L, C, V, is_stock, is_u1, i_spy):
    I = indicators(O, H, L, C, V)
    UN = universes(I['DV60p'], is_stock, is_u1)
    C1, C2, C3 = lag(C, 1), lag(C, 2), lag(C, 3)
    trend = (C > I['S200']) & (I['S50'] > I['S200'])
    TRIG = {'T1': I['RSI'] < 10, 'T2': (C < C1) & (C1 < C2) & (C2 < C3), 'T3': C < I['LOW20p']}
    quiet = np.abs(C - C1) < I['ATRp']; spike = V >= 3 * I['VA50p']; va = I['VA50p'] > 0
    NT = {k: np.ascontiguousarray(x.T) for k, x in dict(O=O, H=H, L=L, C=C, S5=I['S5'], RSI=I['RSI']).items()}
    hs = sorted({h for v in FH_CANDIDATES.values() for h in v})
    FW = {h: fwd(C, h) for h in hs}
    EWF = {(u, h): np.nanmean(np.where(UN[u], FW[h], np.nan), axis=1) for u in UNIVS for h in hs}
    return dict(I=I, UN=UN, trend=trend, TRIG=TRIG, s5=spike & quiet & va, s5pool=quiet & ~spike & va,
                NT=NT, FW=FW, EWF=EWF, C=C, i_spy=i_spy)


# ---------------------------------------------------------------- simulator (Stage 2 semantics)
@njit(cache=True)
def sim_one(O, H, L, C, S5, RSI, k, e, mode, hold, use_stop, stop_pct):
    """Enter at O[k,e]. Bar order: disaster stop (low) -> time stop (close of bar e+hold-1) -> exit signal at the
    close (mode 0: close > SMA5; 1: RSI2 > 70; 2: none), filled at the NEXT open. Data gap/end -> last close.
    Returns (exit bar, gross return, exit type: 0 = filled at that bar's open, 1 = at/near that bar's close)."""
    T = C.shape[1]
    if e >= T: return -1, np.nan, 0
    fill = O[k, e]
    if not (fill > 0.0): return -1, np.nan, 0
    stop = fill * (1.0 - stop_pct)
    last = e + hold - 1
    if last > T - 1: last = T - 1
    for i in range(e, last + 1):
        c = C[k, i]
        if not (c > 0.0):
            if i == e: return -1, np.nan, 0
            return i - 1, C[k, i - 1] / fill - 1.0, 1
        if use_stop and L[k, i] <= stop:
            o = O[k, i]
            px = stop if (i == e or not (o > 0.0)) else (o if o < stop else stop)
            return i, px / fill - 1.0, 1
        if i == last:
            return i, c / fill - 1.0, 1
        hit = False
        if mode == 0:
            hit = c > S5[k, i]
        elif mode == 1:
            hit = RSI[k, i] > 70.0
        if hit:
            o = O[k, i + 1]
            if o > 0.0: return i + 1, o / fill - 1.0, 0
            return i, c / fill - 1.0, 1
    return last, C[k, last] / fill - 1.0, 1


@njit(cache=True)
def run_rule(sig, O, H, L, C, S5, RSI, mode, hold, use_stop, stop_pct, t_lo, t_hi):
    """Signals at close t in [t_lo, t_hi] -> entry t+1. One position per ticker (next signal allowed at t >= exit bar)."""
    N = C.shape[0]; cap = 0
    for k in range(N):
        for t in range(t_lo, t_hi + 1):
            if sig[k, t]: cap += 1
    ok = np.empty(cap, np.int64); ot = np.empty(cap, np.int64); ox = np.empty(cap, np.int64); orr = np.empty(cap)
    oxt = np.empty(cap, np.int64)
    m = 0
    for k in range(N):
        free = 0
        for t in range(t_lo, t_hi + 1):
            if sig[k, t] and t >= free:
                x, r, xt = sim_one(O, H, L, C, S5, RSI, k, t + 1, mode, hold, use_stop, stop_pct)
                if x >= 0:
                    ok[m] = k; ot[m] = t; ox[m] = x; orr[m] = r; oxt[m] = xt; m += 1; free = x
    return ok[:m], ot[:m], ox[:m], orr[:m], oxt[:m]


@njit(cache=True)
def sim_null(O, C, kk, e, x, xt):
    """Duration-matched null trade on ticker kk: enter at O[kk,e], exit at the matched real trade's exit bar x with
    the same price type (0: open, 1: close). Missing exit price -> last close in [e, x]; none -> rejected (-1)."""
    fill = O[kk, e]
    if not (fill > 0.0): return -1.0
    px = O[kk, x] if xt == 0 else C[kk, x]
    j = x
    while not (px > 0.0):
        if j < e: return -1.0
        px = C[kk, j]; j -= 1
    return px / fill - 1.0


@njit(parallel=True, cache=True)
def null_draws(tr_t, tr_k, tr_x, tr_xt, ptr, pidx, U, O, C, cost, yidx, ny):
    """SELECTION null (DURATION-MATCHED): for each real trade (signal bar t, ticker k, exit bar x, exit type) draw a
    random OTHER ticker from the pool at t (same universe, same non-trigger condition), enter at its next open and exit
    at the SAME bar with the same price type. Only the ticker differs, so holding-time x market-drift cannot bias it
    (the own-exit version failed the martingale protocol: S4 families at pct 64-66, t ~3, with drift on).
    Non-overlap per draw. Returns per-draw, per-entry-year sums and counts of net returns."""
    D = U.shape[0]; n = tr_t.shape[0]; tries = U.shape[2]; N = C.shape[0]
    S = np.zeros((D, ny)); Cn = np.zeros((D, ny)); miss = np.zeros(D, np.int64)
    for d in prange(D):
        busy = np.zeros(N, np.int64)
        for i in range(n):
            t = tr_t[i]; a = ptr[t]; m = ptr[t + 1] - a; done = False
            if m > 0:
                for j in range(tries):
                    q = int(U[d, i, j] * m)
                    if q >= m: q = m - 1
                    kk = pidx[a + q]
                    if kk == tr_k[i] or busy[kk] > t: continue
                    r = sim_null(O, C, kk, t + 1, tr_x[i], tr_xt[i])
                    if r == -1.0: continue
                    busy[kk] = tr_x[i]; y = yidx[t + 1]
                    if y >= 0 and y < ny:
                        S[d, y] += r - cost; Cn[d, y] += 1.0
                    done = True; break
            if not done: miss[d] += 1
    return S, Cn, miss


def year_ci(x, blocks, reps, seed, level):
    """Year-block bootstrap of the mean: (CI lo, CI hi, q = 100 x share of bootstrap means > 0). Stage 2b v2."""
    x = np.asarray(x, float); ub, inv = np.unique(blocks, return_inverse=True)
    Sm = np.bincount(inv, weights=x, minlength=len(ub)); Cn = np.bincount(inv, minlength=len(ub)).astype(float)
    idx = np.random.default_rng(seed).integers(0, len(ub), (reps, len(ub))); mb = Sm[idx].sum(1) / Cn[idx].sum(1)
    a = (1 - level) / 2
    return float(np.quantile(mb, a)), float(np.quantile(mb, 1 - a)), 100.0 * float((mb > 0).mean())


def run_cfg(ctx, cfg, u, n_draws, seed, fh_list):
    """Real trades of one rule in one universe + selection null + fixed-horizon excess."""
    U = ctx['UN'][u]
    if cfg['screen'] == 'S4':
        sig, pool = ctx['trend'] & ctx['TRIG'][cfg['trig']] & U, ctx['trend'] & U
    else:
        sig, pool = ctx['s5'] & U, ctx['s5pool'] & U
    nt = ctx['NT']; T = U.shape[0]
    k, t, x, r, xt = run_rule(np.ascontiguousarray(sig.T), nt['O'], nt['H'], nt['L'], nt['C'], nt['S5'], nt['RSI'],
                              cfg['mode'], cfg['hold'], cfg['stop'], S4_STOP, T_LO, T_HI)
    o = np.argsort(t, kind='stable'); k, t, x, r, xt = k[o], t[o], x[o], r[o], xt[o]
    net = r - COST; yr = YEAR_T[t + 1] if len(t) else np.array([], int)
    out = dict(cfg=cfg['name'], screen=cfg['screen'], family=cfg['family'], universe=u, n=len(t), k=k, t=t, x=x,
               gross=r, net=net, year=yr)
    # selection null
    tt, kk = np.nonzero(pool)
    ptr = np.searchsorted(tt, np.arange(T + 1)).astype(np.int64); pidx = kk.astype(np.int64)
    Sd, Cd = np.zeros((n_draws, NY)), np.zeros((n_draws, NY)); miss = 0; rng = np.random.default_rng(seed)
    for b0 in range(0, n_draws, DRAW_BATCH):
        nb_ = min(DRAW_BATCH, n_draws - b0)
        Ub = rng.random((nb_, len(t), TRIES), dtype=np.float32)
        s_, c_, m_ = null_draws(t, k, x, xt, ptr, pidx, Ub, nt['O'], nt['C'], COST, YIDX, NY)
        Sd[b0:b0 + nb_], Cd[b0:b0 + nb_] = s_, c_; miss += int(m_.sum())
    with np.errstate(invalid='ignore', divide='ignore'):
        dm = Sd.sum(1) / Cd.sum(1)
        out['null_year_mean'] = Sd.sum(0) / Cd.sum(0)
    out['null_mean'] = float(np.nanmean(dm)) if len(t) else np.nan
    out['pct'] = float(100 * np.mean(dm < net.mean())) if len(t) and np.isfinite(dm).all() else np.nan
    out['null_miss_rate'] = miss / max(1, n_draws * len(t))
    lo_, hi_ = ERAS[RECENT]; era = (yr >= lo_) & (yr <= hi_)
    ey = np.arange(lo_ - Y0, hi_ - Y0 + 1)
    with np.errstate(invalid='ignore', divide='ignore'):
        out['era_exc'] = (float(net[era].mean() - Sd[:, ey].sum() / Cd[:, ey].sum()) if era.any() else np.nan)
    # fixed-horizon excess: close of the fill bar -> close h bars later, vs universe EW and SPY, same window
    out['fh'] = {}
    for h in fh_list:
        if not len(t): out['fh'][h] = None; continue
        e = t + 1; F = ctx['FW'][h]
        s_ = F[e, k]; ew = ctx['EWF'][(u, h)][e]; sp = F[e, ctx['i_spy']]
        res = {}
        for bm, b in (('ew', ew), ('spy', sp)):
            d_ = s_ - b; ok_ = np.isfinite(d_)
            ci = year_ci(d_[ok_], yr[ok_], BOOT_REPS, seed + h, CI_LEVEL) if ok_.sum() >= 20 else (np.nan,) * 3
            res[bm] = dict(n=int(ok_.sum()), mean=float(d_[ok_].mean()) if ok_.any() else np.nan,
                           lo=ci[0], hi=ci[1], q=ci[2])
        out['fh'][h] = res
    return out


def s6_monthly(ctx, u, cal):
    """Month-end formation: top decile (>= 5 names) by trailing 21-bar overnight-return sum; hold close->next
    month-end close, EW; minus all universe members over the same window. Turnover cost = replaced share x COST."""
    C, ON21, Um = ctx['C'], ctx['I']['ON21'], ctx['UN'][u]
    per = cal.to_period('M'); me = list(np.nonzero(per[:-1] != per[1:])[0]) + [len(cal) - 1]
    Cff = pd.DataFrame(C).ffill().to_numpy(); rows, prev = [], None
    for a, b in zip(me[:-1], me[1:]):
        if cal[b] < IS_START or cal[b] > PURGE: continue
        idx = np.nonzero(Um[a] & np.isfinite(ON21[a]) & (C[a] > 0))[0]
        if len(idx) < 2 * S6_MIN_NAMES: continue
        kk = max(int(math.ceil(len(idx) / 10)), S6_MIN_NAMES)
        top = idx[np.argsort(-ON21[a, idx], kind='stable')[:kk]]
        R_all = Cff[b, idx] / C[a, idx] - 1; R_top = Cff[b, top] / C[a, top] - 1
        gross = float(np.nanmean(R_top) - np.nanmean(R_all))
        turn = 1.0 if prev is None else 1 - len(set(top.tolist()) & prev) / kk; prev = set(top.tolist())
        rows.append(dict(month=str(cal[b].to_period('M')), year=cal[b].year, n_univ=len(idx), k=kk, gross=gross,
                         turnover=turn, net=gross - turn * COST))
    return pd.DataFrame(rows)


def s6_summary(M, seed=0):
    if M.empty: return dict(n=0)
    lo_, hi_ = ERAS[RECENT]; era = M[(M.year >= lo_) & (M.year <= hi_)]
    ci = year_ci(M['net'].to_numpy(), M['year'].to_numpy(), BOOT_REPS, seed, CI_LEVEL) if len(M) >= 20 else (np.nan,) * 3
    cig = year_ci(M['gross'].to_numpy(), M['year'].to_numpy(), BOOT_REPS, seed, CI_LEVEL) if len(M) >= 20 else (np.nan,) * 3
    yr = M.groupby('year')['net'].sum().reindex(range(Y0, Y0 + NY))
    return dict(n=len(M), mean_gross=M.gross.mean(), mean_turn=M.turnover.mean(), mean_net=M.net.mean(),
                ci_lo=ci[0], ci_hi=ci[1], q=ci[2], ci_lo_gross=cig[0], era_net=era.net.mean() if len(era) else np.nan,
                yrs_pos=int((yr > 0).sum()), breakeven=(M.gross.mean() / M.turnover.mean()) if M.turnover.mean() > 0 else np.nan,
                per_year=yr)


def calendar_consts(cal):
    global T_LO, T_HI, YEAR_T, YIDX
    T_LO = int(np.searchsorted(cal, IS_START)) - 1                 # signal bar; entry bar = T_LO + 1 >= IS_START
    T_HI = int(np.searchsorted(cal, PURGE, side='right')) - 2      # entry bar T_HI + 1 <= PURGE
    assert T_LO >= 0 and cal[T_LO + 1] >= IS_START and cal[T_HI + 1] <= PURGE
    YEAR_T = cal.year.to_numpy()
    YIDX = np.where((YEAR_T >= Y0) & (YEAR_T < Y0 + NY), YEAR_T - Y0, -1).astype(np.int64)


def asset_masks(tickers):
    A = pd.read_csv(ASSET_FILE).set_index('ticker').reindex(tickers)
    u1 = set(pd.read_csv(U1_FILE)['ticker'])
    is_u1 = np.array([t in u1 for t in tickers])
    is_stock = A['asset_class'].isin(['Stock', 'Unknown']).to_numpy() & ~is_u1
    return is_stock, is_u1


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
'''

    # ------------------------------------------------------------ protocol notebook
    PROTO = [
        ("markdown", r'''
# Screen pack 2 — Step 0 (U1 ETF list) + 16-seed MARTINGALE PROTOCOL (controls, not trials)

**Standing rule:** every null must first pass the 16-seed martingale protocol on pure random-walk worlds before
real data; a failing null STOPS the stage. This notebook validates the pack-2 SELECTION nulls (S4 dip-in-uptrend,
S5 abnormal-volume/quiet-price), the fixed-horizon excess and S6's top-decile-minus-universe test on synthetic worlds,
then writes `results/screens/pack2/pack2_protocol.json`. `screen_pack2.ipynb` will not touch real data without it.

**Step 0 — U1.** Tiingo's public `supported_tickers` file classifies every corpus ticker (assetType, the rows whose
date span overlaps the file's). ETFs whose names mark leveraged / inverse / volatility products are excluded. The list
is saved to `pack2/u1_etfs.csv` and printed; **review it, then set `U1_APPROVED = True` and re-run.** U2 = Stock (or
unclassified) tickers, never U1. No 2025+ dates are printed.

**Worlds.** Each world keeps every ticker's REAL listing span, internal gaps and REAL volume series; prices are pure
random walks built from intrabar paths (overnight step + 12 intraday steps; O = first, H/L = path extremes, C = last),
market factor (drift 0.03%/day, vol 1%/day) + idiosyncratic noise scaled to the ticker's real volatility, each leg
convexity-corrected (martingale). Volume is real and independent of price, so no edge exists.

**Selection null = DURATION-MATCHED** (same anchor date, random OTHER ticker in the same universe meeting the
same non-trigger condition, entry at its next open, exit at the matched real trade's exit bar with the same price
type). The own-exit version was tried first and FAILED this protocol on drift worlds (dip trades are held longer and
collect more market drift: S4 families at pct 64-66, t ≈ 3, pooled 25%); with drift off it passed — so the bias is
holding-time × drift, and matching the duration removes it.

**Checks (decisions 2026-10-03):**
- SELECTION null, at the verdict threshold: pooled share of (seed × config × universe) with pct >= 90 must be
  <= 15% (calibrated ≈ 10%); per family (S4_T1, S4_T2, S4_T3, S5): mean pct over the 16 per-seed values in [40, 60],
  |t| < 2.5, and the family pass rate NOT significantly above the nominal 10% (one-sided binomial p >= 0.05, n =
  Kish effective size for seed-clustered records; decision 2026-10-03, replaces a fixed 15% ceiling that false-failed
  ~54% of calibrated nulls). Per family this false-fails ~5%; across the four families ~18%.
- Fixed horizons (S4: 60; S5: 20, 60): per (screen, h) mean excess vs EW over 16 seeds |t| < 2.5 and CI-lo > 0 rate
  <= 15%. A failing horizon is DROPPED (recorded), not used on real data.
- S6 (per universe): mean monthly GROSS excess (costs are negative by construction) over 16 seeds |t| < 2.5 and CI-lo > 0 rate <= 15%.
- Power (after the null passes): 4 planted worlds — +0.5%/bar for 3 bars after any > 2σ down close, and +0.1%/bar for
  20 bars after real volume spikes. U2 S4_T1 mean pct >= 90 and U2 S5_h20 pct >= 90 in >= 3 of 4 seeds.
'''),
        ("code", "# ===== Cell 0 — config =====\n" + CONFIG + r'''
U1_APPROVED = False or os.environ.get('PACK2_U1_APPROVED') == '1'   # set True after reviewing u1_etfs.csv
N_SEEDS = int(os.environ.get('PACK2_SEEDS', 16)); POWER_SEEDS = int(os.environ.get('PACK2_POWER_SEEDS', 4))
M_STEPS, ON_FRAC, MKT_SD = 12, 0.2, 0.01
MKT_MU = float(os.environ.get('PACK2_MKT_MU', 0.0003))       # market drift per day (env override: diagnostics only)
PLANT_REV, PLANT_VOL = 0.005, 0.001
U1_FORCE_INCLUDE, U1_FORCE_EXCLUDE = set(), set()      # manual overrides after review (logged in the file)
LEV_RE = re.compile(r'(\b-?[1-4](\.\d+)?x\b|ultra|\bbear\b|inverse|leveraged|\bvix\b|(?<!low )(?<!min )volatility'
                    r'|\bshort\b(?![- ](term|duration|maturity|treasury|bond)))', re.I)
'''),
        ("code", "# ===== Cell 1 — core (shared with screen_pack2.ipynb) =====\n" + CORE),
        ("markdown", "## Step 0 — load panels (cut at load), classify ETFs, U1 list"),
        ("code", r'''
# ===== Cell 2 — panels + Step 0 =====
t0 = time.time()
TICKERS, CAL, P = load_panels(); calendar_consts(CAL)
print(f'panels: {len(TICKERS)} tickers x {len(CAL)} bars ({CAL[0].date()} .. {CAL[-1].date()})  [{time.time()-t0:.0f}s]')
first_d = {t: CAL[np.argmax(np.isfinite(P['C'][:, i]))] for i, t in enumerate(TICKERS)}
last_d = {t: CAL[len(CAL) - 1 - np.argmax(np.isfinite(P['C'][::-1, i]))] for i, t in enumerate(TICKERS)}

if not ASSET_FILE.exists():
    raw = urllib.request.urlopen('https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip', timeout=180).read()
    zf = zipfile.ZipFile(io.BytesIO(raw)); st = pd.read_csv(zf.open(zf.namelist()[0]))
    st['ticker'] = st['ticker'].astype(str).str.upper()
    st = st[st['ticker'].isin(TICKERS)]
    rows = []
    for tk in TICKERS:
        r = st[st.ticker == tk]
        sd_, ed_ = pd.to_datetime(r['startDate'], errors='coerce'), pd.to_datetime(r['endDate'], errors='coerce')
        r = r[(sd_.isna() | (sd_ <= last_d[tk])) & (ed_.isna() | (ed_ >= first_d[tk]))]   # rows overlapping the file
        types = sorted(set(r['assetType'].dropna()))
        cls = types[0] if len(types) == 1 else ('Unknown' if not types else 'Ambiguous:' + '/'.join(types))
        rows.append(dict(ticker=tk, asset_class=cls))
    A = pd.DataFrame(rows)
    token = tiingo_token(); names = {}
    for tk in A.loc[A.asset_class.str.contains('ETF'), 'ticker']:
        try:
            names[tk] = json.load(urllib.request.urlopen(
                f'https://api.tiingo.com/tiingo/daily/{tk}?token={token}', timeout=30)).get('name', '')
        except Exception as e:
            names[tk] = f'?? {e!r}'[:60]
    A['name'] = A['ticker'].map(names).fillna('')
    A.to_csv(ASSET_FILE, index=False)
A = pd.read_csv(ASSET_FILE).fillna({'name': ''})
etf = A[A.asset_class == 'ETF'].copy()
etf['exclude_reason'] = etf['name'].map(lambda s: (m.group(0) if (m := LEV_RE.search(s)) else ''))
etf.loc[etf.ticker.isin(U1_FORCE_EXCLUDE), 'exclude_reason'] = 'manual exclude'
etf.loc[etf.ticker.isin(U1_FORCE_INCLUDE), 'exclude_reason'] = ''
U1L = etf[etf.exclude_reason == ''][['ticker', 'name']]
print('asset classes:', A.asset_class.value_counts().to_dict())
pd.set_option('display.max_rows', 1000); pd.set_option('display.width', 220)
print(f'\nU1 = {len(U1L)} ETFs:'); print(U1L.to_string(index=False))
print(f'\nExcluded ETFs ({int((etf.exclude_reason != "").sum())}):')
print(etf[etf.exclude_reason != ''][['ticker', 'name', 'exclude_reason']].to_string(index=False))
amb = A[A.asset_class.str.startswith('Ambiguous')]
print(f'\nAmbiguous (in neither universe): {len(amb)} {amb.ticker.tolist()}')
print(f'Unknown (treated as stocks for U2): {int((A.asset_class == "Unknown").sum())}')
if not U1_FILE.exists() or not U1_APPROVED:
    U1L.to_csv(U1_FILE, index=False)
if len(U1L) < 30: print(f'\n!! U1 has only {len(U1L)} names: U1 results are DESCRIPTIVE ONLY')
assert U1_APPROVED, 'Review the U1 list above (pack2/u1_etfs.csv), then set U1_APPROVED = True and re-run.'
IS_STOCK, IS_U1 = asset_masks(TICKERS); I_SPY = TICKERS.index('SPY')
print(f'U1 approved: {int(IS_U1.sum())} | U2-eligible stocks: {int(IS_STOCK.sum())} | sha {sha(U1_FILE)[:12]}')
'''),
        ("markdown", "## Worlds"),
        ("code", r'''
# ===== Cell 3 — martingale world generator (intrabar paths, real listing spans + real volume) =====
@njit(cache=True)
def gen_world(seed, mkt, sd_i, first, last, P0, M, on_frac, plant_rev, rev_thr, plant_vol, vspike):
    np.random.seed(seed)
    T = mkt.shape[0]; N = sd_i.shape[0]
    O = np.full((N, T), np.nan); Hh = np.full((N, T), np.nan); Ll = np.full((N, T), np.nan); Cc = np.full((N, T), np.nan)
    for k in range(N):
        if first[k] < 0: continue
        so = sd_i[k] * np.sqrt(on_frac); si = sd_i[k] * np.sqrt((1.0 - on_frac) / M)
        prev = P0[k]; cr = 0; cv = 0
        for t in range(first[k], last[k] + 1):
            drift = 0.0
            if cr > 0:
                drift += plant_rev; cr -= 1
            if cv > 0:
                drift += plant_vol; cv -= 1
            o = prev * np.exp(mkt[t, 0] + so * np.random.standard_normal() - 0.5 * so * so)
            p = o; hi = o; lo = o
            for j in range(1, M + 1):
                p *= np.exp(mkt[t, j] + si * np.random.standard_normal() - 0.5 * si * si + drift / M)
                if p > hi: hi = p
                if p < lo: lo = p
            O[k, t] = o; Hh[k, t] = hi; Ll[k, t] = lo; Cc[k, t] = p
            if plant_rev > 0.0 and np.log(p / prev) < -rev_thr[k]: cr = 3
            if plant_vol > 0.0 and vspike[k, t]: cv = 20
            prev = p
    return O, Hh, Ll, Cc


Creal, Vreal = P['C'], P['V']; T_, N_ = Creal.shape
valid = np.isfinite(Creal)
FIRST = np.where(valid.any(0), valid.argmax(0), -1).astype(np.int64)
LAST = np.where(valid.any(0), T_ - 1 - valid[::-1].argmax(0), -1).astype(np.int64)
P0 = np.array([Creal[FIRST[i], i] if FIRST[i] >= 0 else 1.0 for i in range(N_)])
sd = np.clip(np.nanstd(np.diff(np.log(Creal), axis=0), axis=0), 0.005, 0.10); sd = np.where(np.isfinite(sd), sd, 0.02)
SD_I = np.sqrt(np.maximum(sd ** 2 - MKT_SD ** 2, (0.25 * sd) ** 2))
VSPIKE = np.ascontiguousarray((Vreal >= 3 * lag(roll(Vreal, 50), 1)).T)


def make_world(seed, plant=False):
    rng = np.random.default_rng(10_000 + seed)
    mkt = np.empty((T_, M_STEPS + 1))
    mkt[:, 0] = rng.normal(MKT_MU * ON_FRAC - 0.5 * MKT_SD ** 2 * ON_FRAC, MKT_SD * np.sqrt(ON_FRAC), T_)
    s_in = MKT_SD * np.sqrt((1 - ON_FRAC) / M_STEPS)
    mkt[:, 1:] = rng.normal(MKT_MU * (1 - ON_FRAC) / M_STEPS - 0.5 * s_in ** 2, s_in, (T_, M_STEPS))
    O, Hh, Ll, Cc = gen_world(seed, mkt, SD_I, FIRST, LAST, P0, M_STEPS, ON_FRAC,
                              PLANT_REV if plant else 0.0, 2 * sd, PLANT_VOL if plant else 0.0, VSPIKE)
    W = {c: np.ascontiguousarray(x.T) for c, x in zip('OHLC', (O, Hh, Ll, Cc))}
    for c in 'OHLC': W[c][~valid] = np.nan                  # real internal gaps / listing span
    return W


W = make_world(0)
r_ = np.diff(np.log(W['C']), axis=0)
print(f'world check: mean daily log ret {np.nanmean(r_):+.5f}, sd {np.nanstd(r_):.4f} (real {np.nanstd(np.diff(np.log(Creal), axis=0)):.4f}); '
      f'H>=max(O,C): {bool(np.nanmin(W["H"] - np.fmax(W["O"], W["C"])) >= 0)}, L<=min(O,C): {bool(np.nanmax(W["L"] - np.fmin(W["O"], W["C"])) <= 0)}')
del W, r_
'''),
        ("markdown", "## Protocol (16 seeds) + power"),
        ("code", r'''
# ===== Cell 4 — run the protocol =====
def run_world(seed, plant=False, cfgs=CONFIGS, univs=UNIVS, s6=True):
    W = make_world(seed, plant)
    ctx = build_ctx(W['O'], W['H'], W['L'], W['C'], Vreal, IS_STOCK, IS_U1, I_SPY)
    recs = []
    for cfg in cfgs:
        for u in univs:
            o = run_cfg(ctx, cfg, u, N_DRAWS, seed * 1000 + len(recs), FH_CANDIDATES[cfg['screen']])
            rec = dict(seed=seed, cfg=cfg['name'], family=cfg['family'], screen=cfg['screen'], universe=u,
                       n=o['n'], pct=o['pct'], miss=o['null_miss_rate'])
            for h, res in o['fh'].items():
                rec[f'fh{h}_mean'] = res['ew']['mean'] if res else np.nan
                rec[f'fh{h}_lo'] = res['ew']['lo'] if res else np.nan
            recs.append(rec)
    s6r = []
    if s6:
        for u in univs:
            sm = s6_summary(s6_monthly(ctx, u, CAL), seed)
            s6r.append(dict(seed=seed, universe=u, n=sm.get('n', 0), mean_gross=sm.get('mean_gross', np.nan),
                            ci_lo_gross=sm.get('ci_lo_gross', np.nan)))   # GROSS: costs are negative by construction
    return recs, s6r


REC, S6R = [], []
for seed in range(N_SEEDS):
    t0 = time.time(); r_, s_ = run_world(seed); REC += r_; S6R += s_
    d_ = pd.DataFrame(r_)
    print(f'seed {seed:2d}: {time.time()-t0:5.0f}s | trades/config median {int(d_.n.median())} | '
          f'pct>=90 {int((d_.pct >= PCT_PASS).sum())}/{d_.pct.notna().sum()} | mean pct {d_.pct.mean():.1f}')
REC, S6R = pd.DataFrame(REC), pd.DataFrame(S6R)
REC.to_csv(P2_DIR/'protocol_records.csv', index=False); S6R.to_csv(P2_DIR/'protocol_s6.csv', index=False)
'''),
        ("code", r'''
# ===== Cell 5 — evaluate the protocol =====
def tstat(v):
    v = np.asarray(v, float); v = v[np.isfinite(v)]
    return float(stats.ttest_1samp(v, 50.0).statistic) if len(v) > 2 and v.std() > 0 else np.nan

def clustered_binom_p(passes, clusters, p0):
    """One-sided binomial test that the pass rate exceeds p0, with n replaced by the Kish effective size
    n / (1 + (m-1) rho): configs within a seed share trades, so records are clustered by seed (rho = ANOVA
    intraclass correlation of the pass indicators). Plain binomial on all records false-fails ~54% of calibrated
    nulls at rho 0.8; this holds ~5% per family (validated by simulation, 2026-10-03)."""
    x = np.asarray(passes, float); c = pd.Series(clusters).to_numpy(); n = len(x); p = x.mean()
    if n == 0 or p <= p0: return 1.0, np.nan, float(n)
    g = pd.Series(x).groupby(c); k_, sz = g.mean().to_numpy(), g.size().to_numpy(); s_ = len(sz); m = n / s_
    msb = (sz * (k_ - p) ** 2).sum() / max(s_ - 1, 1)
    msw = sum(((x[c == cl] - k_[i]) ** 2).sum() for i, cl in enumerate(g.mean().index)) / max(n - s_, 1)
    rho = max(0.0, (msb - msw) / (msb + (m - 1) * msw)) if msb + (m - 1) * msw > 0 else 0.0
    neff = n / (1 + (m - 1) * rho)
    return float(stats.binom.sf(math.ceil(p * neff) - 1, int(round(neff)), p0)), rho, neff

P_NOM = 1 - PCT_PASS / 100                                  # nominal pass rate at the verdict threshold (10%)
ok_rec = REC[REC.pct.notna()]
pooled = float((ok_rec.pct >= PCT_PASS).mean())
fam_rows = {}
for f, g in ok_rec.groupby('family'):
    per_seed = g.groupby('seed').pct.mean()
    pb, rho_, neff_ = clustered_binom_p(g.pct >= PCT_PASS, g.seed, P_NOM)
    fam_rows[f] = dict(mean_pct=per_seed.mean(), t=tstat(per_seed), pass_rate=float((g.pct >= PCT_PASS).mean()),
                       binom_p=pb, icc=rho_, n_eff=neff_, n_seeds=len(per_seed))
FAM = pd.DataFrame(fam_rows).T
fam_ok = bool(len(FAM) == 4 and FAM.mean_pct.between(40, 60).all() and (FAM.t.abs() < 2.5).all()
              and (FAM.binom_p >= 0.05).all())
SEL_OK = bool(pooled <= 0.15 and fam_ok)
print(f'SELECTION null: pooled pass rate (pct >= {PCT_PASS:.0f}) {pooled:.1%} (<= 15%)')
print(FAM.round(3).to_string()); print('family checks:', 'PASS' if fam_ok else 'FAIL')
print('by universe:'); print(ok_rec.groupby(['family', 'universe']).pct.agg(['mean', 'count']).round(1).to_string())

FH_ALLOWED, fh_rows = {}, {}
for scr, hs in FH_CANDIDATES.items():
    FH_ALLOWED[scr] = []
    for h in hs:
        g = REC[(REC.screen == scr) & REC[f'fh{h}_mean'].notna()]
        per_seed = g.groupby('seed')[f'fh{h}_mean'].mean()
        t_ = float(stats.ttest_1samp(per_seed, 0.0).statistic) if len(per_seed) > 2 else np.nan
        lo_rate = float((g[f'fh{h}_lo'] > 0).mean()) if len(g) else np.nan
        ok = bool(np.isfinite(t_) and abs(t_) < 2.5 and lo_rate <= 0.15)
        fh_rows[f'{scr}_{h}'] = dict(mean=per_seed.mean(), t=t_, ci_lo_pos_rate=lo_rate, ok=ok)
        if ok: FH_ALLOWED[scr].append(h)
print('\nFixed-horizon excess vs EW:'); print(pd.DataFrame(fh_rows).T.to_string())

S6_OK, s6_rows = {}, {}
for u, g in S6R.groupby('universe'):
    v = g.mean_gross.dropna()
    t_ = float(stats.ttest_1samp(v, 0.0).statistic) if len(v) > 2 else np.nan
    lo_rate = float((g.ci_lo_gross > 0).mean())
    S6_OK[u] = bool(np.isfinite(t_) and abs(t_) < 2.5 and lo_rate <= 0.15)
    s6_rows[u] = dict(mean=v.mean(), t=t_, ci_lo_pos_rate=lo_rate, ok=S6_OK[u])
print('\nS6 top decile - universe:'); print(pd.DataFrame(s6_rows).T.to_string())
print('\nSELECTION NULL:', 'PASS' if SEL_OK else 'FAIL -> STOP (S4/S5 stay off real data)')
'''),
        ("code", r'''
# ===== Cell 6 — power (only if the null passed) + write the protocol file =====
POWER_OK, PW = False, pd.DataFrame()
if SEL_OK:
    pcfg = [c for c in CONFIGS if c['family'] == 'S4_T1' or c['name'] == 'S5_h20']
    rows = []
    for s in range(POWER_SEEDS):
        r_, _ = run_world(1000 + s, plant=True, cfgs=pcfg, univs=['U2'], s6=False); rows += r_
    PW = pd.DataFrame(rows)
    det_s4 = PW[PW.family == 'S4_T1'].groupby('seed').pct.mean() >= PCT_PASS
    det_s5 = PW[PW.cfg == 'S5_h20'].set_index('seed').pct >= PCT_PASS
    need = int(math.ceil(0.75 * POWER_SEEDS))
    POWER_OK = bool(det_s4.sum() >= need and det_s5.sum() >= need)
    print(PW[['seed', 'cfg', 'n', 'pct']].to_string(index=False))
    print(f'power: S4_T1 detected {int(det_s4.sum())}/{POWER_SEEDS}, S5_h20 {int(det_s5.sum())}/{POWER_SEEDS} '
          f'(need {need}) -> {"PASS" if POWER_OK else "FAIL"}')
PROTO = dict(written_utc=pd.Timestamp.now(tz='UTC').isoformat(), n_seeds=N_SEEDS, n_draws=N_DRAWS,
             power_seeds=POWER_SEEDS, selection_null_ok=SEL_OK, pooled_pass_rate=pooled,
             families=json.loads(FAM.to_json(orient='index')), power_ok=POWER_OK, fh_allowed=FH_ALLOWED,
             fh=fh_rows, s6_ok=S6_OK, s6=s6_rows, u1_sha=sha(U1_FILE), n_u1=int(IS_U1.sum()))
json.dump(PROTO, open(PROTO_FILE, 'w'), indent=1, default=float)
print(f'\nwrote {PROTO_FILE}')
print(f'SUMMARY: selection null {"PASS" if SEL_OK else "FAIL"} | power {"PASS" if POWER_OK else "FAIL/not run"} | '
      f'FH allowed {FH_ALLOWED} | S6 ok {S6_OK}')
'''),
    ]

    # ------------------------------------------------------------ real-data notebook
    REAL = [
        ("markdown", r'''
# Screen pack 2 — S4 dip-in-uptrend, S5 abnormal volume / quiet price, S6 overnight momentum (TRIALS)

Chart-only screens on the Drive corpus. **Gated:** runs only with `pack2/pack2_protocol.json` from
`screen_pack2_protocol.ipynb` (16-seed martingale protocol). S4/S5 need `selection_null_ok` and `power_ok`; S6
needs `s6_ok` for that universe; fixed horizons are only those the protocol allowed. The U1 file must be the one the
protocol validated (sha256).

**Lockbox:** every series cut at 2024-12-31 at load; IS entries 2011-01-03 .. 2023-12-29 (2024 bars only resolve
holds). Costs 0.15% round trip; break-even = mean gross per trade (S6: mean gross / mean turnover).

**Rules (each rule × universe is ONE TRIAL, appended to `results/screens/screens_trial_log.csv`):**
- **S4** (24 trials): close > SMA200 and SMA50 > SMA200; trigger T1 RSI(2) < 10 | T2 3 lower closes | T3 close < prior
  20-bar low close; entry next open; exit X1 close > SMA5 | X2 RSI(2) > 70 (next open), 10-bar time stop; ± 10% stop.
- **S5** (4 trials): volume ≥ 3 × 50-bar avg (t-50..t-1) and |ΔC| < ATR(14) (t-14..t-1); entry next open; hold 20 / 60.
- **S6** (2 trials): month-end, top decile (≥ 5 names) by 21-bar overnight-return sum; hold close→next month-end
  close vs the universe EW; turnover × 0.15%.

**Universes:** U1 = approved ETFs (non-leveraged); U2 = top 300 stocks by trailing 60-bar $vol (causal).

**Verdict (pre-registered):** *worth drilling* iff (a) the 2019-2023 statistic > 0, (b) ≥ 9 of 13 years > 0, and
(c) for S4/S5 the selection-null percentile ≥ 90. Selection null = duration-matched (same entry/exit bars as
each real trade, random other eligible ticker; validated by the protocol). S4/S5 statistic = avg net return − that year's (era's)
selection-null mean; S6 statistic = monthly net excess (summed per year). Drill later with full gates.
Pack-1 rows (8) and the S3 drill grid (16) are BACKFILLED into the trial log, flagged.
'''),
        ("code", "# ===== Cell 0 — config =====\n" + CONFIG + r'''
TRIAL_LOG, TRIAL_RET = OUT_DIR/'screens_trial_log.csv', OUT_DIR/'screens_trial_returns.csv'
'''),
        ("code", "# ===== Cell 1 — core (shared with the protocol notebook) =====\n" + CORE),
        ("code", r'''
# ===== Cell 2 — gate on the protocol file =====
assert PROTO_FILE.exists(), 'run screen_pack2_protocol.ipynb first'
PROTO = json.load(open(PROTO_FILE))
assert PROTO['n_seeds'] >= 16 or os.environ.get('PACK2_TEST') == '1', 'protocol must use >= 16 seeds'
assert PROTO['u1_sha'] == sha(U1_FILE), 'U1 list changed since the protocol ran — re-run the protocol'
RUN_S45 = bool(PROTO['selection_null_ok'] and PROTO['power_ok'])
FH_ALLOWED = {k: [int(h) for h in v] for k, v in PROTO['fh_allowed'].items()}
S6_OK = PROTO['s6_ok']
print(f'protocol {PROTO["written_utc"]}: selection null {PROTO["selection_null_ok"]}, power {PROTO["power_ok"]} '
      f'-> S4/S5 {"RUN" if RUN_S45 else "STOPPED"} | FH allowed {FH_ALLOWED} | S6 {S6_OK}')
'''),
        ("code", r'''
# ===== Cell 3 — real panels, indicators, universes =====
t0 = time.time()
TICKERS, CAL, P = load_panels(); calendar_consts(CAL)
assert CAL.max() <= CUT_DATE
IS_STOCK, IS_U1 = asset_masks(TICKERS); I_SPY = TICKERS.index('SPY')
CTX = build_ctx(P['O'], P['H'], P['L'], P['C'], P['V'], IS_STOCK, IS_U1, I_SPY)
yrs_ = CAL.year
for u in UNIVS:
    sz = pd.Series(CTX['UN'][u].sum(1), index=CAL)
    print(f'{u}: members per day by year (median):', sz.groupby(yrs_).median().loc[2011:2023].astype(int).to_dict())
print(f'[{time.time()-t0:.0f}s]')
'''),
        ("code", r'''
# ===== Cell 4 — S4 and S5 on real data =====
RES = {}
def pct_(x): return f'{x:+.2%}' if np.isfinite(x) else 'nan'

if RUN_S45:
    for cfg in CONFIGS:
        for u in UNIVS:
            t0 = time.time()
            RES[(cfg['name'], u)] = run_cfg(CTX, cfg, u, N_DRAWS, 7 + len(RES), FH_ALLOWED[cfg['screen']])
            print(f'  {cfg["name"]:20s} {u}: n={RES[(cfg["name"], u)]["n"]:6d}  [{time.time()-t0:.0f}s]')

def trade_row(o):
    g, n_ = o['gross'], o['net']
    if not len(n_): return dict(n=0)
    bars = (o['x'] - o['t']).mean()                      # entry t+1 .. exit bar x inclusive
    pf = lambda v: v[v > 0].sum() / -v[v < 0].sum() if (v < 0).any() else np.inf
    yr = pd.Series(n_).groupby(o['year']).mean().reindex(range(Y0, Y0 + NY))
    exc_y = yr.to_numpy() - o['null_year_mean']
    yrs_pos = int(np.nansum(exc_y > 0))
    verdict = bool(np.isfinite(o['era_exc']) and o['era_exc'] > 0 and yrs_pos >= MIN_YEARS
                   and np.isfinite(o['pct']) and o['pct'] >= PCT_PASS)
    return dict(n=len(n_), WR=(n_ > 0).mean(), PF=pf(g), PF_cost=pf(n_), avg_net=n_.mean(), avg_bars=bars,
                breakeven=g.mean(), null_mean=o['null_mean'], pct=o['pct'], era_exc=o['era_exc'],
                yrs_pos=yrs_pos, VERDICT=verdict, _exc_y=exc_y)

TAB = {}
if RUN_S45:
    TAB = {k: trade_row(o) for k, o in RES.items()}
    T4 = pd.DataFrame({k: {c: v for c, v in r.items() if not c.startswith('_')} for k, r in TAB.items()}).T
    T4.index.names = ['rule', 'universe']
    show = T4.copy()
    for c in ['avg_net', 'breakeven', 'null_mean', 'era_exc']: show[c] = show[c].map(lambda x: pct_(float(x)))
    for c in ['WR', 'PF', 'PF_cost', 'avg_bars', 'pct']: show[c] = show[c].astype(float).round(2)
    print('\nS4 / S5 trade stats (net = after 0.15% round trip; break-even = mean gross):')
    print(show.to_string())
    EXC = pd.DataFrame({k: r['_exc_y'] for k, r in TAB.items() if r['n']}, index=range(Y0, Y0 + NY)).T * 1e4
    print('\nPer-year avg net minus that year\'s selection-null mean (bp):'); print(EXC.round(0).to_string())
    for k, o in RES.items():
        for h, res in (o['fh'] or {}).items():
            if res: print(f'  FH{h} {k[0]:20s} {k[1]}: vs EW {pct_(res["ew"]["mean"])} CI [{pct_(res["ew"]["lo"])}, '
                          f'{pct_(res["ew"]["hi"])}] | vs SPY {pct_(res["spy"]["mean"])} (n {res["ew"]["n"]})'
                          + ('  [S4: descriptive]' if k[0].startswith('S4') else ''))
    T4.to_csv(P2_DIR/'s4_s5_stats.csv'); EXC.to_csv(P2_DIR/'s4_s5_per_year_excess_bp.csv')
'''),
        ("code", r'''
# ===== Cell 5 — S6 overnight momentum =====
S6 = {}
for u in UNIVS:
    if not S6_OK.get(u, False):
        print(f'S6 {u}: STOPPED (protocol)'); continue
    M = s6_monthly(CTX, u, CAL); sm = s6_summary(M, 11)
    S6[u] = (M, sm)
    if not sm.get('n'): print(f'S6 {u}: no months'); continue
    sm['VERDICT'] = bool(np.isfinite(sm['era_net']) and sm['era_net'] > 0 and sm['yrs_pos'] >= MIN_YEARS)
    print(f'S6 {u}: {sm["n"]} months | names/month median {int(M.k.median())} of {int(M.n_univ.median())} | '
          f'gross {pct_(sm["mean_gross"])}/mo, turnover {sm["mean_turn"]:.0%}, net {pct_(sm["mean_net"])}/mo '
          f'CI90 [{pct_(sm["ci_lo"])}, {pct_(sm["ci_hi"])}] | era {pct_(sm["era_net"])} | years>0 {sm["yrs_pos"]}/13 | '
          f'break-even {sm["breakeven"]*1e4:.0f}bp/round trip -> {"WORTH DRILLING" if sm["VERDICT"] else "not worth drilling"}')
    print('  per-year net excess:', {y: pct_(v) for y, v in sm['per_year'].items()})
    M.to_csv(P2_DIR/f's6_monthly_{u}.csv', index=False)
'''),
        ("code", r'''
# ===== Cell 6 — verdicts + trial log (append-only; backfill flagged) =====
now = pd.Timestamp.now(tz='UTC').isoformat()

def moments(v):
    v = pd.Series(v).dropna()
    return dict(sd=v.std(), skew=v.skew(), kurt=v.kurt(), sr_monthly=v.mean() / v.std() if v.std() > 0 else np.nan)

rows, rets = [], []
for (name, u), o in RES.items():
    r = TAB[(name, u)]; cid = f'pack2|{name.split("_")[0]}|{u}|{name}'
    m = (pd.Series(o['net']).groupby(np.asarray(CAL[o['t'] + 1].to_period('M').astype(str))).mean()
         if o['n'] else pd.Series(dtype=float))
    rows.append(dict(kind='trial', config_id=cid, pack='pack2', screen=name.split('_')[0], universe=u, rule=name,
                     n=r['n'], n_months=len(m), WR=r.get('WR'), PF=r.get('PF'), PF_cost=r.get('PF_cost'),
                     avg_net=r.get('avg_net'), **moments(m), pct_null=r.get('pct'), verdict=r.get('VERDICT'),
                     backfilled=False, note='', logged_at=now))
    rets += [dict(config_id=cid, month=mm, ret=v) for mm, v in m.items()]
for u, (M, sm) in S6.items():
    if not sm.get('n'): continue
    cid = f'pack2|S6|{u}|S6_top_decile_overnight21'; m = M.set_index('month')['net']
    rows.append(dict(kind='trial', config_id=cid, pack='pack2', screen='S6', universe=u, rule='S6_top_decile_overnight21',
                     n=sm['n'], n_months=sm['n'], WR=(M.net > 0).mean(), PF=np.nan, PF_cost=np.nan,
                     avg_net=sm['mean_net'], **moments(m), pct_null=np.nan, verdict=sm['VERDICT'],
                     backfilled=False, note='monthly net excess vs universe EW', logged_at=now))
    rets += [dict(config_id=cid, month=mm, ret=v) for mm, v in m.items()]
BACKFILL = ([('pack1', 'S1', r) for r in ['W[-3,+3]', 'W[-1,+3]', 'day +1']]
            + [('pack1', 'S2', r) for r in ['day -1', 'day -1 ex-TOM', 'day -2']]
            + [('pack1', 'S3', r) for r in ['recon+20', 'July month']]
            + [('s3drill', 'S3', f'e={e}|H={h}') for e in [-5, -3, -1, 0] for h in [10, 15, 20, 30]])
for pk, scr, rule in BACKFILL:
    rows.append(dict(kind='trial', config_id=f'{pk}|{scr}|{rule}', pack=pk, screen=scr, universe='SPY' if scr in ('S1', 'S2') else 'IJR-IWM',
                     rule=rule, backfilled=True, logged_at=now,
                     note='BACKFILLED 2026-10-03: count only; stats in results/screens/' + ('s3_drill/' if pk == 's3drill' else '')))
LOG = pd.DataFrame(rows); RET = pd.DataFrame(rets)
if len(RET): RET['key'] = RET.config_id + '|' + RET.month

def append_log(path, df, key='config_id'):
    """Append-only; an identical config already logged is not a new trial (Stage 1 convention)."""
    if path.exists():
        old = pd.read_csv(path, dtype={key: str}); new = df[~df[key].isin(old[key])]
        pd.concat([old, new], ignore_index=True).to_csv(path, index=False); return len(new), len(old) + len(new)
    df.to_csv(path, index=False); return len(df), len(df)

n_new, n_tot = append_log(TRIAL_LOG, LOG)
if len(RET): append_log(TRIAL_RET, RET, key='key')
allL = pd.read_csv(TRIAL_LOG)
print(f'trial log: +{n_new} new | cumulative trials {int((allL.kind == "trial").sum())} '
      f'({int(allL.backfilled.astype(str).eq("True").sum())} backfilled)')
print('\nVERDICTS (era 2019-2023 > 0 AND >= 9/13 years > 0 AND [S4/S5] null pct >= 90):')
for _, r in LOG[~LOG.backfilled].iterrows():
    print(f'  {"WORTH DRILLING    " if r.verdict else "not worth drilling"}  {r.rule:22s} {r.universe}'
          + (f'  (pct {r.pct_null:.0f})' if pd.notna(r.pct_null) else ''))
if not RUN_S45: print('  S4/S5: STOPPED by the protocol — no trials logged for them')
'''),
    ]
    return PROTO, REAL
