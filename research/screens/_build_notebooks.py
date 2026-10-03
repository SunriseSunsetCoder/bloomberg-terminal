# Builds the two screen notebooks from the cell sources below:
#     python research/screens/_build_notebooks.py
# Edit cells HERE, then rebuild — the .ipynb files are generated.
import json
from pathlib import Path

HERE = Path(__file__).parent


def nb(cells):
    out = []
    for kind, src in cells:
        src = src.strip("\n")
        lines = [l + "\n" for l in src.split("\n")]
        lines[-1] = lines[-1].rstrip("\n")
        c = {"cell_type": kind, "metadata": {}, "source": lines}
        if kind == "code":
            c.update(execution_count=None, outputs=[])
        out.append(c)
    return {"cells": out, "nbformat": 4, "nbformat_minor": 5,
            "metadata": {"kernelspec": {"display_name": "Python 3", "name": "python3"},
                         "language_info": {"name": "python"}, "colab": {"provenance": []}}}


# ---------------------------------------------------------------- shared cells
SETUP = r'''
try:
    from google.colab import drive
    drive.mount('/content/drive')
except ImportError:
    pass                                            # local smoke test: BUKOWSKI_DIR points at fixtures
import pandas as pd, numpy as np, glob, json, os, math, urllib.request
from pathlib import Path
from scipy import stats
import warnings; warnings.filterwarnings('ignore')

DATA_DIR = Path(os.environ.get('BUKOWSKI_DIR', '/content/drive/MyDrive/Bukowski'))
REF_DIR  = DATA_DIR/'reference'
OUT_DIR  = DATA_DIR/'results'/'screens'; OUT_DIR.mkdir(parents=True, exist_ok=True)

# ---- LOCKBOX ----
CUT_DATE = pd.Timestamp('2024-12-31')     # every series cut at load; nothing after this is read, pulled or printed
'''

HELPERS = r'''
def load_px(path):
    """Read OHLC(+V) and CUT at CUT_DATE before anything else touches it."""
    cols = pd.read_csv(path, nrows=0).columns
    use = [c for c in ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'] if c in cols]
    d = pd.read_csv(path, usecols=use); d['Date'] = pd.to_datetime(d['Date'])
    d = d.sort_values('Date').drop_duplicates('Date')
    d = d[d['Date'] <= CUT_DATE].reset_index(drop=True)                  # LOCKBOX
    if 'Volume' not in d.columns: d['Volume'] = np.nan
    return d


def tiingo_token():
    token = os.environ.get('TIINGO_API_KEY')
    if not token:
        try:
            from google.colab import userdata; token = userdata.get('TIINGO_API_KEY')
        except Exception:
            token = None
    return token


def ref_path(tk):
    """RSP historically lives at DATA_DIR/RSP.csv or REF_DIR/RSP.csv; everything new goes to REF_DIR."""
    return DATA_DIR/f'{tk}.csv' if tk == 'RSP' and (DATA_DIR/'RSP.csv').exists() else REF_DIR/f'{tk}.csv'


def ensure_ref(tk):
    """One-off ADJUSTED Tiingo pull, only if missing. endDate = CUT_DATE so sealed rows never reach Drive."""
    path = ref_path(tk)
    if path.exists():
        print(f'{tk}: present at {path} — no pull'); return path
    token = tiingo_token()
    assert token, f'Set TIINGO_API_KEY (Colab secret or env) to pull {tk}.'
    url = (f'https://api.tiingo.com/tiingo/daily/{tk}/prices?startDate=2003-01-01'
           f'&endDate={CUT_DATE:%Y-%m-%d}&token={token}')
    js = pd.DataFrame(json.load(urllib.request.urlopen(url, timeout=60)))
    df = pd.DataFrame({'Date': pd.to_datetime(js['date']).dt.strftime('%Y-%m-%d'),
                       'Open': js['adjOpen'], 'High': js['adjHigh'], 'Low': js['adjLow'],
                       'Close': js['adjClose'], 'Volume': js['adjVolume']})
    df = df[pd.to_datetime(df['Date']) <= CUT_DATE]                     # belt and braces
    REF_DIR.mkdir(parents=True, exist_ok=True); df.to_csv(path, index=False)
    print(f'{tk}: pulled {len(df)} rows (adjusted) -> {path}')
    return path


def close_ret(d, cal=None):
    """Close-to-close simple return on the series' own rows (optionally restricted to a calendar first)."""
    s = d.set_index('Date')['Close'].astype(float)
    if cal is not None: s = s[s.index.isin(cal)]
    s = s.where(s > 0)
    return (s / s.shift(1) - 1).dropna()
'''

# ======================================================= Task A: survivorship
A_CELLS = [
    ("markdown", r'''
# Survivorship check (Task A) — READ-ONLY

How much survivorship tilt does the Bukowski corpus carry? Two reads, nothing selected, nothing logged as a trial.

- **A1** file end dates: how many tickers stop before 2024-01-01 (dead names kept) vs total, and live/born/died
  counts per year. Lockbox: series are cut at 2024-12-31 at load, so a "last date" is never later than the cut.
  Names whose (cut) last bar is the final bar of the sample are reported as a COUNT only.
- **A2** equal-weight, daily-rebalanced buy-and-hold of the full universe, 2011-01-03 .. 2023-12-29 (buy at the
  2010-12-31 close), vs RSP / IWM / IJR / SPY total return (all series split+dividend adjusted). Repeated for the
  bottom tercile of 2011 median dollar volume (fixed cohort). CAGR, max drawdown, per-calendar-year gap.

**Rules (pre-declared):** a ticker contributes its close-to-close return on day t iff it has valid closes on t and its
previous bar. Bad prints = daily return > +300% or < −95%: counted, listed, and ONLY that ticker-day return is
dropped (the ticker stays). Results are shown with and without bad prints; the clean series is primary.

**Caveats:** no delisting returns exist in the corpus, so a dying name's final collapse is missing — the gap is a
LOWER bound on the bias. Daily rebalancing harvests a rebalancing/small-cap premium that quarterly-rebalanced RSP
does not; part of any gap vs RSP is that, not survivorship. Tercile cohort uses full-2011 dollar volume (in-year
look-ahead; irrelevant for a survivorship read).
'''),
    ("code", "# ===== Cell 0 — config =====\n" + SETUP.strip("\n") + r'''

A_START, A_END = pd.Timestamp('2011-01-01'), pd.Timestamp('2023-12-31')
EARLY_END      = pd.Timestamp('2024-01-01')
BAD_UP, BAD_DN = 3.0, -0.95                   # daily return bad-print thresholds
BENCH          = ['RSP', 'IWM', 'IJR', 'SPY']  # SPY = corpus DATA_DIR/SPY.csv; the rest from reference/
# Funds in DATA_DIR/*.csv are not stocks: excluded from the universe (the ones actually found are printed).
ETF_EXCLUDE = {'SPY', 'RSP', 'IWM', 'IJR', 'QQQ', 'DIA', 'MDY', 'IWB', 'IWV', 'IWN', 'IWO', 'IWD', 'IWF', 'VTI',
               'VOO', 'IVV', 'VB', 'VO', 'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV',
               'XLY', 'GLD', 'SLV', 'TLT', 'IEF', 'SHY', 'HYG', 'LQD', 'AGG', 'BND', 'EEM', 'EFA', 'VNQ', 'SMH',
               'SOXX', 'XBI', 'IBB', 'KRE', 'KBE', 'XHB', 'XRT', 'XME', 'XOP', 'ARKK', 'GDX', 'GDXJ', 'USO',
               'UNG', 'UUP', 'VXX', 'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'UVXY', 'SSO', 'SDS'}
'''),
    ("code", "# ===== Cell 1 — helpers + benchmark data (pull IJR/IWM/RSP if missing) =====\n"
     + HELPERS.strip("\n") + r'''

BPX = {'SPY': load_px(DATA_DIR/'SPY.csv')}
for tk in ['RSP', 'IWM', 'IJR']:
    BPX[tk] = load_px(ensure_ref(tk))
CAL = pd.DatetimeIndex(BPX['SPY']['Date'])               # trading calendar = SPY rows
assert all(d['Date'].max() <= CUT_DATE for d in BPX.values())
'''),
    ("code", r'''
# ===== Cell 2 — load the universe (cut at load) =====
files = sorted(glob.glob(f'{DATA_DIR}/*.csv'))
etfs_found = sorted(Path(f).stem.upper() for f in files if Path(f).stem.upper() in ETF_EXCLUDE)
RET, DVOL, FIRST, LAST, NBAR, EMPTY, FAILED = {}, {}, {}, {}, {}, [], []
for f in files:
    tk = Path(f).stem.upper()
    if tk in ETF_EXCLUDE: continue
    try:
        d = load_px(f)
    except Exception as e:
        FAILED.append((tk, repr(e)[:80])); continue
    if d.empty:
        EMPTY.append(tk); continue                        # no rows on/before the cut
    FIRST[tk], LAST[tk], NBAR[tk] = d['Date'].iloc[0], d['Date'].iloc[-1], len(d)
    RET[tk] = close_ret(d, CAL)
    y11 = d[d['Date'].dt.year == 2011]
    DVOL[tk] = (len(y11), float((y11['Close'] * y11['Volume']).median()) if len(y11) else np.nan)
assert max(LAST.values()) <= CUT_DATE
print(f'files {len(files)} | ETFs excluded {len(etfs_found)}: {etfs_found}')
print(f'stock universe {len(RET)} | no rows <= cut: {len(EMPTY)} | unreadable: {len(FAILED)} {FAILED[:5]}')
'''),
    ("markdown", "## A1 — file end dates"),
    ("code", r'''
# ===== Cell 3 — A1: who ends early =====
LAST_BAR = CAL[-1]                                       # final bar of the (cut) sample
ends = pd.DataFrame({'first': pd.Series(FIRST), 'last': pd.Series(LAST), 'bars': pd.Series(NBAR)})
early   = ends[ends['last'] <  EARLY_END].sort_values('last')
in_2024 = ends[(ends['last'] >= EARLY_END) & (ends['last'] < LAST_BAR)].sort_values('last')
n_tot = len(ends)
print(f'A1: {len(early)} / {n_tot} tickers ({len(early)/n_tot:.1%}) end before {EARLY_END:%Y-%m-%d}')
print(f'    {len(in_2024)} end during 2024 before the final bar; '
      f'{n_tot - len(early) - len(in_2024)} run to the final in-sample bar (count only)')
pd.set_option('display.max_rows', 500)
print('\nEnding before 2024-01-01 (last date = last bar):')
print(early.assign(first=early['first'].dt.date, last=early['last'].dt.date).to_string())
if len(in_2024):
    print('\nEnding during 2024 (before the final bar):')
    print(in_2024.assign(first=in_2024['first'].dt.date, last=in_2024['last'].dt.date).to_string())
early.to_csv(OUT_DIR/'survivorship_a1_early_files.csv')

# live / born / died per year (2010 "born" = data start, not an IPO)
yrs = range(2010, 2025)
fy, ly = ends['first'].dt.year, ends['last'].dt.year
per_year = pd.DataFrame({'live': [int(((fy <= y) & (ly >= y)).sum()) for y in yrs],
                         'born': [int((fy == y).sum()) for y in yrs],
                         'died': [int(((ly == y) & (ends['last'] < LAST_BAR)).sum()) for y in yrs]},
                        index=list(yrs))
print('\nLive / born / died per year (died = last bar in that year and before the final bar):')
print(per_year.to_string())
'''),
    ("markdown", "## A2 — equal-weight buy-and-hold vs RSP / IWM / IJR / SPY"),
    ("code", r'''
# ===== Cell 4 — bad prints + EW daily series =====
R = pd.DataFrame(RET).reindex(CAL)                      # day x ticker, NaN = not held that day
bad = (R > BAD_UP) | (R < BAD_DN)
bp = R[bad].stack().dropna().rename('ret').reset_index(); bp.columns = ['date', 'ticker', 'ret']
bp = bp.sort_values(['date', 'ticker']).reset_index(drop=True)
in_win = bp[(bp['date'] >= A_START) & (bp['date'] <= A_END)]
print(f'bad prints (>{BAD_UP:+.0%} or <{BAD_DN:+.0%}): {len(bp)} total, {len(in_win)} inside 2011-2023, '
      f'{bp["ticker"].nunique()} tickers')
print(bp.assign(date=bp['date'].dt.date, ret=bp['ret'].map(lambda x: f'{x:+.1%}')).to_string())
bp.to_csv(OUT_DIR/'survivorship_bad_prints.csv', index=False)
R_clean = R.mask(bad)                                    # drop ONLY that ticker-day return

win = (CAL >= A_START) & (CAL <= A_END)
dvol = pd.DataFrame(DVOL, index=['bars_2011', 'med_dvol_2011']).T
elig = dvol[(dvol['bars_2011'] >= 200) & (dvol['med_dvol_2011'] > 0)]
COHORT = elig.index[elig['med_dvol_2011'] <= elig['med_dvol_2011'].quantile(1/3)]
print(f'\n2011 dollar-volume cohort: {len(elig)} eligible (>=200 bars in 2011, volume > 0), '
      f'bottom tercile {len(COHORT)} tickers (median $vol <= {elig["med_dvol_2011"].quantile(1/3):,.0f})')

SER = {'EW_raw':   R.loc[win].mean(axis=1),
       'EW':       R_clean.loc[win].mean(axis=1),
       'EW_bot3':  R_clean.loc[win, COHORT].mean(axis=1)}
for tk in BENCH:
    SER[tk] = close_ret(BPX[tk], CAL).reindex(CAL[win])
S = pd.DataFrame(SER)
held = R_clean.loc[win].notna().sum(axis=1)
print(f'names held per day: min {held.min()}  median {int(held.median())}  max {held.max()}')
print('missing benchmark days in window:', S[BENCH].isna().sum().to_dict())
'''),
    ("code", r'''
# ===== Cell 5 — CAGR, max drawdown, annual gaps, verdict =====
N_YEARS = A_END.year - A_START.year + 1

def summarize(r):
    r = r.fillna(0.0); eq = (1 + r).cumprod()
    return {'CAGR': eq.iloc[-1] ** (1 / N_YEARS) - 1, 'MaxDD': float((eq / eq.cummax() - 1).min()),
            'total': eq.iloc[-1] - 1}

summ = pd.DataFrame({k: summarize(S[k]) for k in S}).T
print(f'2011-2023 ({N_YEARS} yrs), total return, daily series:')
print(summ.map(lambda x: f'{x:+.2%}').to_string())

ann = (1 + S.fillna(0.0)).groupby(S.index.year).prod() - 1
gaps = pd.DataFrame({f'EW-{b}': ann['EW'] - ann[b] for b in BENCH} |
                    {f'bot3-{b}': ann['EW_bot3'] - ann[b] for b in ['IJR', 'IWM']})
print('\nCalendar-year returns:')
print(ann.map(lambda x: f'{x:+.1%}').to_string())
print('\nAnnual gaps (EW = clean full universe; bot3 = bottom 2011 $vol tercile):')
print(gaps.map(lambda x: f'{x:+.1%}').to_string())
print('mean  ', ' '.join(f'{c}={v:+.2%}' for c, v in gaps.mean().items()))
print('>0 yrs', ' '.join(f'{c}={int((gaps[c] > 0).sum())}/{len(gaps)}' for c in gaps))

summ.to_csv(OUT_DIR/'survivorship_a2_summary.csv'); ann.to_csv(OUT_DIR/'survivorship_a2_annual.csv')
gaps.to_csv(OUT_DIR/'survivorship_a2_gaps.csv')

c = summ['CAGR']
tilt_full, tilt_b_ijr, tilt_b_iwm = c['EW'] - c['RSP'], c['EW_bot3'] - c['IJR'], c['EW_bot3'] - c['IWM']
size = lambda x: 'small' if abs(x) < 0.01 else ('moderate' if abs(x) < 0.03 else 'LARGE')
print(f'\nVERDICT: EW universe CAGR {c["EW"]:+.2%} vs RSP {c["RSP"]:+.2%} -> tilt {tilt_full:+.2%}/yr '
      f'({size(tilt_full)}; vs IWM {c["EW"] - c["IWM"]:+.2%}, vs SPY {c["EW"] - c["SPY"]:+.2%}); bottom tercile '
      f'{c["EW_bot3"]:+.2%} vs IJR {tilt_b_ijr:+.2%}/yr, vs IWM {tilt_b_iwm:+.2%}/yr ({size(tilt_b_iwm)}). '
      f'Lower bound (no delisting returns); includes daily-rebalance premium.')
'''),
    ("code", r'''
# ===== Cell 6 — equity curves (log) =====
import matplotlib.pyplot as plt
eq = (1 + S.fillna(0.0)).cumprod()
ax = eq[['EW', 'EW_bot3', 'RSP', 'IWM', 'IJR', 'SPY']].plot(logy=True, figsize=(11, 5), lw=1.2)
ax.set_title('Equal-weight corpus vs benchmarks, 2011-2023 (growth of $1, log)'); ax.grid(alpha=0.3)
plt.tight_layout(); plt.savefig(OUT_DIR/'survivorship_a2_equity.png', dpi=110); plt.show()
'''),
]

# ======================================================= Task B: screen pack 1
B_CELLS = [
    ("markdown", r'''
# Screen pack 1 (Task B) — quick directional screens, NOT a gate kit

Three calendar screens. Everything below is PRE-REGISTERED (statistic, sign, verdict rule) before the first run.
Lockbox: every series cut at 2024-12-31 at load; Tiingo pulls request `endDate=2024-12-31`.

**Verdict rule (all screens):** *worth drilling* iff the primary statistic is > 0 in the most recent era
(2020-2024) **and** > 0 in at least ⌈2/3·N⌉ of the N years (S1/S2: 10 of 15, 2010-2024; S3: 10 of 14, 2011-2024).
Otherwise *not worth drilling*. t-stats are reported for context, not used by the rule.

- **S1 turn-of-month (SPY close-to-close).** Day offsets: −1 = month's last trading day, +1 = next month's
  first; offsets beyond ±5 are "other days". **Primary:** mean daily return over [−3, +3] minus the other-days
  mean. Secondary rows: [−1, +3] and day +1 alone. Full −5..+5 table is descriptive. Welch t vs other days.
  *T+1 settlement (2024-05-28) leaves ~7 in-sample months after the change — not splittable, noted only.*
- **S2 pre-holiday (SPY).** Holidays = weekdays with no SPY bar, minus the unscheduled closures 2012-10-29/30
  (Sandy) and 2018-12-05 (Bush funeral). Day −1 / −2 = last / second-last trading day before each holiday.
  Normal days = not −1/−2. **Primary:** day −1 mean minus normal-day mean. Robustness: TOM ([−3,+3]) days
  removed from both sides; half-days (day after Thanksgiving, Dec 24, Jul 3 by rule) tagged and dropped in one row.
- **S3 Russell July (IJR − IWM).** Recon date = last Friday of June, one week earlier if that Friday is the 29th/30th
  (hard-coded table, asserted against the rule). **Primary:** compounded IJR return minus compounded IWM return,
  recon-day close → close 20 trading days later. **Sign: positive = IJR beats IWM; one-sided t (greater).**
  Control: per-year mean spread of ALL other 20-day windows that year (non-overlapping with the recon window);
  the verdict must pass on BOTH the raw spread and the spread minus that baseline. Secondary: July calendar month
  (June last close → July last close) vs the other 11 months of that year.
'''),
    ("code", "# ===== Cell 0 — config =====\n" + SETUP.strip("\n") + r'''

ERAS  = {'2010-2014': (2010, 2014), '2015-2019': (2015, 2019), '2020-2024': (2020, 2024)}
RECENT = '2020-2024'
WINDOWS = {'W[-3,+3] PRIMARY': [-3, -2, -1, 1, 2, 3], 'W[-1,+3]': [-1, 1, 2, 3], 'day +1': [1]}
UNSCHEDULED = pd.to_datetime(['2012-10-29', '2012-10-30', '2018-12-05'])
RECON = {2011: '2011-06-24', 2012: '2012-06-22', 2013: '2013-06-28', 2014: '2014-06-27', 2015: '2015-06-26',
         2016: '2016-06-24', 2017: '2017-06-23', 2018: '2018-06-22', 2019: '2019-06-28', 2020: '2020-06-26',
         2021: '2021-06-25', 2022: '2022-06-24', 2023: '2023-06-23', 2024: '2024-06-28'}
S3_H = 20                                                # trading days after recon
'''),
    ("code", "# ===== Cell 1 — helpers + data (pull IJR/IWM/RSP if missing) =====\n"
     + HELPERS.strip("\n") + r'''

def need_years(n): return math.ceil(2 * n / 3)

def welch(a, b):
    a, b = pd.Series(a).dropna(), pd.Series(b).dropna()
    return float(stats.ttest_ind(a, b, equal_var=False).statistic) if len(a) > 1 and len(b) > 1 else np.nan

def verdict(name, era_val, per_year):
    n, k = len(per_year), int((per_year > 0).sum())
    ok = (era_val > 0) and (k >= need_years(n))
    print(f'{name}: recent-era {era_val:+.4%} ({"+" if era_val > 0 else "-"}), positive years {k}/{n} '
          f'(need {need_years(n)}) -> {"WORTH DRILLING" if ok else "not worth drilling"}')
    return ok

SPYD = load_px(DATA_DIR/'SPY.csv')
REFS = {tk: load_px(ensure_ref(tk)) for tk in ['IJR', 'IWM', 'RSP']}
assert SPYD['Date'].max() <= CUT_DATE and all(d['Date'].max() <= CUT_DATE for d in REFS.values())
CAL = pd.DatetimeIndex(SPYD['Date'])
assert CAL[-1] == pd.Timestamp('2024-12-31'), 'Dec-2024 must be complete for month-end labels'
r_spy = close_ret(SPYD)
r_spy = r_spy[(r_spy.index.year >= 2010) & (r_spy.index.year <= 2024)]
print(f'SPY returns {r_spy.index[0].date()} .. {r_spy.index[-1].date()}  n={len(r_spy)}')
'''),
    ("markdown", "## S1 — turn of month"),
    ("code", r'''
# ===== Cell 2 — S1 turn-of-month =====
LCAL = CAL[CAL >= pd.Timestamp('2010-01-01')]            # label complete months only (2010-01 .. 2024-12)
assert LCAL[0] == pd.Timestamp('2010-01-04'), 'Jan-2010 must be complete for month-start labels'
lab = pd.DataFrame(index=LCAL); lab['ym'] = LCAL.to_period('M')
fwd = lab.groupby('ym').cumcount() + 1
bwd = lab.groupby('ym').cumcount(ascending=False) + 1
assert not ((fwd <= 5) & (bwd <= 5)).any()
OFF = pd.Series(np.where(fwd <= 5, fwd, np.where(bwd <= 5, -bwd, 0)), index=LCAL)
s1 = pd.DataFrame({'r': r_spy, 'off': OFF.reindex(r_spy.index)})
s1['year'] = s1.index.year
other = s1['off'] == 0

def era_mask(df, e): lo, hi = ERAS[e]; return (df['year'] >= lo) & (df['year'] <= hi)

rows = {f'day {k:+d}': s1['off'] == k for k in [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]}
rows |= {w: s1['off'].isin(offs) for w, offs in WINDOWS.items()}
tab = {}
for e in list(ERAS) + ['ALL']:
    m = era_mask(s1, e) if e in ERAS else pd.Series(True, index=s1.index)
    o = s1.loc[m & other, 'r']
    for name, sel in rows.items():
        x = s1.loc[m & sel, 'r']
        tab[(name, e)] = {'mean_bp': x.mean() * 1e4, 'n': len(x), 'diff_bp': (x.mean() - o.mean()) * 1e4,
                          't': welch(x, o)}
    tab[('other days', e)] = {'mean_bp': o.mean() * 1e4, 'n': len(o), 'diff_bp': 0.0, 't': np.nan}
T1 = pd.DataFrame(tab).T.unstack(1)
T1 = T1.reindex(list(rows) + ['other days'])
print('S1 mean daily return (bp), n, diff vs other days (bp), Welch t — by era')
for e in list(ERAS) + ['ALL']:
    print(f'\n[{e}]'); print(T1.xs(e, axis=1, level=1)[['mean_bp', 'n', 'diff_bp', 't']].round(2).to_string())
T1.to_csv(OUT_DIR/'s1_tom_by_era.csv')

def s1_year_stat(offs):
    g = s1.groupby('year')
    return g.apply(lambda d: d.loc[d['off'].isin(offs), 'r'].mean() - d.loc[d['off'] == 0, 'r'].mean())

Y1 = pd.DataFrame({w: s1_year_stat(offs) for w, offs in WINDOWS.items()})
print('\nPer-year window-minus-other (bp):'); print((Y1 * 1e4).round(1).to_string())
print('positive years:', {w: f'{int((Y1[w] > 0).sum())}/{len(Y1)}' for w in Y1})
Y1.to_csv(OUT_DIR/'s1_tom_per_year.csv')
print()
V = {}
for w in WINDOWS:
    era_diff = T1.loc[w, ('diff_bp', RECENT)] / 1e4
    V[f'S1 {w}'] = verdict(f'S1 {w}', era_diff, Y1[w])
print('NOTE: T+1 settlement began 2024-05-28; ~7 in-sample months after it — cannot be split in-sample.')
'''),
    ("markdown", "## S2 — pre-holiday"),
    ("code", r'''
# ===== Cell 3 — S2 pre-holiday =====
closed = pd.bdate_range(LCAL[0], CAL[-1]).difference(CAL)
HOL = closed.difference(UNSCHEDULED)
print(f'weekday closures {len(closed)}; unscheduled excluded {len(closed) - len(HOL)}; holidays {len(HOL)}')
pos = CAL.searchsorted(HOL) - 1                          # last trading day before each holiday
PRE1 = pd.DatetimeIndex(sorted(set(CAL[pos[pos >= 0]])))
PRE2 = pd.DatetimeIndex(sorted(set(CAL[pos[pos >= 1] - 1]))).difference(PRE1)

def half_day(d):
    if d.month == 12 and d.day == 24: return True
    if d.month == 7 and d.day == 3 and pd.Timestamp(d.year, 7, 4).weekday() < 5: return True
    if d.month == 11 and d.weekday() == 4:              # Friday after the 4th Thursday
        thu = [x for x in pd.date_range(f'{d.year}-11-01', f'{d.year}-11-30') if x.weekday() == 3][3]
        return d == thu + pd.Timedelta(days=1)
    return False

s2 = s1[['r', 'off', 'year']].copy()
s2['pre1'], s2['pre2'] = s2.index.isin(PRE1), s2.index.isin(PRE2)
s2['tom'] = s2['off'].isin(WINDOWS['W[-3,+3] PRIMARY'])
s2['half'] = [half_day(d) for d in s2.index]
normal = ~s2['pre1'] & ~s2['pre2']
print(f'day -1: {int(s2.pre1.sum())} (of which TOM {int((s2.pre1 & s2.tom).sum())}, '
      f'half-day {int((s2.pre1 & s2.half).sum())}); day -2: {int(s2.pre2.sum())}')

rows2 = {'day -1 PRIMARY': (s2['pre1'], normal), 'day -2': (s2['pre2'], normal),
         'day -1 ex-TOM': (s2['pre1'] & ~s2['tom'], normal & ~s2['tom']),
         'day -2 ex-TOM': (s2['pre2'] & ~s2['tom'], normal & ~s2['tom']),
         'day -1 ex-half-day': (s2['pre1'] & ~s2['half'], normal & ~s2['half'])}
tab = {}
for e in list(ERAS) + ['ALL']:
    m = era_mask(s2, e) if e in ERAS else pd.Series(True, index=s2.index)
    for name, (sel, base) in rows2.items():
        x, o = s2.loc[m & sel, 'r'], s2.loc[m & base, 'r']
        tab[(name, e)] = {'mean_bp': x.mean() * 1e4, 'n': len(x), 'base_bp': o.mean() * 1e4,
                          'diff_bp': (x.mean() - o.mean()) * 1e4, 't': welch(x, o)}
T2 = pd.DataFrame(tab).T.unstack(1).reindex(list(rows2))
for e in list(ERAS) + ['ALL']:
    print(f'\n[{e}]'); print(T2.xs(e, axis=1, level=1)[['mean_bp', 'n', 'base_bp', 'diff_bp', 't']].round(2).to_string())
T2.to_csv(OUT_DIR/'s2_preholiday_by_era.csv')

def s2_year_stat(sel, base):
    return s2.groupby('year').apply(lambda d: d.loc[sel.loc[d.index], 'r'].mean() - d.loc[base.loc[d.index], 'r'].mean())

Y2 = pd.DataFrame({n: s2_year_stat(sel, base) for n, (sel, base) in rows2.items()})
print('\nPer-year day-minus-normal (bp):'); print((Y2 * 1e4).round(1).to_string())
Y2.to_csv(OUT_DIR/'s2_preholiday_per_year.csv')
print()
for n in ['day -1 PRIMARY', 'day -1 ex-TOM', 'day -2']:
    V[f'S2 {n}'] = verdict(f'S2 {n}', T2.loc[n, ('diff_bp', RECENT)] / 1e4, Y2[n])
'''),
    ("markdown", "## S3 — Russell reconstitution (IJR − IWM)"),
    ("code", r'''
# ===== Cell 4 — S3 Russell July =====
def rule_recon(y):
    fr = [d for d in pd.date_range(f'{y}-06-01', f'{y}-06-30') if d.weekday() == 4][-1]
    return fr - pd.Timedelta(days=7) if fr.day >= 29 else fr

for y, d in RECON.items():
    assert pd.Timestamp(d) == rule_recon(y), (y, d, rule_recon(y))

cij = REFS['IJR'].set_index('Date')['Close']; ciw = REFS['IWM'].set_index('Date')['Close']
C3 = pd.concat({'IJR': cij, 'IWM': ciw}, axis=1).dropna()
C3 = C3[C3.index.isin(CAL)]
D3 = C3.index
for y, d in RECON.items():
    assert pd.Timestamp(d) in D3, f'recon {d} not a common trading day'

def spread(i0, i1):
    a, b = C3['IJR'].iloc[i1] / C3['IJR'].iloc[i0] - 1, C3['IWM'].iloc[i1] / C3['IWM'].iloc[i0] - 1
    return a - b

month_end = pd.Series(D3, index=D3).groupby(D3.to_period('M')).max()
rows3 = []
for y, d in RECON.items():
    i0 = D3.get_loc(pd.Timestamp(d)); i1 = i0 + S3_H
    s_rec = spread(i0, i1)
    # baseline: every other 20-day window starting in year y that does not overlap [i0, i1] and ends in-sample
    starts = [i for i in np.where(D3.year == y)[0] if i + S3_H < len(D3) and (i + S3_H < i0 or i > i1)]
    base20 = float(np.mean([spread(i, i + S3_H) for i in starts]))
    # July month and the other 11 months of year y (prior month-end close -> month-end close)
    me = {p: D3.get_loc(month_end[p]) for p in month_end.index}
    mon = {m: spread(me[pd.Period(f'{y}-{m:02d}', 'M') - 1], me[pd.Period(f'{y}-{m:02d}', 'M')])
           for m in range(1, 13) if pd.Period(f'{y}-{m:02d}', 'M') in me and pd.Period(f'{y}-{m:02d}', 'M') - 1 in me}
    s_jul = mon[7]; base_m = float(np.mean([v for m, v in mon.items() if m != 7]))
    rows3.append({'year': y, 'recon': d, 'end': D3[i1].date(), 'spread20': s_rec, 'base20': base20,
                  'excess20': s_rec - base20, 'july': s_jul, 'base_month': base_m, 'excess_july': s_jul - base_m,
                  'n_base20': len(starts), 'n_months': len(mon)})
Y3 = pd.DataFrame(rows3).set_index('year')
print('S3 per-year (IJR - IWM, compounded):')
print(Y3.assign(**{c: Y3[c].map(lambda x: f'{x:+.2%}') for c in
                   ['spread20', 'base20', 'excess20', 'july', 'base_month', 'excess_july']}).to_string())
Y3.to_csv(OUT_DIR/'s3_russell_per_year.csv')

S3_STATS = ['spread20', 'excess20', 'july', 'excess_july']
summ3 = {}
for c in S3_STATS:
    x = Y3[c]; t1 = stats.ttest_1samp(x, 0.0, alternative='greater')
    summ3[c] = {'mean': x.mean(), 'hit': (x > 0).mean(), 'n_pos': int((x > 0).sum()), 'n': len(x),
                't': t1.statistic, 'p_one_sided': t1.pvalue,
                **{f'mean {e}': x[(x.index >= lo) & (x.index <= hi)].mean() for e, (lo, hi) in ERAS.items()}}
summ3 = pd.DataFrame(summ3).T
print('\nS3 summary (one-sided t, H1: IJR > IWM):'); print(summ3.round(4).to_string())
summ3.to_csv(OUT_DIR/'s3_russell_summary.csv')
print()
ok_raw = verdict('S3 recon+20 raw spread', summ3.loc['spread20', f'mean {RECENT}'], Y3['spread20'])
ok_exc = verdict('S3 recon+20 minus baseline', summ3.loc['excess20', f'mean {RECENT}'], Y3['excess20'])
V['S3 recon+20 PRIMARY (raw AND excess)'] = ok_raw and ok_exc
ok_j = verdict('S3 July month raw', summ3.loc['july', f'mean {RECENT}'], Y3['july'])
ok_je = verdict('S3 July minus other months', summ3.loc['excess_july', f'mean {RECENT}'], Y3['excess_july'])
V['S3 July month (secondary, raw AND excess)'] = ok_j and ok_je
'''),
    ("code", r'''
# ===== Cell 5 — verdicts =====
print('VERDICTS (pre-registered rule: recent era > 0 AND >= 2/3 of years > 0)')
for k, v in V.items():
    print(f'  {"WORTH DRILLING    " if v else "not worth drilling"}  {k}')
pd.Series(V, name='worth_drilling').to_csv(OUT_DIR/'screen_pack1_verdicts.csv')
'''),
]

for name, cells in [("survivorship_check.ipynb", A_CELLS), ("screen_pack1.ipynb", B_CELLS)]:
    (HERE / name).write_text(json.dumps(nb(cells), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote", HERE / name)
