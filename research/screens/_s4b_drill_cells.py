# Cell sources for the S4b drill (frozen T3 rule; primary 60-ETF replication + secondary stock universe).
# Imported by _build_notebooks.py; reuses pack-2 and S4b config + core. Edit HERE, then rebuild.


def build(P2, S4B):
    DRILL_CONFIG = r'''

# ---- S4b DRILL (S4B_DRILL_PREREG.md R1-R5; frozen 2026-10-03) ----
DRILL_DIR = OUT_DIR/'s4b_drill'; DCACHE = DRILL_DIR/'cache'; DCACHE.mkdir(parents=True, exist_ok=True)
REP_DIR = REF_DIR/'replication'; REP_DIR.mkdir(parents=True, exist_ok=True)
UNIV_FILE, DRILL_PROTO = DRILL_DIR/'replication_universe.csv', DRILL_DIR/'drill_protocol.json'
UNIV_RULE_FILE, UNIV_RULE_VERSION = DRILL_DIR/'replication_universe_rule.json', 'v3'   # v2/v3: review fixes 2026-10-03
U1_ETFS = ['SPY', 'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY']
N_ETF, MAX_COUNTRY, CORR_MAX, RANK_YEAR, MIN_BARS_2013 = 60, 20, 0.95, 2013, 200
US_EXCH = {'NYSE', 'NYSE ARCA', 'NYSE MKT', 'AMEX', 'NASDAQ', 'BATS'}
DRILL_EXITS = [('X1', 0, 10), ('X2', 1, 10)]               # frozen T3 rule, R1
Q_DRILL, FALSE_PASS_MAX = 95.0, 0.10
DRILL_SEEDS = int(os.environ.get('DRILL_SEEDS', 16)); DRILL_POWER_SEEDS = int(os.environ.get('DRILL_POWER_SEEDS', 4))
DRILL_PLANT = 0.010
UNIVERSE_APPROVED = False or os.environ.get('DRILL_APPROVED') == '1'   # set True after reviewing the printed list
UNIVERSE_SHA = os.environ.get('DRILL_UNIVERSE_SHA', '')    # FROZEN sha256 of replication_universe.csv (R5 freeze commit)
LEV_RE = re.compile(r'(\b-?[1-4](\.\d+)?x\b|ultra|\bbear\b|inverse|leveraged|\bvix\b|(?<!low )(?<!min )volatility'
                    r'|\bshort\b(?![- ](term|duration|maturity|treasury|bond)))', re.I)
NONEQ_RE = re.compile(r'(\bbond|treasury|\btreas\b|\bmuni|municipal|\btips\b|inflation[- ]protected|floating rate|'
                      r'senior loan|\bloan\b|preferred|mortgage|\bmbs\b|aggregate|high yield|corporate|\bcredit\b|'
                      r'fixed income|money market|t-bill|gold trust|gold shares|silver trust|physical|bullion|'
                      r'commodit|oil fund|gas fund|invesco db|powershares db|currencyshares|dollar index|futures|'
                      r'covered call|buy-?write|allocation|target date|managed futures|convertible|maturity|'
                      r'duration|ultra[- ]?short|short[- ]term)', re.I)
ETN_RE = re.compile(r'(\betns?\b|exchange[- ]traded notes?|\bnotes? due\b|ipath|etracs|\belements\b|velocityshares)', re.I)
FUND_RE = re.compile(r'(\betf\b|\bfund\b|\btrust\b|\bindex\b|portfolio|\bshares\b|ishares|spdr|vanguard|powershares|'
                     r'invesco|vaneck|market vectors|wisdomtree|first trust|global x|schwab|guggenheim|\balps\b|'
                     r'xtrackers|x-trackers|proshares|direxion|pimco|select sector)', re.I)
COUNTRY_RE = re.compile(r'(msci (?!usa)|emerging|europe|euro\b|eurozone|asia|pacific|eafe|international|\bintl\b|'
                        r'world ex|ex-us|ex us|ex-u\.s|global|china|japan|india|brazil|mexico|canada|germany|'
                        r'united kingdom|\bu\.k\.|australia|korea|taiwan|hong kong|singapore|south africa|russia|'
                        r'latin america|\bbric|frontier|developed markets|foreign|acwi|chile|turkey|indonesia|'
                        r'thailand|malaysia|philippines|vietnam|israel|italy|spain|france|switzerland|sweden|'
                        r'netherlands|belgium|austria|nordic|middle east|africa|peru|colombia|poland|greece|'
                        r'ireland|argentina|norway|qatar|saudi|'
                        # v3: country-index names (NKY "Nikkei 225" was labelled US)
                        r'nikkei|topix|stoxx|\bdax\b|hang seng|kospi|sensex|nifty|bovespa|\bibex\b|\bcac 40\b|\basx\b|'
                        r'\btsx\b|kokusai|\bworld\b|all[- ]world)', re.I)
'''

    DRILL_CORE = r'''


# ---------------------------------------------------------------- S4b drill
def drill_baseline(ctx, base_mask, max_len=10):
    """Mean return of every baseline window (signal day in IS, base_mask true; entry next open), by length L and exit
    price type (0 open, 1 close). Shape (N, max_len+1, 2). Vectorised over L."""
    O, C = ctx['O'], ctx['C']; T, N = C.shape; Ls = np.arange(max_len + 1)
    out = np.full((N, max_len + 1, 2), np.nan)
    for k in range(N):
        s = np.nonzero(base_mask[T_LO:T_HI + 1, k])[0] + T_LO
        if not len(s): continue
        e = s + 1; X = e[:, None] + Ls[None, :]; ok = X < T; Xc = np.where(ok, X, 0)
        o_e = O[e, k][:, None]
        for xt, PX in ((0, O), (1, C)):
            r = np.where(ok, PX[Xc, k] / o_e - 1, np.nan)
            with np.errstate(all='ignore'):
                out[k, :, xt] = np.nanmean(r, axis=0)
    return out


def drill_trial(ctx, exit_, elig=None, seed=0, names=None):
    """Frozen T3 rule (R1): uptrend + T3 [+ eligibility], next-open entry, X1/X2 exits with 10-bar time stop,
    non-overlapping; excess = gross - same-ticker baseline (same length + exit price type) - COST."""
    name, mode, hold = exit_
    el = np.ones_like(ctx['trend']) if elig is None else elig
    T3 = ctx['TRIG']['T3']; sig = ctx['trend'] & T3 & el; base = ctx['trend'] & ~T3 & el
    nt = ctx['NT']
    k, t, x, r, xt = run_rule(np.ascontiguousarray(sig.T), nt['O'], nt['H'], nt['L'], nt['C'], nt['S5'], nt['RSI'],
                              mode, hold, False, 0.0, T_LO, T_HI)
    BT = drill_baseline(ctx, base)
    g = r - BT[k, x - (t + 1), xt]; ok = np.isfinite(g)
    k, t, x, r, g = k[ok], t[ok], x[ok], r[ok], g[ok]; exc = g - COST
    ent = CAL[t + 1]; yr = ent.year.to_numpy(); mo = np.asarray(ent.to_period('M').astype(str))
    out = dict(exit=name, n=len(exc), k=k, t=t, x=x, gross=r, gexc=g, exc=exc, year=yr, month=mo)
    if len(exc) < 20:
        out.update(ok=False); return out
    lo, hi, q = year_ci(exc, mo, BOOT_REPS, seed, CI_LEVEL)
    glo, ghi, gq = year_ci(g, mo, BOOT_REPS, seed, CI_LEVEL)
    a, b = ERAS[RECENT]; era = (yr >= a) & (yr <= b)
    out.update(ok=True, mean=float(exc.mean()), lo=lo, hi=hi, q=q, era=float(exc[era].mean()) if era.any() else np.nan,
               gmean=float(g.mean()), glo=glo, ghi=ghi, gq=gq, gera=float(g[era].mean()) if era.any() else np.nan,
               avg_gross=float(r.mean()), avg_bars=float((x - t).mean()), breakeven=float(g.mean()))
    return out


def r2_pass(res, gross=False):
    """R2: BOTH exits q >= 95 AND CI90 lower bound > 0, AND 2019-2023 mean > 0 (net; gross for the martingale check)."""
    q_, lo_, era_ = ('gq', 'glo', 'gera') if gross else ('q', 'lo', 'era')
    return bool(all(o.get('ok') and o[q_] >= Q_DRILL and o[lo_] > 0 and np.isfinite(o[era_]) and o[era_] > 0
                    for o in res.values()))


def make_world_for(Creal, seed, plant=False):
    """Pack-2 generator on any panel: real listing spans + gaps, market drift, intrabar paths, martingale idio."""
    T_, N_ = Creal.shape; valid = np.isfinite(Creal)
    first = np.where(valid.any(0), valid.argmax(0), -1).astype(np.int64)
    last = np.where(valid.any(0), T_ - 1 - valid[::-1].argmax(0), -1).astype(np.int64)
    p0 = np.array([Creal[first[i], i] if first[i] >= 0 else 1.0 for i in range(N_)])
    with np.errstate(all='ignore'):
        sd_ = np.nanstd(np.diff(np.log(Creal), axis=0), axis=0)
    sd_ = np.where(np.isfinite(sd_), np.clip(sd_, 0.005, 0.10), 0.02)
    sdi = np.sqrt(np.maximum(sd_ ** 2 - MKT_SD ** 2, (0.25 * sd_) ** 2))
    rng = np.random.default_rng(30_000 + seed)
    mkt = np.empty((T_, M_STEPS + 1))
    mkt[:, 0] = rng.normal(MKT_MU * ON_FRAC - 0.5 * MKT_SD ** 2 * ON_FRAC, MKT_SD * np.sqrt(ON_FRAC), T_)
    s_in = MKT_SD * np.sqrt((1 - ON_FRAC) / M_STEPS)
    mkt[:, 1:] = rng.normal(MKT_MU * (1 - ON_FRAC) / M_STEPS - 0.5 * s_in ** 2, s_in, (T_, M_STEPS))
    O, Hh, Ll, Cc = gen_world(seed, mkt, sdi, first, last, p0, M_STEPS, ON_FRAC, DRILL_PLANT if plant else 0.0,
                              2 * sd_, 0.0, np.zeros((N_, T_), bool))
    W = {c: np.ascontiguousarray(z.T) for c, z in zip('OHLC', (O, Hh, Ll, Cc))}
    for c in 'OHLC': W[c][~valid] = np.nan
    return W


def tiingo_get(url):
    for i in range(4):
        try:
            return json.load(urllib.request.urlopen(url, timeout=60))
        except Exception as e:
            if i == 3: raise
            time.sleep(2 + 3 * i)
'''

    CELLS = [
        ("markdown", r'''
# S4b DRILL — frozen T3 rule: replication on 60 new ETFs (PRIMARY) + the stock universe (SECONDARY)

Pre-registration: `research/screens/S4B_DRILL_PREREG.md`. R1 is the rule, R2 the pass, R3 reporting, R4 validation
and lockbox, R5 the universes and the reading. Nothing here is tuned. Lockbox: everything is cut at load at
2024-12-31, Tiingo pulls use endDate 2024-12-31, and IS entries run 2011-01-03 .. 2023-12-29. The 2025-26 data on the
original 12 ETFs stays sealed (R4).

**Flow (run in this order; each step stops until the previous one is done):**
1. **Step 0** builds the PRIMARY universe by rule (R5a, rule v2) and prints it.
   - You review it and set `UNIVERSE_APPROVED = True`.
   - Paste the printed sha256 back; it's frozen in git (R5 freeze commit) and set as `UNIVERSE_SHA`.
   - Until then, nothing downstream runs.
2. **Part A** validates the null on the martingale world for BOTH universes (R5d): 16 seeds each, plus power. Each
   universe is gated on its own result.
3. **Part B** applies the frozen rule to real data, for the universes whose validation passed. It covers R2, the
   R3 tables, the R5c reading and the trial log.

**SECONDARY is SURVIVORSHIP-BIASED IN FAVOUR OF DIP-BUYING:** the corpus keeps survivors, whose dips recovered by
construction. A pass on stocks alone reads as "likely survivorship".
'''),
        ("code", "# ===== Cell 0 — config (pack-2 + S4b + drill) =====\n" + P2['CONFIG'] + S4B['CONFIG'] + DRILL_CONFIG),
        ("code", "# ===== Cell 1 — core (pack-2 + S4b + drill) =====\n" + P2['CORE'] + S4B['CORE'] + DRILL_CORE),
        ("code", r'''
# ===== Cell 2 — corpus panels (cut at load; pack-2 cache), SPY regime =====
t0 = time.time()
TICKERS, CAL, P = load_panels(); calendar_consts(CAL)
assert CAL.max() <= CUT_DATE
i_spy = TICKERS.index('SPY'); spyC = P['C'][:, i_spy]
spy_s200 = roll(spyC[:, None], 200)[:, 0]
SPY_BELOW = spyC < spy_s200                                   # signal-day regime (R3)
yb = pd.Series(SPY_BELOW[np.isfinite(spy_s200)], index=CAL[np.isfinite(spy_s200)]).groupby(lambda d: d.year).mean()
WEAK_YEARS = sorted(int(y) for y, v in yb.items() if v >= 0.25 and Y0 <= y < Y0 + NY)
print(f'corpus {len(TICKERS)} x {len(CAL)} [{time.time()-t0:.0f}s] | SPY-weak years (>= 25% of days below SMA200): {WEAK_YEARS}')
'''),
        ("markdown", "## Step 0 — PRIMARY universe by rule (R5a)"),
        ("code", r'''
# ===== Cell 3 — build the 60-ETF universe (cached pulls; rule only, no outcomes) =====
token = tiingo_token(); assert token, 'TIINGO_API_KEY needed'
rule_now = json.load(open(UNIV_RULE_FILE)).get('rule_version') if UNIV_RULE_FILE.exists() else ('v1' if UNIV_FILE.exists() else None)
if UNIV_FILE.exists() and rule_now != UNIV_RULE_VERSION:      # superseded list (never approved/frozen): keep for the record
    UNIV_FILE.rename(UNIV_FILE.with_name(f'replication_universe_{rule_now}_superseded.csv'))
    print(f'rule changed {rule_now} -> {UNIV_RULE_VERSION}: rebuilding (superseded list kept)')
if not UNIV_FILE.exists():
    st_f = DCACHE/'supported_tickers.csv'
    if not st_f.exists():
        raw = urllib.request.urlopen('https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip', timeout=180).read()
        zf = zipfile.ZipFile(io.BytesIO(raw)); pd.read_csv(zf.open(zf.namelist()[0])).to_csv(st_f, index=False)
    st = pd.read_csv(st_f)
    st['ticker'] = st['ticker'].astype(str).str.upper()
    n_rows = st.groupby('ticker').size()                      # > 1 row = reused ticker / mixed histories
    sd_, ed_ = pd.to_datetime(st['startDate'], errors='coerce'), pd.to_datetime(st['endDate'], errors='coerce')
    pool = st[(st.assetType == 'ETF') & st.exchange.isin(US_EXCH) & (st.priceCurrency == 'USD')
              & (sd_ <= '2013-12-31') & (ed_ >= '2013-12-31') & ~st.ticker.isin(U1_ETFS)
              & st.ticker.str.fullmatch(r'[A-Z]+')].drop_duplicates('ticker')
    print(f'pool: {len(pool)} ETFs (US-listed, USD, trading by 2014-01-01, excl. U1)')
    # 2013 bars per candidate (cached): raw close x raw volume for $vol; adjClose for returns
    c13 = DCACHE/'bars_2013.parquet'
    have = pd.read_parquet(c13) if c13.exists() else pd.DataFrame(columns=['ticker', 'date', 'close', 'volume', 'adjClose'])
    todo = sorted(set(pool.ticker) - set(have.ticker)); rows = []; t0 = time.time()
    for i, tk in enumerate(todo):
        try:
            js = tiingo_get(f'https://api.tiingo.com/tiingo/daily/{tk}/prices?startDate=2012-12-01&endDate=2013-12-31&token={token}')
            rows += [dict(ticker=tk, date=j['date'][:10], close=j['close'], volume=j['volume'], adjClose=j['adjClose']) for j in js]
        except Exception as e:
            rows.append(dict(ticker=tk, date=None, close=np.nan, volume=np.nan, adjClose=np.nan))
        if (i + 1) % 200 == 0:
            have = pd.concat([have, pd.DataFrame(rows)]); have.to_parquet(c13); rows = []
            print(f'  2013 bars: {i+1}/{len(todo)} [{time.time()-t0:.0f}s]')
    have = pd.concat([have, pd.DataFrame(rows)]); have.to_parquet(c13)
    B13 = have.dropna(subset=['date']); B13['date'] = pd.to_datetime(B13['date'])
    B13 = B13[B13.date.dt.year == RANK_YEAR]
    agg = B13.assign(dv=B13.close * B13.volume).groupby('ticker').agg(n=('dv', 'size'), dvol=('dv', 'median'))
    ranked = agg[agg.n >= MIN_BARS_2013].sort_values('dvol', ascending=False)
    # U1 2013 returns (corpus, adjusted) for the near-duplicate screen
    u1r = pd.DataFrame({e: pd.Series(P['C'][:, TICKERS.index(e)], index=CAL) for e in U1_ETFS if e in TICKERS}).pct_change()
    u1r = u1r[u1r.index.year == RANK_YEAR]
    meta_f = DCACHE/'meta.json'; META = json.load(open(meta_f)) if meta_f.exists() else {}
    keep, excl, n_country = [], [], 0
    for tk, row in ranked.iterrows():
        if len(keep) >= N_ETF: break
        if tk not in META:
            try:
                m_ = tiingo_get(f'https://api.tiingo.com/tiingo/daily/{tk}?token={token}')
                META[tk] = dict(name=m_.get('name') or '', startDate=m_.get('startDate'), endDate=m_.get('endDate'))
            except Exception:
                META[tk] = dict(name='', startDate=None, endDate=None)
            json.dump(META, open(meta_f, 'w'))
        nm = META[tk]['name']; sd_m = pd.to_datetime(META[tk]['startDate'], errors='coerce')
        if n_rows.get(tk, 0) > 1: excl.append((tk, nm, 'ticker reuse: multiple Tiingo rows')); continue
        if not FUND_RE.search(nm): excl.append((tk, nm, 'not a fund (current name has no fund marker)')); continue
        if not (pd.notna(sd_m) and sd_m <= pd.Timestamp('2013-01-02')):
            excl.append((tk, nm, f'current fund starts {META[tk]["startDate"]} (2013 history not this fund)')); continue
        if ETN_RE.search(nm): excl.append((tk, nm, 'ETN (debt note)')); continue
        if LEV_RE.search(nm): excl.append((tk, nm, 'leveraged/inverse/vol')); continue
        if NONEQ_RE.search(nm): excl.append((tk, nm, 'non-equity')); continue
        r = B13[B13.ticker == tk].set_index('date')['adjClose'].sort_index().pct_change()
        cm = u1r.apply(lambda col: r.corr(col)).max()
        if np.isfinite(cm) and cm > CORR_MAX: excl.append((tk, nm, f'U1 near-duplicate (corr {cm:.3f})')); continue
        is_c = bool(COUNTRY_RE.search(nm))
        if is_c and n_country >= MAX_COUNTRY: excl.append((tk, nm, 'country/region cap')); continue
        n_country += is_c
        keep.append(dict(rank=len(keep) + 1, ticker=tk, name=nm, underlying='non-US' if is_c else 'US',
                         dvol_2013=row.dvol, max_corr_u1=round(float(cm), 3) if np.isfinite(cm) else np.nan))
    U = pd.DataFrame(keep); U.to_csv(UNIV_FILE, index=False)
    json.dump(dict(rule_version=UNIV_RULE_VERSION, built_utc=pd.Timestamp.now(tz='UTC').isoformat()), open(UNIV_RULE_FILE, 'w'))
    pd.DataFrame(excl, columns=['ticker', 'name', 'reason']).to_csv(DRILL_DIR/'replication_excluded.csv', index=False)
U = pd.read_csv(UNIV_FILE); EX = pd.read_csv(DRILL_DIR/'replication_excluded.csv')
pd.set_option('display.max_rows', 300); pd.set_option('display.width', 220)
print(U.assign(dvol_2013=(U.dvol_2013 / 1e6).round(1)).to_string(index=False))
print(f'\n{len(U)} ETFs | non-US underlying {int((U.underlying == "non-US").sum())} (cap {MAX_COUNTRY}) | '
      f'excluded while filling: {EX.reason.str.split(":| \\(").str[0].value_counts().to_dict()}')
print(EX.to_string(index=False))
UNIV_SHA_NOW = sha(UNIV_FILE); print(f'\nreplication_universe.csv sha256 = {UNIV_SHA_NOW}')
assert UNIVERSE_APPROVED, 'Review the list, set UNIVERSE_APPROVED = True, and paste the sha256 back for the freeze commit.'
assert UNIVERSE_SHA and UNIVERSE_SHA == UNIV_SHA_NOW, 'UNIVERSE_SHA must be the frozen value from the R5 freeze commit.'
'''),
        ("code", r'''
# ===== Cell 4 — full adjusted histories for the 60 (endDate = cut) -> ETF panel; stock-universe inputs =====
for tk in U.ticker:
    f_ = REP_DIR/f'{tk}.csv'
    if f_.exists(): continue
    js = pd.DataFrame(tiingo_get(f'https://api.tiingo.com/tiingo/daily/{tk}/prices?startDate=2009-06-01'
                                 f'&endDate={CUT_DATE:%Y-%m-%d}&token={token}'))
    pd.DataFrame({'Date': pd.to_datetime(js['date']).dt.strftime('%Y-%m-%d'), 'Open': js['adjOpen'], 'High': js['adjHigh'],
                  'Low': js['adjLow'], 'Close': js['adjClose'], 'Volume': js['adjVolume']}).to_csv(f_, index=False)
ETF = {c: np.full((len(CAL), len(U)), np.nan) for c in 'OHLCV'}
for j, tk in enumerate(U.ticker):
    d = load_px(REP_DIR/f'{tk}.csv'); pos = CAL.get_indexer(d['Date']); ok = pos >= 0
    for c, col in zip('OHLCV', ['Open', 'High', 'Low', 'Close', 'Volume']):
        ETF[c][pos[ok], j] = d[col].to_numpy(float)[ok]
bad = ~(ETF['C'] > 0)
for c in 'OHLC': ETF[c][bad] = np.nan
assert np.isfinite(ETF['C']).any(0).all(), 'an ETF has no bars <= cut'
IS_STOCK, IS_U1 = asset_masks(TICKERS)
print(f'ETF panel {ETF["C"].shape} | stock-universe pool {int(IS_STOCK.sum())} (U2 = top {TOP_U2} by trailing 60-bar $vol)')


def stock_ctx(O, H, L, C, V):
    ctx = etf_ctx(O, H, L, C, V)
    ctx['U2'] = universes(lag(roll(C * V, 60), 1), IS_STOCK, IS_U1)['U2']
    return ctx
'''),
        ("markdown", "## Part A — validate the null on the martingale world, BOTH universes (R5d)"),
        ("code", r'''
# ===== Cell 5 — 16 seeds x 2 universes + power =====
def run_universe(univ, seed, plant=False):
    if univ == 'ETF60':
        W = make_world_for(ETF['C'], seed, plant); ctx = etf_ctx(W['O'], W['H'], W['L'], W['C'], ETF['V']); el = None
    else:
        W = make_world_for(P['C'], seed, plant); ctx = stock_ctx(W['O'], W['H'], W['L'], W['C'], P['V']); el = ctx['U2']
    return {ex[0]: drill_trial(ctx, ex, el, seed) for ex in DRILL_EXITS}


VAL = {}
for univ in ['ETF60', 'STK300']:
    rec = []; t0 = time.time()
    for s in range(DRILL_SEEDS):
        res = run_universe(univ, s)
        for ex, o in res.items():
            rec.append(dict(seed=s, exit=ex, n=o['n'], gmean=o.get('gmean'), gq=o.get('gq')))
        rec[-1]['r2_gross'] = rec[-2]['r2_gross'] = r2_pass(res, gross=True)
    R_ = pd.DataFrame(rec); R_.to_csv(DRILL_DIR/f'protocol_{univ}.csv', index=False)
    rows = {}
    for ex, g in R_.groupby('exit'):
        ps = g.set_index('seed')
        rows[ex] = dict(n_med=int(g.n.median()), mean_gexc=ps.gmean.mean(),
                        t_exc=float(stats.ttest_1samp(ps.gmean, 0.0).statistic),
                        mean_q=ps.gq.mean(), t_q=float(stats.ttest_1samp(ps.gq, 50.0).statistic))
    F = pd.DataFrame(rows).T
    false_pass = float(R_.groupby('seed').r2_gross.first().mean())
    centring = bool((F.t_exc.abs() < 2.5).all() and F.mean_q.between(40, 60).all() and (F.t_q.abs() < 2.5).all())
    null_ok = bool(centring and false_pass <= FALSE_PASS_MAX)
    print(f'\n[{univ}] {DRILL_SEEDS} seeds [{time.time()-t0:.0f}s]'); print(F.round(4).to_string())
    print(f'  gross R2 false-pass rate {false_pass:.1%} (<= {FALSE_PASS_MAX:.0%}) | centring {"PASS" if centring else "FAIL"}')
    det = []
    if null_ok:
        for s in range(DRILL_POWER_SEEDS):
            res = run_universe(univ, 1000 + s, plant=True)
            det.append(bool(all(o.get('ok') and o['gq'] >= Q_DRILL for o in res.values())))
            print(f'  power seed {1000+s}: ' + ' '.join(f'{ex} q={o.get("gq", np.nan):.1f}' for ex, o in res.items()))
    power_ok = bool(null_ok and sum(det) >= math.ceil(0.75 * DRILL_POWER_SEEDS))
    VAL[univ] = dict(families=json.loads(F.to_json(orient='index')), false_pass=false_pass, centring=centring,
                     null_ok=null_ok, power_det=det, power_ok=power_ok, ok=bool(null_ok and power_ok))
    print(f'  [{univ}] null {"PASS" if null_ok else "FAIL"} | power {"PASS" if power_ok else ("FAIL" if null_ok else "not run")}'
          f' -> real data {"ALLOWED" if VAL[univ]["ok"] else "STOPPED"}')
json.dump(dict(written_utc=pd.Timestamp.now(tz='UTC').isoformat(), n_seeds=DRILL_SEEDS, universe_sha=UNIV_SHA_NOW, **VAL),
          open(DRILL_PROTO, 'w'), indent=1, default=float)
print('\nSUMMARY drill validation:', {u: ('PASS' if v['ok'] else 'FAIL') for u, v in VAL.items()})
'''),
        ("markdown", "## Part B — frozen rule on real data (gated per universe)"),
        ("code", r'''
# ===== Cell 6 — real data =====
PRO = json.load(open(DRILL_PROTO))
assert PRO['universe_sha'] == UNIVERSE_SHA == sha(UNIV_FILE), 'universe changed since validation'
assert PRO['n_seeds'] >= 16 or os.environ.get('PACK2_TEST') == '1'
pct = lambda v: f'{v:+.2%}' if v is not None and np.isfinite(v) else 'nan'
REAL = {}
for univ in ['ETF60', 'STK300']:
    if not PRO[univ]['ok']:
        print(f'[{univ}] STOPPED by its validation — not evaluated'); continue
    if univ == 'ETF60':
        ctx = etf_ctx(ETF['O'], ETF['H'], ETF['L'], ETF['C'], ETF['V']); el, labels = None, np.array(U.ticker)
    else:
        ctx = stock_ctx(P['O'], P['H'], P['L'], P['C'], P['V']); el, labels = ctx['U2'], np.array(TICKERS)
    res = {ex[0]: drill_trial(ctx, ex, el, 41) for ex in DRILL_EXITS}
    REAL[univ] = (res, labels)
    tag = '  [SURVIVORSHIP-BIASED IN FAVOUR OF DIP-BUYING]' if univ == 'STK300' else '  [PRIMARY]'
    print(f'\n===== {univ}{tag}')
    for ex, o in res.items():
        print(f'  T3 {ex}: n={o["n"]} | avg bars {o.get("avg_bars", np.nan):.1f} | avg gross {pct(o.get("avg_gross"))} | '
              f'excess net {pct(o.get("mean"))} CI90 [{pct(o.get("lo"))}, {pct(o.get("hi"))}] q {o.get("q", np.nan):.1f} | '
              f'era 2019-23 {pct(o.get("era"))} | break-even {pct(o.get("breakeven"))}')
    print(f'  R2 ({univ}): {"PASS" if r2_pass(res) else "FAIL"}')
    py = pd.concat({ex: pd.Series(o['exc']).groupby(o['year']).agg(['size', 'mean']) for ex, o in res.items()}, axis=1)
    print('  per year (n, mean excess):'); print(py.round(4).to_string())
    pe = pd.concat({ex: pd.Series(o['exc']).groupby(labels[o['k']]).agg(['size', 'mean']) for ex, o in res.items()}, axis=1)
    if univ == 'ETF60':
        print('  per ETF (n, mean excess):'); print(pe.round(4).to_string())
    else:
        print('  per stock — distribution across stocks (n, mean excess):'); print(pe.describe().round(4).to_string())
    py.to_csv(DRILL_DIR/f'real_{univ}_per_year.csv'); pe.to_csv(DRILL_DIR/f'real_{univ}_per_ticker.csv')
    for ex, o in res.items():
        below = SPY_BELOW[o['t']]; weak = np.isin(o['year'], WEAK_YEARS)
        line = (f'  regime {ex}: SPY>200d n={int((~below).sum())} {pct(o["exc"][~below].mean() if (~below).any() else np.nan)} | '
                f'SPY<200d n={int(below.sum())} {pct(o["exc"][below].mean() if below.any() else np.nan)} | '
                f'SPY-weak years n={int(weak.sum())} {pct(o["exc"][weak].mean() if weak.any() else np.nan)}')
        if univ == 'ETF60':
            us = (U.underlying.to_numpy()[o['k']] == 'US')
            line += (f' | US n={int(us.sum())} {pct(o["exc"][us].mean() if us.any() else np.nan)} | '
                     f'non-US n={int((~us).sum())} {pct(o["exc"][~us].mean() if (~us).any() else np.nan)}')
        print(line + '   (descriptive, outside the pass)')
'''),
        ("code", r'''
# ===== Cell 7 — pre-registered reading (R5c) + trial log =====
prim = r2_pass(REAL['ETF60'][0]) if 'ETF60' in REAL else None
sec = r2_pass(REAL['STK300'][0]) if 'STK300' in REAL else None
if prim is None: reading = 'PRIMARY not evaluated (validation failed) -> no replication evidence'
elif prim: reading = 'PRIMARY PASS -> primary evidence: the T3 rule replicates (lockbox may be opened ONCE, R4)'
elif sec: reading = 'PRIMARY FAIL, SECONDARY PASS -> likely survivorship: does not replicate'
else: reading = 'PRIMARY FAIL' + (', SECONDARY FAIL' if sec is not None else '') + ' -> does not replicate'
print('READING (R5c):', reading)
now = pd.Timestamp.now(tz='UTC').isoformat(); rows, rets = [], []
for univ, (res, _) in REAL.items():
    for ex, o in res.items():
        cid = f's4bdrill|T3|{univ}|{ex}'; m = pd.Series(o['exc']).groupby(o['month']).mean() if o['n'] else pd.Series(dtype=float)
        rows.append(dict(kind='trial', config_id=cid, pack='s4bdrill', screen='S4b-T3', universe=univ, rule=f'T3_{ex}',
                         n=o['n'], n_months=len(m), WR=float((o['exc'] > 0).mean()) if o['n'] else np.nan, avg_net=o.get('mean'),
                         sd=m.std(), skew=m.skew(), kurt=m.kurt(), sr_monthly=m.mean() / m.std() if m.std() > 0 else np.nan,
                         pct_null=o.get('q'), verdict=r2_pass(res), backfilled=False,
                         note=('survivorship-biased (stocks)' if univ == 'STK300' else 'primary replication') + '; frozen T3 rule',
                         logged_at=now))
        rets += [dict(config_id=cid, month=mm, ret=v) for mm, v in m.items()]
if rows:
    LOG = pd.DataFrame(rows); RET = pd.DataFrame(rets); RET['key'] = RET.config_id + '|' + RET.month
    n_new, _ = append_log(TRIAL_LOG, LOG); append_log(TRIAL_RET, RET, key='key')
    print(f'trial log: +{n_new} new | cumulative trials {int((pd.read_csv(TRIAL_LOG).kind == "trial").sum())}')
'''),
    ]
    return CELLS
