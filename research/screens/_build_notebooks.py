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
(2020-2024) **and** > 0 in at least ⌈2/3·N⌉ of the N years (S1/S2: 10 of 15, 2010-2024 — 2010 is partial: labels start at the first COMPLETE month in the
data, 2010-04 for a corpus starting 2010-03-04, so the first era is shortened; S3: 10 of 14, 2011-2024).
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
# First COMPLETE month = first month whose prior month-end is in the data, i.e. the month after the data's
# first (possibly partial) month. Corpus SPY starts 2010-03-04 -> labels start 2010-04. Derived, not hardcoded.
MPER = CAL.to_period('M')
FIRST_M = MPER[0] + 1
assert (MPER == FIRST_M - 1).any() and (MPER == FIRST_M).any()
LCAL = CAL[MPER >= FIRST_M]                              # label complete months only (FIRST_M .. 2024-12)
lab = pd.DataFrame(index=LCAL); lab['ym'] = LCAL.to_period('M')
fwd = lab.groupby('ym').cumcount() + 1
bwd = lab.groupby('ym').cumcount(ascending=False) + 1
assert not ((fwd <= 5) & (bwd <= 5)).any()
OFF = pd.Series(np.where(fwd <= 5, fwd, np.where(bwd <= 5, -bwd, 0)), index=LCAL)
s1 = pd.DataFrame({'r': r_spy, 'off': OFF.reindex(r_spy.index)})
s1 = s1[s1.index >= LCAL[0]]                             # S1 AND S2 start at the first complete month
assert s1['off'].notna().all()
s1['year'] = s1.index.year
other = s1['off'] == 0
print(f'SPY data starts {CAL[0].date()}; first complete month {FIRST_M} -> S1/S2 labels start {LCAL[0].date()}')
for e, (lo, hi) in ERAS.items():
    ix = s1.index[(s1['year'] >= lo) & (s1['year'] <= hi)]
    print(f'  era {e}: {ix[0].date()} .. {ix[-1].date()}  ({len(ix)} days, {ix.to_period("M").nunique()} months)'
          + ('  <- SHORTENED first era' if ix[0].year == lo and ix[0].month > 1 else ''))
if LCAL[0].month > 1:
    print(f'  NOTE: {LCAL[0].year} is a partial year ({13 - LCAL[0].month} months) but counts as one of the per-year votes.')

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

# ======================================================= S3 drill (in-sample)
RECON_RULE = r'''

def rule_recon(y):
    """June recon: last Friday of June, one week earlier if that Friday is the 29th/30th."""
    fr = [d for d in pd.date_range(f'{y}-06-01', f'{y}-06-30') if d.weekday() == 4][-1]
    return fr - pd.Timedelta(days=7) if fr.day >= 29 else fr

'''

D_CELLS = [
    ("markdown", r'''
# S3 drill — Russell June reconstitution, IJR − IWM (IN-SAMPLE 2011-2024)

Pre-registration: `research/screens/S3_DRILL_PREREG.md` (P1 Dec-2026, P4 2027 forward tests, P2 frozen rule).
Lockbox: IJR/IWM cut at 2024-12-31 at load. The June 2025/2026 recons are NOT read here; `s3_drill_oos.ipynb` reads
them once, after the freeze commit.

**Grid:** entry e ∈ {−5, −3, −1, 0} trading days vs the recon close × exit at recon + H, H ∈ {10, 15, 20, 30}
(window length L = H − e). **Primary cell (0, 20)** is fixed from the screen and is NOT re-picked from the grid.

**Per cell, per year:** spread = compounded IJR − IWM over the window. Baseline = mean spread of ALL other windows of
the same length L that start in the same year and don't overlap the event window. Excess = spread − baseline.
Percentile = share of those baseline windows below the event window. Across the 14 years: mean/median excess,
hit rate, one-sided t, one-sided Wilcoxon, mean percentile (t vs 50), era means, leave-one-year-out.

**Costs (event trade only):** round trip on both legs, 5bp base / 15bp stress, plus IWM borrow at 0.5%/yr base /
3%/yr stress × L/252. The break-even round-trip cost is reported.

**Drill verdict (pre-registered) = ALL of:**
1. primary raw spread passes the screen rule (2020-24 mean > 0 AND ≥ 10/14 years > 0);
2. primary excess NET of base costs passes the screen rule;
3. plateau: the primary and its neighbours (0,15), (0,30), (−1,20) each have mean excess > 0 and ≥ 9/14 years > 0;
4. leave-one-year-out: every fold's mean primary excess > 0.

**Null check first (standing rule; fail = stop):** 16 martingale worlds. IJR/IWM daily returns are
block-bootstrapped jointly in 20-day blocks, each leg is demeaned, and the real recon dates are kept. Pass iff the
full-verdict pass rate is ≤ 10%, and every entry-offset family has mean percentile in [40, 60] with |t| < 2.5 and a
per-cell screen-pass rate ≤ 15%. Power: +10bp/day planted in the 20 days after each recon must pass the full
verdict in ≥ 13/16 seeds.
'''),
    ("code", "# ===== Cell 0 — config =====\n" + SETUP.strip("\n") + r'''

RECON = {2011: '2011-06-24', 2012: '2012-06-22', 2013: '2013-06-28', 2014: '2014-06-27', 2015: '2015-06-26',
         2016: '2016-06-24', 2017: '2017-06-23', 2018: '2018-06-22', 2019: '2019-06-28', 2020: '2020-06-26',
         2021: '2021-06-25', 2022: '2022-06-24', 2023: '2023-06-23', 2024: '2024-06-28'}
ENTRIES, HORIZONS = [-5, -3, -1, 0], [10, 15, 20, 30]
PRIMARY, NEIGHBOURS = (0, 20), [(0, 15), (0, 30), (-1, 20)]
ERAS = {'2011-2014': (2011, 2014), '2015-2019': (2015, 2019), '2020-2024': (2020, 2024)}; RECENT = '2020-2024'
RT_COST = {'base': 5e-4, 'stress': 15e-4}            # round trip, both legs
BORROW  = {'base': 0.005, 'stress': 0.03}            # IWM borrow, per year
PLATEAU_MIN_POS = 9
N_SEEDS, BLOCK, PLANT = 16, 20, 0.0010               # null worlds; planted +10bp/day
NULL_MAX_PASS, FAM_PCT, FAM_T, FAM_MAX, POWER_MIN = 0.10, (40, 60), 2.5, 0.15, 13
D_OUT = OUT_DIR/'s3_drill'; D_OUT.mkdir(parents=True, exist_ok=True)
'''),
    ("code", "# ===== Cell 1 — helpers + data =====\n" + HELPERS.strip("\n") + RECON_RULE + r'''
for y, d in RECON.items():
    assert pd.Timestamp(d) == rule_recon(y), (y, d, rule_recon(y))

px = pd.concat({tk: load_px(ensure_ref(tk)).set_index('Date')['Close'] for tk in ['IJR', 'IWM']}, axis=1).dropna()
assert px.index.max() <= CUT_DATE
D = px.index; A0, B0 = px['IJR'].to_numpy(float), px['IWM'].to_numpy(float); YEAR = D.year.to_numpy()
EV = {y: D.get_loc(pd.Timestamp(d)) for y, d in RECON.items()}
assert all(i0 + max(HORIZONS) < len(D) and i0 + min(ENTRIES) >= 0 for i0 in EV.values())
print(f'IJR/IWM common bars {D[0].date()} .. {D[-1].date()}  n={len(D)}; recons {len(EV)}')


def need_years(n): return math.ceil(2 * n / 3)


def cell_years(A, B, e, H):
    """Per-year event spread, same-year same-length non-overlapping baseline, excess, percentile."""
    L = H - e
    sp = A[L:] / A[:-L] - B[L:] / B[:-L]              # sp[i] = spread of the window starting at bar i
    yr = YEAR[:len(sp)]; rows = {}
    for y, i0 in EV.items():
        s, t = i0 + e, i0 + H
        idx = np.where(yr == y)[0]; idx = idx[(idx + L < s) | (idx > t)]
        base = sp[idx]; ev = sp[s]
        rows[y] = (ev, base.mean(), ev - base.mean(), 100 * (base < ev).mean(), len(idx))
    return pd.DataFrame.from_dict(rows, orient='index', columns=['spread', 'base', 'excess', 'pct', 'n_base'])


def run_drill(A, B):
    return {(e, H): cell_years(A, B, e, H) for e in ENTRIES for H in HORIZONS}


def cost(k, L): return RT_COST[k] + BORROW[k] * L / 252


def screen_pass(Y, col, c=0.0):
    x = Y[col] - c; lo, hi = ERAS[RECENT]
    return bool(x[(x.index >= lo) & (x.index <= hi)].mean() > 0 and (x > 0).sum() >= need_years(len(x)))


def drill_verdict(cells):
    Y = cells[PRIMARY]; L = PRIMARY[1] - PRIMARY[0]
    return {'1 primary raw (screen rule)': screen_pass(Y, 'spread'),
            '2 primary excess net base cost (screen rule)': screen_pass(Y, 'excess', cost('base', L)),
            '3 plateau': all(bool(cells[k]['excess'].mean() > 0) and int((cells[k]['excess'] > 0).sum()) >= PLATEAU_MIN_POS
                             for k in [PRIMARY] + NEIGHBOURS),
            '4 LOYO min fold mean excess > 0': bool(min(Y['excess'].drop(y).mean() for y in Y.index) > 0)}


def cell_stats(Y, L):
    x = Y['excess']
    out = {'mean_exc': x.mean(), 'med_exc': x.median(), 'n_pos': int((x > 0).sum()), 'n': len(x),
           't_exc': stats.ttest_1samp(x, 0.0, alternative='greater').statistic,
           'p_wilcoxon': stats.wilcoxon(x, alternative='greater').pvalue,
           'mean_pct': Y['pct'].mean(), 't_pct': stats.ttest_1samp(Y['pct'], 50.0).statistic,
           'mean_raw': Y['spread'].mean(), 'n_pos_raw': int((Y['spread'] > 0).sum())}
    for e, (lo, hi) in ERAS.items():
        sel = (x.index >= lo) & (x.index <= hi)
        out[f'exc {e}'], out[f'raw {e}'] = x[sel].mean(), Y['spread'][sel].mean()
    for k in RT_COST:
        out[f'net_exc {k}'] = x.mean() - cost(k, L); out[f'n_pos_net {k}'] = int((x - cost(k, L) > 0).sum())
    out['breakeven_rt'] = x.mean() - BORROW['base'] * L / 252
    return out
'''),
    ("markdown", "## Null check — martingale worlds (must pass before real data)"),
    ("code", r'''
# ===== Cell 2 — null check (16 martingale seeds) + power (16 planted seeds) =====
RA, RB = A0[1:] / A0[:-1] - 1, B0[1:] / B0[:-1] - 1


def world(seed, plant=0.0):
    rng = np.random.default_rng(seed); n = len(RA)
    starts = rng.integers(0, n - BLOCK, size=n // BLOCK + 1)
    idx = np.concatenate([np.arange(s, s + BLOCK) for s in starts])[:n]
    ra, rb = RA[idx] - RA.mean(), RB[idx] - RB.mean()          # joint blocks keep correlation; zero drift
    if plant:
        for i0 in EV.values(): ra[i0:i0 + 20] += plant          # moves bar i0 -> i0+20 (after the recon close)
    return np.concatenate([[1.0], np.cumprod(1 + ra)]), np.concatenate([[1.0], np.cumprod(1 + rb)])


nulls, fam = [], {e: {'pct': [], 'pass': []} for e in ENTRIES}
for seed in range(N_SEEDS):
    cells = run_drill(*world(seed)); v = drill_verdict(cells)
    nulls.append({'seed': seed, 'verdict': all(v.values()), **v})
    for e in ENTRIES:   # ONE pct value per seed per family: its 4 horizons share one path (no pseudo-replication)
        fam[e]['pct'].append(np.mean([cells[(e, H)]['pct'].mean() for H in HORIZONS]))
        fam[e]['pass'] += [screen_pass(cells[(e, H)], 'excess') for H in HORIZONS]
NULLS = pd.DataFrame(nulls).set_index('seed')
FAM = pd.DataFrame({e: {'mean_pct': np.mean(f['pct']),
                        't_pct': stats.ttest_1samp(f['pct'], 50.0).statistic,      # n = N_SEEDS
                        'cell_pass_rate': np.mean(f['pass'])} for e, f in fam.items()}).T
power = [all(drill_verdict(run_drill(*world(1000 + s, PLANT))).values()) for s in range(N_SEEDS)]

pass_rate = float(NULLS['verdict'].mean())
checks = {'verdict pass rate <= 10%': pass_rate <= NULL_MAX_PASS,
          'family mean pct in [40,60]': bool(FAM['mean_pct'].between(*FAM_PCT).all()),
          'family |t| < 2.5': bool((FAM['t_pct'].abs() < FAM_T).all()),
          'family cell pass rate <= 15%': bool((FAM['cell_pass_rate'] <= FAM_MAX).all()),
          f'power >= {POWER_MIN}/{N_SEEDS}': sum(power) >= POWER_MIN}
NULL_OK = all(checks.values())
print(NULLS.to_string()); print(f'\nverdict pass rate {pass_rate:.1%}')
print('\nentry-offset families:'); print(FAM.round(3).to_string())
print(f'\npower (planted +{PLANT*1e4:.0f}bp/day): {sum(power)}/{N_SEEDS}')
for k, v in checks.items(): print(f'  {"PASS" if v else "FAIL"}  {k}')
print('NULL CHECK:', 'PASS' if NULL_OK else 'FAIL -> STOP, do not read the real-data results')
json.dump({'null_ok': NULL_OK, 'checks': checks, 'pass_rate': pass_rate, 'power': int(sum(power))},
          open(D_OUT/'null_check.json', 'w'), indent=1)
NULLS.to_csv(D_OUT/'null_seeds.csv'); FAM.to_csv(D_OUT/'null_families.csv')
'''),
    ("markdown", "## Real data (2011-2024)"),
    ("code", r'''
# ===== Cell 3 — grid on real data =====
assert NULL_OK, 'null check failed — stop (standing rule)'
CELLS = run_drill(A0, B0)
ST = pd.DataFrame({k: cell_stats(Yc, k[1] - k[0]) for k, Yc in CELLS.items()}).T
ST.index = pd.MultiIndex.from_tuples(ST.index, names=['entry', 'H'])
pd.set_option('display.width', 250)
show = ST[['mean_exc', 'med_exc', 'n_pos', 't_exc', 'p_wilcoxon', 'mean_pct', 't_pct', 'mean_raw', 'n_pos_raw',
           'exc 2011-2014', 'exc 2015-2019', 'exc 2020-2024', 'net_exc base', 'net_exc stress', 'breakeven_rt']]
print('All 16 cells (returns as fractions; primary = (0, 20)):'); print(show.astype(float).round(4).to_string())
ST.to_csv(D_OUT/'cell_stats.csv')
pd.concat({f'{e}_{H}': Yc for (e, H), Yc in CELLS.items()}, names=['cell', 'year']).to_csv(D_OUT/'cell_years.csv')

import matplotlib.pyplot as plt
M = ST['mean_exc'].astype(float).unstack('H') * 1e4; P = ST['n_pos'].unstack('H')
fig, ax = plt.subplots(figsize=(6.5, 4)); lim = np.nanmax(np.abs(M.values))
im = ax.imshow(M.values, cmap='RdBu', vmin=-lim, vmax=lim)
ax.set_xticks(range(len(M.columns))); ax.set_xticklabels([f'+{h}' for h in M.columns])
ax.set_yticks(range(len(M.index))); ax.set_yticklabels(M.index)
ax.set_xlabel('exit: recon + H bars'); ax.set_ylabel('entry vs recon (bars)')
for i in range(M.shape[0]):
    for j in range(M.shape[1]):
        ax.text(j, i, f'{M.values[i, j]:+.0f}bp\n{int(P.values[i, j])}/14', ha='center', va='center', fontsize=8)
ax.set_title('Mean excess IJR−IWM vs same-length baseline'); fig.colorbar(im, ax=ax, label='bp')
plt.tight_layout(); plt.savefig(D_OUT/'plateau_heatmap.png', dpi=110); plt.show()
'''),
    ("code", r'''
# ===== Cell 4 — primary cell: per year, LOYO, costs =====
Y = CELLS[PRIMARY]; L = PRIMARY[1] - PRIMARY[0]
print(f'Primary {PRIMARY} per year:')
print(Y.assign(**{c: Y[c].map(lambda x: f'{x:+.2%}') for c in ['spread', 'base', 'excess']},
               pct=Y['pct'].round(0)).to_string())

loyo = pd.DataFrame({y: {'mean_exc': Y['excess'].drop(y).mean(), 'n_pos': int((Y['excess'].drop(y) > 0).sum()),
                         't': stats.ttest_1samp(Y['excess'].drop(y), 0.0, alternative='greater').statistic}
                     for y in Y.index}).T
loyo.index.name = 'left out'
print('\nLeave-one-year-out (primary excess):'); print(loyo.round(4).to_string())
print(f'  min fold mean {loyo["mean_exc"].min():+.4f} (without {loyo["mean_exc"].idxmin()})')
x20 = Y['excess'].drop(2020)
print(f'  WITHOUT 2020: mean {x20.mean():+.4f}, {int((x20 > 0).sum())}/{len(x20)} positive, '
      f't {stats.ttest_1samp(x20, 0.0, alternative="greater").statistic:.2f}')
best2 = list(Y['excess'].nlargest(2).index); xb2 = Y['excess'].drop(best2)
print(f'  DROP BEST 2 {best2}: mean {xb2.mean():+.4f}, {int((xb2 > 0).sum())}/{len(xb2)} positive')
loyo.to_csv(D_OUT/'primary_loyo.csv')
no2020 = pd.Series({k: Yc['excess'].drop(2020).mean() for k, Yc in CELLS.items()})
print('\nAll cells, mean excess WITHOUT 2020 (bp):'); print((no2020.unstack() * 1e4).round(0).to_string())

print('\nCosts on the primary (per event):')
for k in RT_COST:
    print(f'  {k:6s}: rt {RT_COST[k]*1e4:.0f}bp + borrow {BORROW[k]:.1%}/yr x {L}/252 = {cost(k, L)*1e4:.1f}bp '
          f'-> net mean excess {Y["excess"].mean() - cost(k, L):+.4f}, '
          f'{int((Y["excess"] - cost(k, L) > 0).sum())}/14 positive')
print(f'  break-even round trip (base borrow): {float(ST.loc[PRIMARY, "breakeven_rt"])*1e4:.0f}bp')
'''),
    ("code", r'''
# ===== Cell 5 — drill verdict (pre-registered) =====
V = drill_verdict(CELLS)
for k, v in V.items(): print(f'  {"PASS" if v else "FAIL"}  {k}')
DRILL_PASS = all(V.values())
print('DRILL VERDICT:', 'PASS' if DRILL_PASS else 'FAIL')
json.dump({'drill_pass': DRILL_PASS, 'criteria': V, 'null_ok': NULL_OK,
           'primary': {'mean_exc': float(Y['excess'].mean()), 'n_pos': int((Y['excess'] > 0).sum()),
                       'mean_raw': float(Y['spread'].mean())}},
          open(D_OUT/'drill_verdict.json', 'w'), indent=1)
'''),
]

# ======================================================= S3 drill (out-of-sample, ONCE)
O_CELLS = [
    ("markdown", r'''
# S3 drill — OUT-OF-SAMPLE: June 2025 and June 2026 recons (OPENED ONCE)

Applies the frozen primary rule (P2 in `research/screens/S3_DRILL_PREREG.md`) to two events and nothing else.
No grid and no re-tuning. The notebook refuses to recompute once `OOS_RESULT.json` exists.

- **Data opened:** IJR and IWM adjusted closes only, 2025-01-01 .. 2026-09-30, pulled to `reference/oos/`. The
  in-sample notebooks never read that folder. The stock universe, SPY and RSP stay sealed for 2025+.
- **Rule:** entry at the recon close, exit at recon + 20 bars. Spread = compounded IJR − IWM. Baseline = mean of all
  other non-overlapping 20-bar windows starting in the same year (2026 is a partial year, through 2026-09-30).
- **Per event:** raw spread, excess, excess net of base cost (5bp round trip + 0.5%/yr borrow × 20/252), percentile.
- **OOS read (pre-registered):** *supports* = both events have excess net of base cost > 0; *mixed* = one does;
  *against* = neither. Raw spread > 0 is reported alongside.
'''),
    ("code", "# ===== Cell 0 — config (FROZEN — must equal P2) =====\n" + SETUP.strip("\n") + r'''

OOS_START, OOS_END = pd.Timestamp('2025-01-01'), pd.Timestamp('2026-09-30')
FROZEN = {'entry': 0, 'horizon': 20, 'rt_cost': 5e-4, 'borrow': 0.005}
RECON_OOS = {2025: '2025-06-27', 2026: '2026-06-26'}
OOS_REF = REF_DIR/'oos'
O_OUT = OUT_DIR/'s3_drill_oos'; O_OUT.mkdir(parents=True, exist_ok=True)
MARKER = O_OUT/'OOS_RESULT.json'
'''),
    ("code", r'''
# ===== Cell 1 — guards: opened once, in-sample null check passed =====
if MARKER.exists():
    print(open(MARKER).read())
    raise RuntimeError('OOS already opened once — result above. Do not recompute.')
nc = json.load(open(OUT_DIR/'s3_drill'/'null_check.json'))
assert nc['null_ok'], 'in-sample null check did not pass — OOS stays sealed'
dv = json.load(open(OUT_DIR/'s3_drill'/'drill_verdict.json'))
print('in-sample drill verdict:', 'PASS' if dv['drill_pass'] else 'FAIL', dv['criteria'])
''' + RECON_RULE + r'''
for y, d in RECON_OOS.items():
    assert pd.Timestamp(d) == rule_recon(y), (y, d, rule_recon(y))
'''),
    ("code", r'''
# ===== Cell 2 — pull IJR/IWM 2025-01-01 .. 2026-09-30 into reference/oos/ =====
def pull_oos(tk):
    path = OOS_REF/f'{tk}_{OOS_START:%Y%m%d}_{OOS_END:%Y%m%d}.csv'
    if path.exists():
        print(f'{tk}: present at {path}'); return path
    token = os.environ.get('TIINGO_API_KEY')
    if not token:
        from google.colab import userdata; token = userdata.get('TIINGO_API_KEY')
    url = (f'https://api.tiingo.com/tiingo/daily/{tk}/prices?startDate={OOS_START:%Y-%m-%d}'
           f'&endDate={OOS_END:%Y-%m-%d}&token={token}')
    js = pd.DataFrame(json.load(urllib.request.urlopen(url, timeout=60)))
    df = pd.DataFrame({'Date': pd.to_datetime(js['date']).dt.strftime('%Y-%m-%d'), 'Close': js['adjClose']})
    OOS_REF.mkdir(parents=True, exist_ok=True); df.to_csv(path, index=False)
    print(f'{tk}: pulled {len(df)} rows -> {path}'); return path

OPX = {}
for tk in ['IJR', 'IWM']:
    d = pd.read_csv(pull_oos(tk)); d['Date'] = pd.to_datetime(d['Date'])
    OPX[tk] = d.drop_duplicates('Date').set_index('Date')['Close'].sort_index()
'''),
    ("code", r'''
# ===== Cell 3 — the one OOS computation =====
assert not MARKER.exists()
px = pd.concat(OPX, axis=1).dropna(); px = px[(px.index >= OOS_START) & (px.index <= OOS_END)]
D = px.index; A, B = px['IJR'].to_numpy(float), px['IWM'].to_numpy(float); YEAR = D.year.to_numpy()
e, H = FROZEN['entry'], FROZEN['horizon']; L = H - e
c = FROZEN['rt_cost'] + FROZEN['borrow'] * L / 252
sp = A[L:] / A[:-L] - B[L:] / B[:-L]; yr = YEAR[:len(sp)]
rows = []
for y, d in RECON_OOS.items():
    i0 = D.get_loc(pd.Timestamp(d)); s, t = i0 + e, i0 + H
    assert t < len(D), f'{y}: exit bar beyond {OOS_END.date()}'
    idx = np.where(yr == y)[0]; idx = idx[(idx + L < s) | (idx > t)]
    ev, base = sp[s], sp[idx].mean()
    rows.append({'year': y, 'recon': d, 'exit': str(D[t].date()), 'spread': ev, 'base': base, 'excess': ev - base,
                 'excess_net_base': ev - base - c, 'pct': 100 * (sp[idx] < ev).mean(), 'n_base': len(idx),
                 'raw_pos': bool(ev > 0), 'net_excess_pos': bool(ev - base - c > 0)})
OOS = pd.DataFrame(rows).set_index('year')
k = int(OOS['net_excess_pos'].sum())
READ = {2: 'supports', 1: 'mixed', 0: 'against'}[k]
print(OOS.to_string()); print(f'\nOOS read (pre-registered): {READ}  ({k}/2 events with excess net of base cost > 0)')
OOS.to_csv(O_OUT/'oos_events.csv')
today = pd.Timestamp.now(tz='UTC')
json.dump({'opened_utc': today.isoformat(), 'frozen': FROZEN, 'read': READ,
           'events': json.loads(OOS.reset_index().to_json(orient='records'))}, open(MARKER, 'w'), indent=1)
print('\nPaste into P3 of S3_DRILL_PREREG.md:')
for y, r in OOS.iterrows():
    print(f'| June {y} recon (OOS, frozen rule) | {today.date()} | {r.spread:+.2%} | '
          f'{"yes" if r.raw_pos else "no"} (raw > 0) | excess {r.excess:+.2%}, net {r.excess_net_base:+.2%}, '
          f'pct {r.pct:.0f}; OOS read: {READ} | |')
'''),
]

from _pack2_cells import build as _pack2   # screen pack 2 cells live in their own module

P2_PROTO_CELLS, P2_CELLS = _pack2(SETUP, HELPERS)

from _pack2_cells import PARTS as _P2_PARTS
from _s4b_cells import build as _s4b                  # S4b reuses the pack-2 config + core

S4B_CELLS = _s4b(_P2_PARTS)

from _s4b_cells import S4B_PARTS as _S4B_PARTS
from _s4b_drill_cells import build as _s4b_drill   # drill reuses pack-2 + S4b

S4B_DRILL_CELLS = _s4b_drill(_P2_PARTS, _S4B_PARTS)

from _pack3_cells import build as _pack3   # screen pack 3 Step 0 (data diagnostics)

P3_STEP0_CELLS = _pack3(SETUP)

from _pack3_screen_cells import build as _pack3_screen

P3_SCREEN_CELLS = _pack3_screen(SETUP)

for name, cells in [("survivorship_check.ipynb", A_CELLS), ("screen_pack1.ipynb", B_CELLS),
                    ("s3_drill.ipynb", D_CELLS), ("s3_drill_oos.ipynb", O_CELLS),
                    ("screen_pack2_protocol.ipynb", P2_PROTO_CELLS), ("screen_pack2.ipynb", P2_CELLS),
                    ("s4b_event_study.ipynb", S4B_CELLS), ("s4b_drill.ipynb", S4B_DRILL_CELLS),
                    ("pack3_step0.ipynb", P3_STEP0_CELLS),
                    ("pack3_screen.ipynb", P3_SCREEN_CELLS)]:
    (HERE / name).write_text(json.dumps(nb(cells), indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print("wrote", HERE / name)
