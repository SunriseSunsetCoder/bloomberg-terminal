# Cell sources for S4b (dip-in-uptrend time-series event study on SPY + 11 sector SPDRs).
# Imported by _build_notebooks.py; reuses screen pack 2's config + core. Edit HERE, then rebuild.


def build(PARTS):
    CONFIG, CORE = PARTS['CONFIG'], PARTS['CORE']

    S4B_CONFIG = r'''

# ---- S4b (decisions 2026-10-03) ----
S4B_DIR = OUT_DIR/'s4b'; S4B_DIR.mkdir(parents=True, exist_ok=True); S4B_PROTO = S4B_DIR/'s4b_protocol.json'
ETFS = ['SPY', 'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY']
TRIGS = ['T1', 'T2', 'T3']
OUTCOMES = [('X1', 0, 10), ('X2', 1, 10), ('H5', 2, 5), ('H10', 2, 10), ('H20', 2, 20)]   # (name, sim mode, hold bars)
MIN_EVENTS_YEAR, MIN_QUAL_YEARS, Q_PASS = 10, 9, 90.0
S4B_BINDING = 64                                          # 2026-10-03: ONE binding 64-seed run (replaces the 16-seed FAIL)
S4B_SEEDS = int(os.environ.get('S4B_SEEDS', S4B_BINDING)); S4B_POWER_SEEDS = int(os.environ.get('S4B_POWER_SEEDS', 4))
M_STEPS, ON_FRAC, MKT_SD, MKT_MU = 12, 0.2, 0.01, 0.0003
PLANT_REV = 0.010                                         # power: +1.0%/bar x 3 bars after a > 2 sigma down close (~40 bp/event)
TRIAL_LOG, TRIAL_RET = OUT_DIR/'screens_trial_log.csv', OUT_DIR/'screens_trial_returns.csv'
'''

    S4B_CORE = r'''


# ---------------------------------------------------------------- S4b event study
def etf_ctx(O, H, L, C, V):
    """Indicators, trend and triggers on the 12-ETF panel (T x 12); N x T copies for the simulator."""
    I = indicators(O, H, L, C, V)
    C1, C2, C3 = lag(C, 1), lag(C, 2), lag(C, 3)
    trend = (C > I['S200']) & (I['S50'] > I['S200'])
    TRIG = {'T1': I['RSI'] < 10, 'T2': (C < C1) & (C1 < C2) & (C2 < C3), 'T3': C < I['LOW20p']}
    NT = {k: np.ascontiguousarray(x.T) for k, x in dict(O=O, H=H, L=L, C=C, S5=I['S5'], RSI=I['RSI']).items()}
    return dict(trend=trend, TRIG=TRIG, NT=NT, O=O, C=C)


def baseline_table(ctx, trig, max_len=20):
    """Mean return over every other uptrend day of the same ETF (trend true, THIS trigger false; signal day in the IS
    range), entry at the next open, exit L bars later at the open (xt 0) or close (xt 1). Shape (N, max_len+1, 2)."""
    O, C = ctx['O'], ctx['C']; T, N = C.shape
    B = ctx['trend'] & ~ctx['TRIG'][trig]
    out = np.full((N, max_len + 1, 2), np.nan)
    for k in range(N):
        s = np.nonzero(B[T_LO:T_HI + 1, k])[0] + T_LO; e = s + 1
        for L_ in range(max_len + 1):
            x = e + L_; ok = x < T
            for xt, PX in ((0, O), (1, C)):
                r = PX[x[ok], k] / O[e[ok], k] - 1
                out[k, L_, xt] = np.nanmean(r) if np.isfinite(r).any() else np.nan
    return out


def run_trial(ctx, trig, outcome, seed=0):
    """Non-overlapping events per ETF (the simulator's one-position rule), excess = event gross - same-ETF baseline of
    the SAME length and exit price type - COST (costs on the event only; baseline gross)."""
    name, mode, hold = outcome
    sig = ctx['trend'] & ctx['TRIG'][trig]; nt = ctx['NT']
    k, t, x, r, xt = run_rule(np.ascontiguousarray(sig.T), nt['O'], nt['H'], nt['L'], nt['C'], nt['S5'], nt['RSI'],
                              mode, hold, False, 0.0, T_LO, T_HI)
    BT = baseline_table(ctx, trig)
    Lr = x - (t + 1)
    base = BT[k, Lr, xt]
    gross_exc = r - base; exc = gross_exc - COST
    ok = np.isfinite(exc); k, t, x, r, exc, gross_exc = k[ok], t[ok], x[ok], r[ok], exc[ok], gross_exc[ok]
    ent = CAL[t + 1]; yr = ent.year.to_numpy(); mo = np.asarray(ent.to_period('M').astype(str))
    out = dict(trig=trig, outcome=name, n=len(exc), k=k, t=t, exc=exc, year=yr, month=mo)
    if len(exc) < 20:
        out.update(mean=np.nan, q=np.nan, mean_gross=np.nan, q_gross=np.nan, verdict=False); return out
    lo_, hi_, q_ = year_ci(exc, mo, BOOT_REPS, seed, CI_LEVEL)          # month-block bootstrap (NET: the verdict)
    q_g = year_ci(gross_exc, mo, BOOT_REPS, seed, CI_LEVEL)[2]          # GROSS: what the martingale check centres
    yt = pd.DataFrame({'year': yr, 'exc': exc}).groupby('year')['exc'].agg(['size', 'mean']).reindex(range(Y0, Y0 + NY))
    qual = yt[yt['size'] >= MIN_EVENTS_YEAR]
    n_q, n_pos = len(qual), int((qual['mean'] > 0).sum())
    lo_e, hi_e = ERAS[RECENT]; era = (yr >= lo_e) & (yr <= hi_e)
    era_m = float(exc[era].mean()) if era.any() else np.nan
    verdict = bool(np.isfinite(era_m) and era_m > 0 and n_q >= MIN_QUAL_YEARS and n_pos >= math.ceil(2 * n_q / 3)
                   and q_ >= Q_PASS)
    out.update(mean=float(exc.mean()), mean_gross=float(gross_exc.mean()), q_gross=q_g, breakeven=float(gross_exc.mean()),
               avg_gross=float(r.mean()), ci_lo=lo_, ci_hi=hi_, q=q_, era=era_m, n_qual=n_q, n_pos_qual=n_pos,
               avg_bars=float((x - t).mean()), per_year=yt, verdict=verdict)
    return out


@njit(cache=True)
def gen_world(seed, mkt, sd_i, first, last, P0, M, on_frac, plant_rev, rev_thr, plant_vol, vspike):
    """Pack-2 generator (intrabar paths, martingale idio, market drift); copied verbatim."""
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


def append_log(path, df, key='config_id'):
    """Append-only; an identical config already logged is not a new trial."""
    if path.exists():
        old = pd.read_csv(path, dtype={key: str}); new = df[~df[key].isin(old[key])]
        pd.concat([old, new], ignore_index=True).to_csv(path, index=False); return len(new), len(old) + len(new)
    df.to_csv(path, index=False); return len(df), len(df)
'''

    CELLS = [
        ("markdown", r'''
# S4b — dip in uptrend as a TIME-SERIES EVENT STUDY on SPY + 11 sector SPDRs

Each ETF is tested against its own history. Pre-registered 2026-10-03, after pack 2's S4 was taken off real data
(binding protocol). The S4 tilt there came entirely from the 10% disaster-stop fill rule, so **there's no disaster
stop here**.

**Lockbox:** cut at load 2024-12-31; signal bars so that entries are 2011-01-03 .. 2023-12-29.

**Events:**
- Close > SMA200 and SMA50 > SMA200, and a trigger: T1 RSI(2) < 10 | T2 3 lower closes | T3 close < prior 20-bar low
  close.
- Entry at the next open. **Non-overlapping per ETF:** the next event is allowed only once the current window has
  ended.
- ETFs become eligible when SMA200 exists (XLRE ≈ 2016, XLC ≈ 2019).

**Outcomes:** 3 triggers × 5 = 15 TRIALS, pooled across the 12 ETFs.
- X1: close > SMA5. X2: RSI(2) > 70. Both exit at the next open, with a 10-bar time stop.
- Fixed horizons H5 / H10 / H20: open of t+1 → close of t+h.

**Excess per event** = event gross return − same-ETF baseline − 0.15%. The baseline is the mean return over a window
of the SAME length and exit price type, starting on every other uptrend day of that ETF where the same trigger did
not fire (IS range). Costs apply to the event only; the baseline is gross. Matching the length removes holding-time ×
drift.

**Statistics:** pooled mean excess and a month-block bootstrap 90% CI. q = share of bootstrap means > 0. Also break-
even (mean gross excess), per year, by era, and per ETF (descriptive).

**Verdict (pre-registered):** *worth drilling* iff ALL of:
- 2019-2023 mean excess > 0;
- ≥ 9 qualifying years (a year qualifies with ≥ 10 events) AND positive in ≥ 2/3 of the qualifying years;
- q ≥ 90.

**Binding rerun (decision 2026-10-03):** the first run (16 seeds) failed centring only on T2's mean q of 60.4 (every
|t| < 2.5). It is re-run ONCE at **64 seeds** with the same checks, and that run is binding: a fail closes S4b. The
power plant was set BEFORE the rerun at **+1.0%/bar for 3 bars** (≈ 40 bp gross per event, about 2.5x costs); the
0.5% plant gave only ≈ 20 bp, which is below what's worth trading. The 16-seed files are archived; the notebook
refuses to overwrite a ≥ 64-seed result.

**Martingale validation FIRST (standing rule; fail = STOP).** 64 worlds use the pack-2 generator restricted to the 12
ETFs: real listing spans, market drift on, intrabar paths, no edge.
- All on GROSS excess. The 0.15% cost is a known constant, so net excess is negative by construction; the verdict
  on real data uses NET.
- Per trigger family: mean gross excess over the 64 per-seed values with |t| < 2.5, and mean gross q in [40, 60]
  with |t| < 2.5.
- Pooled share of (seed × trial) with gross q ≥ 90 must be ≤ 15%.
- Power: +1.0%/bar planted for 3 bars after any > 2σ down close. Detected in a seed when ≥ 3 of the 5 T1 outcomes
  have gross q ≥ 90; power passes with detection in ≥ 3 of 4 seeds. (Per-outcome rule, decided before the binding
  run: a 3-bar effect is diluted in H10/H20, so a 5-outcome mean understates detection.)

The real-data cells refuse to run unless `s4b/s4b_protocol.json` says PASS.
'''),
        ("code", "# ===== Cell 0 — config (pack-2 base + S4b) =====\n" + CONFIG + S4B_CONFIG),
        ("code", "# ===== Cell 1 — core (pack-2 core + S4b event study) =====\n" + CORE + S4B_CORE),
        ("code", r'''
# ===== Cell 2 — panels (cut at load; pack-2 cache) -> the 12 ETFs =====
t0 = time.time()
TICKERS, CAL, P = load_panels(); calendar_consts(CAL)
missing = [e for e in ETFS if e not in TICKERS]; assert not missing, f'ETFs missing from the corpus: {missing}'
IX = [TICKERS.index(e) for e in ETFS]
E = {c: np.ascontiguousarray(P[c][:, IX]) for c in 'OHLCV'}; del P
assert CAL.max() <= CUT_DATE
first_bar = {e: CAL[int(np.argmax(np.isfinite(E['C'][:, i])))].date() for i, e in enumerate(ETFS)}
print(f'{len(ETFS)} ETFs x {len(CAL)} bars [{time.time()-t0:.0f}s]; first bars: {first_bar}')
'''),
        ("markdown", "## Part A — martingale validation (must PASS before Part B)"),
        ("code", r'''
# ===== Cell 3 — worlds restricted to the 12 ETFs =====
Creal = E['C']; T_, N_ = Creal.shape; valid = np.isfinite(Creal)
FIRST = np.where(valid.any(0), valid.argmax(0), -1).astype(np.int64)
LAST = np.where(valid.any(0), T_ - 1 - valid[::-1].argmax(0), -1).astype(np.int64)
P0 = np.array([Creal[FIRST[i], i] for i in range(N_)])
sd = np.clip(np.nanstd(np.diff(np.log(Creal), axis=0), axis=0), 0.005, 0.10)
SD_I = np.sqrt(np.maximum(sd ** 2 - MKT_SD ** 2, (0.25 * sd) ** 2))
NOSPIKE = np.zeros((N_, T_), bool)


def make_world(seed, plant=False):
    rng = np.random.default_rng(20_000 + seed)
    mkt = np.empty((T_, M_STEPS + 1))
    mkt[:, 0] = rng.normal(MKT_MU * ON_FRAC - 0.5 * MKT_SD ** 2 * ON_FRAC, MKT_SD * np.sqrt(ON_FRAC), T_)
    s_in = MKT_SD * np.sqrt((1 - ON_FRAC) / M_STEPS)
    mkt[:, 1:] = rng.normal(MKT_MU * (1 - ON_FRAC) / M_STEPS - 0.5 * s_in ** 2, s_in, (T_, M_STEPS))
    O, Hh, Ll, Cc = gen_world(seed, mkt, SD_I, FIRST, LAST, P0, M_STEPS, ON_FRAC,
                              PLANT_REV if plant else 0.0, 2 * sd, 0.0, NOSPIKE)
    W = {c: np.ascontiguousarray(x.T) for c, x in zip('OHLC', (O, Hh, Ll, Cc))}
    for c in 'OHLC': W[c][~valid] = np.nan
    return W


def run_world(seed, plant=False, trigs=TRIGS):
    W = make_world(seed, plant); ctx = etf_ctx(W['O'], W['H'], W['L'], W['C'], E['V'])
    return [dict(seed=seed, trig=tg, outcome=oc[0], **{k: v for k, v in run_trial(ctx, tg, oc, seed).items()
                                                      if k in ('n', 'mean_gross', 'q_gross')})
            for tg in trigs for oc in OUTCOMES]


# ONE binding run (decision 2026-10-03): replaces the 16-seed FAIL (archived); refuses to overwrite a >= 64-seed result.
OLD = json.load(open(S4B_PROTO)) if S4B_PROTO.exists() else None
if OLD and OLD.get('n_seeds', 0) >= S4B_BINDING and os.environ.get('PACK2_TEST') != '1':
    raise RuntimeError(f'binding {OLD["n_seeds"]}-seed S4b validation already written {OLD["written_utc"]} — no reruns')
if OLD:
    tag = f'{OLD.get("n_seeds", 0)}seed_superseded'
    for f_ in [S4B_PROTO, S4B_DIR/'protocol_records.csv']:
        if f_.exists(): f_.rename(f_.with_name(f'{f_.stem}_{tag}{f_.suffix}'))
    print(f'archived the superseded {OLD.get("n_seeds")}-seed validation (*_{tag})')

REC = []
for seed in range(S4B_SEEDS):
    t0 = time.time(); r_ = run_world(seed); REC += r_; d_ = pd.DataFrame(r_)
    print(f'seed {seed:2d}: {time.time()-t0:4.0f}s | events/trial median {int(d_.n.median())} | '
          f'q_gross>=90 {int((d_.q_gross >= Q_PASS).sum())}/15 | mean q_gross {d_.q_gross.mean():.1f}')
REC = pd.DataFrame(REC); REC.to_csv(S4B_DIR/'protocol_records.csv', index=False)
'''),
        ("code", r'''
# ===== Cell 4 — evaluate + power + write s4b_protocol.json =====
def t_vs(v, mu):
    v = np.asarray(v, float); v = v[np.isfinite(v)]
    return float(stats.ttest_1samp(v, mu).statistic) if len(v) > 2 and v.std() > 0 else np.nan

fam = {}
for tg, g in REC.groupby('trig'):
    ps = g.groupby('seed').agg(mean=('mean_gross', 'mean'), q=('q_gross', 'mean'))
    fam[tg] = dict(mean_gross_exc=ps['mean'].mean(), t_exc=t_vs(ps['mean'], 0.0), mean_q=ps['q'].mean(),
                   t_q=t_vs(ps['q'], 50.0), pass_rate=float((g.q_gross >= Q_PASS).mean()), n_seeds=len(ps))
FAM = pd.DataFrame(fam).T
pooled = float((REC.q_gross >= Q_PASS).mean())
centring = bool(len(FAM) == 3 and (FAM.t_exc.abs() < 2.5).all() and FAM.mean_q.between(40, 60).all()
                and (FAM.t_q.abs() < 2.5).all())
NULL_OK = bool(centring and pooled <= 0.15)
print(FAM.round(4).to_string())
print(f'GROSS excess (cost is a known constant, so the null is centred gross; the verdict on real data is NET)')
print(f'pooled share q_gross >= {Q_PASS:.0f}: {pooled:.1%} (<= 15%) | centring {"PASS" if centring else "FAIL"}')
print('by outcome:'); print(REC.groupby('outcome').agg(mean_gross=('mean_gross', 'mean'), q_gross=('q_gross', 'mean')).round(4).to_string())

POWER_OK, det = False, []
if NULL_OK:
    for s in range(S4B_POWER_SEEDS):
        pw = pd.DataFrame(run_world(1000 + s, plant=True, trigs=['T1']))
        n_det = int((pw.q_gross >= Q_PASS).sum()); det.append(n_det)      # per-outcome detection (decision 2026-10-03)
        print(f'power seed {1000+s}: T1 outcomes with q_gross >= {Q_PASS:.0f}: {n_det}/5  '
              + ' '.join(f'{o}={q:.0f}' for o, q in zip(pw.outcome, pw.q_gross)))
    POWER_OK = sum(d >= 3 for d in det) >= math.ceil(0.75 * S4B_POWER_SEEDS)
S4B_OK = bool(NULL_OK and POWER_OK)
json.dump(dict(written_utc=pd.Timestamp.now(tz='UTC').isoformat(), n_seeds=S4B_SEEDS, power_seeds=S4B_POWER_SEEDS,
               families=json.loads(FAM.to_json(orient='index')), pooled=pooled, centring=centring, null_ok=NULL_OK,
               power_q=det, power_ok=POWER_OK, ok=S4B_OK), open(S4B_PROTO, 'w'), indent=1, default=float)
print(f'SUMMARY S4b protocol ({S4B_SEEDS} seeds): null {"PASS" if NULL_OK else "FAIL"} | power '
      f'{"PASS" if POWER_OK else ("FAIL" if NULL_OK else "not run")} -> real data {"ALLOWED" if S4B_OK else "STOPPED"}')
'''),
        ("markdown", "## Part B — real data (gated on Part A)"),
        ("code", r'''
# ===== Cell 5 — gate =====
PRO = json.load(open(S4B_PROTO))
assert PRO['ok'], 'S4b martingale validation did not pass -> STOP (standing rule); real data not touched'
assert PRO['n_seeds'] >= 64 or os.environ.get('PACK2_TEST') == '1', 'needs the binding 64-seed validation'
print('S4b protocol PASS', PRO['written_utc'])
'''),
        ("code", r'''
# ===== Cell 6 — 15 trials on real data =====
assert json.load(open(S4B_PROTO))['ok'], 'S4b validation did not pass -> STOP'
CTX = etf_ctx(E['O'], E['H'], E['L'], E['C'], E['V'])
RES = {(tg, oc[0]): run_trial(CTX, tg, oc, 31 + i) for i, (tg, oc) in enumerate((tg, oc) for tg in TRIGS for oc in OUTCOMES)}
pct = lambda v: f'{v:+.2%}' if np.isfinite(v) else 'nan'
rows = {}
for key, o in RES.items():
    rows[key] = dict(n=o['n'], avg_bars=o.get('avg_bars'), avg_gross=pct(o.get('avg_gross', np.nan)),
                     excess_net=pct(o['mean']), ci90=f'[{pct(o.get("ci_lo", np.nan))}, {pct(o.get("ci_hi", np.nan))}]',
                     q=round(o['q'], 1) if np.isfinite(o['q']) else np.nan, era_19_23=pct(o.get('era', np.nan)),
                     qual_years=o.get('n_qual'), pos_qual=o.get('n_pos_qual'), breakeven=pct(o.get('breakeven', np.nan)),
                     VERDICT=o['verdict'])
TB = pd.DataFrame(rows).T; TB.index.names = ['trigger', 'outcome']
pd.set_option('display.width', 250)
print('S4b — pooled over 12 ETFs (excess = event - same-length same-ETF baseline - 0.15%):'); print(TB.to_string())
PY = pd.DataFrame({f'{k[0]}_{k[1]}': o['per_year']['mean'] for k, o in RES.items() if 'per_year' in o}).T * 1e4
PN = pd.DataFrame({f'{k[0]}_{k[1]}': o['per_year']['size'] for k, o in RES.items() if 'per_year' in o}).T
print('\nPer-year mean excess (bp):'); print(PY.round(0).to_string())
print('\nPer-year event counts (a year qualifies with >= 10):'); print(PN.fillna(0).astype(int).to_string())
PE = pd.DataFrame({f'{k[0]}_{k[1]}': pd.Series(o['exc']).groupby(np.asarray(ETFS)[o['k']]).mean()
                   for k, o in RES.items() if o['n']}).T * 1e4
print('\nPer-ETF mean excess (bp, descriptive):'); print(PE.round(0).to_string())
TB.to_csv(S4B_DIR/'s4b_trials.csv'); PY.to_csv(S4B_DIR/'s4b_per_year_bp.csv'); PE.to_csv(S4B_DIR/'s4b_per_etf_bp.csv')
'''),
        ("code", r'''
# ===== Cell 7 — verdicts + trial log =====
assert json.load(open(S4B_PROTO))['ok'], 'S4b validation did not pass -> STOP'
now = pd.Timestamp.now(tz='UTC').isoformat(); rows, rets = [], []
for (tg, oc), o in RES.items():
    cid = f's4b|S4b|ETF12|{tg}_{oc}'
    m = pd.Series(o['exc']).groupby(o['month']).mean() if o['n'] else pd.Series(dtype=float)
    rows.append(dict(kind='trial', config_id=cid, pack='s4b', screen='S4b', universe='ETF12', rule=f'{tg}_{oc}',
                     n=o['n'], n_months=len(m), WR=float((o['exc'] > 0).mean()) if o['n'] else np.nan,
                     avg_net=o['mean'], sd=m.std(), skew=m.skew(), kurt=m.kurt(),
                     sr_monthly=m.mean() / m.std() if m.std() > 0 else np.nan, pct_null=o['q'], verdict=o['verdict'],
                     backfilled=False, note='excess vs same-length same-ETF baseline, net of 0.15%', logged_at=now))
    rets += [dict(config_id=cid, month=mm, ret=v) for mm, v in m.items()]
LOG = pd.DataFrame(rows); RET = pd.DataFrame(rets)
if len(RET): RET['key'] = RET.config_id + '|' + RET.month
n_new, n_tot = append_log(TRIAL_LOG, LOG)
if len(RET): append_log(TRIAL_RET, RET, key='key')
allL = pd.read_csv(TRIAL_LOG)
print(f'trial log: +{n_new} new | cumulative trials {int((allL.kind == "trial").sum())}')
print('\nVERDICTS (era 2019-2023 > 0 AND >= 9 qualifying years with >= 2/3 positive AND q >= 90):')
for _, r in LOG.iterrows():
    print(f'  {"WORTH DRILLING    " if r.verdict else "not worth drilling"}  {r.rule:8s}  q {r.pct_null:5.1f}  '
          f'excess {r.avg_net:+.3%}')
'''),
    ]
    return CELLS
