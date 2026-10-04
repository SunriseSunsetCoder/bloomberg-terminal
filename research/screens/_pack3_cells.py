# Cell sources for screen pack 3 Step 0 (read-only data diagnostics for MES / MNQ 1-min files).
# Imported by _build_notebooks.py. Edit HERE, then rebuild.


def build(SETUP):
    S = SETUP.strip("\n")
    CELLS = [
        ("markdown", r'''
# Screen pack 3 — STEP 0: MES / MNQ 1-minute data diagnostics (READ-ONLY, no signals, no outcomes)

Answers the Step 0 questions before anything is built:
1. Are these real CSVs (not Google-Docs/Sheets conversions, HTML or zip)?
2. Columns, date range, row counts.
3. Timezone: CT vs ET vs UTC, and DST handling. Inferred from the daily CME halt (16:00-17:00 CT = 17:00-18:00 ET)
   and the 09:30 ET cash-open volume spike, month by month. A UTC clock shifts by 1 hour across DST; exchange-local
   clocks don't.
4. Bar timestamp convention: is the label the bar's OPEN or CLOSE? A label at 18:00 ET with nothing at 17:00 ET means
   open-labelled; 18:01 with a label at 17:00 means close-labelled. The cash-open volume spike sits at 09:30 (open) or
   09:31 (close).
5. Rolls: is there a contract column? Unadjusted continuous series jump at quarterly rolls, back-adjusted ones don't.
   The notebook reports the largest overnight gaps and whether they fall near CME roll dates (second Thursday of
   Mar/Jun/Sep/Dec, ±3 trading days).
6. Half-days: sessions whose last bar is at or before 13:30 ET.

**Lockbox:** rows at or after 2025-01-01 (ET) are counted but never printed or used. Raw lines are printed only if their
timestamp is before the cut.
'''),
        ("code", "# ===== Cell 0 — config =====\n" + S + r'''
import io, re, time
MDC = Path(os.environ.get('PACK3_MDC_DIR', '/content/drive/MyDrive/Market Data Collector'))
FILES = {'MES': MDC/'MES_1min_2000Days.csv', 'MNQ': MDC/'MNQ_1min_2000Days.csv'}
P3_DIR = OUT_DIR/'pack3'; P3_DIR.mkdir(parents=True, exist_ok=True)
CUT_ET = pd.Timestamp('2025-01-01', tz='America/New_York')     # LOCKBOX: >= this is sealed
ET = 'America/New_York'
'''),
        ("code", r'''
# ===== Cell 1 — loaders + inference helpers =====
def sniff(path):
    head = open(path, 'rb').read(4096)
    kind = ('zip/xlsx (PK)' if head[:2] == b'PK' else 'HTML' if head.lstrip()[:1] == b'<' else
            'gzip' if head[:2] == b'\x1f\x8b' else 'text')
    first = head.decode('utf-8', 'replace').splitlines()
    return kind, first[0] if first else ''


def parse_time(df):
    """Find the timestamp: one datetime column, Date + Time columns, or epoch seconds/ms."""
    low = {c.lower().strip(): c for c in df.columns}
    for k in ['datetime', 'timestamp', 'time', 'date_time', 'ts', 'date']:
        if k in low and not (k == 'date' and 'time' in low):
            s = df[low[k]]
            if pd.api.types.is_numeric_dtype(s):
                unit = 'ms' if s.dropna().iloc[0] > 1e11 else 's'
                return pd.to_datetime(s, unit=unit, utc=True), f'epoch-{unit} in "{low[k]}" (UTC)'
            try:
                t = pd.to_datetime(s, errors='coerce', utc=False)
                if t.isna().mean() > 0.01: raise ValueError('unparsed')
            except (ValueError, TypeError):                  # mixed offsets (EST/EDT) -> parse as UTC-aware
                t = pd.to_datetime(s, errors='coerce', utc=True)
            return t, f'column "{low[k]}"'
    if 'date' in low and 'time' in low:
        return pd.to_datetime(df[low['date']].astype(str) + ' ' + df[low['time']].astype(str), errors='coerce'), \
            f'columns "{low["date"]}" + "{low["time"]}"'
    raise ValueError(f'no timestamp column found in {list(df.columns)}')


def minute_of_day(idx):
    return idx.hour * 60 + idx.minute


def halt_window(mod_counts):
    """Start minute of the 60-minute window with the fewest bars (the daily halt)."""
    c = np.zeros(1440); c[mod_counts.index.to_numpy()] = mod_counts.to_numpy()
    w = np.array([np.roll(c, -s)[:60].sum() for s in range(1440)])
    return int(w.argmin()), float(w.min() / max(c.sum(), 1))


def roll_dates(years):
    out = []
    for y in years:
        for m in (3, 6, 9, 12):
            d = pd.Timestamp(y, m, 1); thu = [d + pd.Timedelta(days=i) for i in range(31)
                                              if (d + pd.Timedelta(days=i)).month == m and (d + pd.Timedelta(days=i)).weekday() == 3]
            out.append(thu[1])                              # second Thursday
    return pd.DatetimeIndex(out)


hhmm = lambda m: f'{int(m) // 60:02d}:{int(m) % 60:02d}'
'''),
        ("code", r'''
# ===== Cell 2 — Step 0 report per instrument =====
REPORT = {}
for inst, path in FILES.items():
    print('=' * 100, f'\n{inst}: {path}')
    if not path.exists():
        print('  MISSING'); continue
    size = path.stat().st_size; kind, header = sniff(path)
    print(f'  size {size/1e6:.1f} MB | content sniff: {kind} | header: {header[:200]}')
    t0 = time.time()
    df = pd.read_csv(path, low_memory=False)
    ts, how = parse_time(df)
    df = df.assign(_ts=ts).dropna(subset=['_ts'])
    print(f'  rows {len(df):,} | timestamp from {how} | tz-aware in file: {ts.dt.tz is not None} | '
          f'columns {list(df.columns[:-1])}  [{time.time()-t0:.0f}s]')
    low = {c.lower().strip(): c for c in df.columns}
    cmap = {k: low.get(k) for k in ['open', 'high', 'low', 'close', 'volume']}
    sym_col = next((low[k] for k in ['symbol', 'contract', 'ticker', 'instrument', 'root', 'expiry'] if k in low), None)
    order = 'ascending' if df['_ts'].is_monotonic_increasing else ('descending' if df['_ts'].is_monotonic_decreasing else 'unsorted')
    df = df.sort_values('_ts')

    # --- timezone inference on the RAW clock (before any conversion), month by month, pre-cut rows only
    raw = df['_ts']
    raw_naive = raw.dt.tz_convert(None) if raw.dt.tz is not None else raw
    pre_raw = raw_naive < pd.Timestamp('2024-12-31')               # conservative pre-cut for diagnostics
    R = df[pre_raw.to_numpy()]; rn = raw_naive[pre_raw]
    mo = rn.dt.to_period('M')
    halts = {}
    ndates = rn.dt.normalize().groupby(mo.to_numpy()).nunique()
    for m_, g in pd.Series(minute_of_day(pd.DatetimeIndex(rn)), index=rn.index).groupby(mo.to_numpy()):
        if ndates.get(m_, 0) >= 15:                           # partial months have several empty hours
            halts[str(m_)] = halt_window(g.value_counts())[0]
    hs = pd.Series(halts)
    print(f'  raw-clock daily halt start by month (minute of day): {hs.map(hhmm).value_counts().to_dict()}')
    shifts_with_dst = hs.nunique() > 1
    hmode = hs.mode().iloc[0]
    if raw.dt.tz is not None:
        tz_guess = 'tz-aware (converted from file offsets)'
    elif not shifts_with_dst and hmode in (16 * 60, 16 * 60 + 1): tz_guess = 'America/Chicago (CT, local)'
    elif not shifts_with_dst and hmode in (17 * 60, 17 * 60 + 1): tz_guess = 'America/New_York (ET, local)'
    elif shifts_with_dst and set(hs.unique()) <= {21 * 60, 21 * 60 + 1, 22 * 60, 22 * 60 + 1}: tz_guess = 'UTC'
    else: tz_guess = f'UNRESOLVED (halt starts {sorted(set(hs.map(hhmm)))})'
    print(f'  timezone inference: {tz_guess}  (halt shifts across months: {shifts_with_dst})')
    tz_src = {'America/Chicago (CT, local)': 'America/Chicago', 'America/New_York (ET, local)': ET, 'UTC': 'UTC'}.get(tz_guess)
    if raw.dt.tz is not None:
        et = raw.dt.tz_convert(ET)
    elif tz_src:
        et = raw.dt.tz_localize(tz_src, ambiguous='NaT', nonexistent='NaT').dt.tz_convert(ET)
    else:
        print('  -> cannot convert to ET without a resolved timezone; stopping this instrument'); continue
    df['_et'] = et.to_numpy(); df = df.dropna(subset=['_et'])
    n_sealed = int((df['_et'] >= CUT_ET).sum())
    D = df[df['_et'] < CUT_ET].copy()                              # LOCKBOX applied
    D['_et'] = pd.DatetimeIndex(D['_et']).tz_convert(ET)
    eti = pd.DatetimeIndex(D['_et'])
    print(f'  ET range (pre-cut): {eti[0]} .. {eti[-1]} | rows pre-cut {len(D):,} | rows >= 2025-01-01 ET: {n_sealed:,} '
          f'(sealed, not shown) | file order: {order}')

    # --- bar timestamp convention
    mod = pd.Series(minute_of_day(eti)).value_counts()
    c1700, c1800, c1801 = int(mod.get(17 * 60, 0)), int(mod.get(18 * 60, 0)), int(mod.get(18 * 60 + 1, 0))
    vcol = cmap['volume']
    if vcol:
        vol_by_min = pd.Series(D[vcol].to_numpy(float), index=minute_of_day(eti)).groupby(level=0).median()
        rth = vol_by_min.loc[9 * 60 + 15: 9 * 60 + 45]; spike = int(rth.idxmax())
    else:
        spike = None
    conv = ('OPEN-labelled' if c1800 > 0 and c1700 == 0 else 'CLOSE-labelled' if c1700 > 0 and c1800 == 0 else 'AMBIGUOUS')
    print(f'  bars at 17:00 ET: {c1700:,} | 18:00 ET: {c1800:,} | 18:01 ET: {c1801:,} -> {conv}; '
          f'cash-open volume spike at {hhmm(spike) if spike is not None else "n/a"} ET '
          f'({"open-labelled" if spike == 570 else "close-labelled" if spike == 571 else "?"})')

    # --- sessions (ET trading date = date of the 16:00 close; session starts 18:00 ET the previous day)
    sess = (eti + pd.Timedelta(hours=6)).normalize().tz_localize(None)          # 18:00 ET -> next calendar date
    D['_sess'] = sess
    last_bar = D.groupby('_sess')['_et'].max().map(lambda x: x.hour * 60 + x.minute)
    bars_per = D.groupby('_sess').size()
    half = last_bar[(last_bar <= 13 * 60 + 30) & (last_bar >= 11 * 60)]
    print(f'  sessions {len(bars_per):,} | bars/session median {int(bars_per.median())} (p5 {int(bars_per.quantile(.05))}) | '
          f'early closes (last bar 11:00-13:30 ET): {len(half)}')
    print('    ' + ', '.join(f'{d.date()} ({hhmm(m)})' for d, m in half.items()))
    has_1530 = (D['_et'].dt.hour.eq(15) & D['_et'].dt.minute.eq(30)).groupby(D['_sess']).any().mean()
    has_1600 = (D['_et'].dt.hour.eq(16) & D['_et'].dt.minute.eq(0)).groupby(D['_sess']).any().mean()
    print(f'  share of sessions with a 15:30 ET bar {has_1530:.1%}, with a 16:00 ET bar {has_1600:.1%}')

    # --- rolls
    if sym_col:
        ch = D[sym_col].ne(D[sym_col].shift())
        print(f'  contract column "{sym_col}": {D[sym_col].nunique()} values; changes at: '
              + ', '.join(str(x.date()) for x in pd.DatetimeIndex(D.loc[ch, "_et"]).tz_localize(None)[1:30]))
    ccol, ocol = cmap['close'], cmap['open']
    if ccol and ocol:
        first = D.groupby('_sess').first(); lastb = D.groupby('_sess').last()
        gap = (first[ocol].to_numpy() / np.r_[np.nan, lastb[ccol].to_numpy()[:-1]] - 1)
        G = pd.Series(gap, index=first.index).dropna()
        rd = roll_dates(range(G.index.min().year, G.index.max().year + 1))
        near = np.asarray(G.index.map(lambda d: bool((abs((rd - d).days) <= 4).any())), bool)
        top = G.abs().sort_values(ascending=False).head(12)
        print('  largest session-open gaps (pre-cut):')
        for d, v in top.items():
            print(f'    {d.date()}  {G[d]:+.3%}  {"<- near roll (2nd Thu Mar/Jun/Sep/Dec +/-4d)" if near[G.index.get_loc(d)] else ""}')
        print(f'  mean session-open gap: near roll {G[near].mean():+.3%} (n={int(near.sum())}) vs other {G[~near].mean():+.3%} '
              f'| median |gap| near roll {G[near].abs().median():.3%} vs other {G[~near].abs().median():.3%}')
        lvl = pd.Series(D[ccol].to_numpy(float), index=eti).resample('YE').last()
        print('  year-end close level: ' + ', '.join(f'{d.year}: {v:,.2f}' for d, v in lvl.items()))
        print(f'  min price pre-cut {D[ccol].min():,.2f} (negative or tiny values suggest back-adjustment)')
    # first 3 raw lines, only if pre-cut
    ok3 = D.head(3)
    print('  first 3 rows (pre-cut):'); print(ok3.drop(columns=['_ts']).to_string(index=False))
    REPORT[inst] = dict(size_mb=round(size / 1e6, 1), sniff=kind, header=header[:300], rows=int(len(df)),
                        rows_pre_cut=int(len(D)), rows_sealed=n_sealed, order=order, timestamp=how, tz_guess=tz_guess,
                        halt_by_month=hs.map(hhmm).value_counts().to_dict(), convention=conv,
                        cash_open_spike=hhmm(spike) if spike is not None else None, sessions=int(len(bars_per)),
                        first_et=str(eti[0]), last_pre_cut_et=str(eti[-1]), early_closes=[str(d.date()) for d in half.index],
                        contract_col=sym_col, share_1530=float(has_1530), share_1600=float(has_1600))
    del df, D
json.dump(REPORT, open(P3_DIR/'step0_report.json', 'w'), indent=1, default=str)
print(f'\nwrote {P3_DIR/"step0_report.json"}')
'''),
    ]
    return CELLS
