# Step 0 — is a per-ticker corpus RAW or ADJUSTED?  READ-ONLY.
#
# Run once against the Drive corpus (Colab) and once against the VPS corpus:
#     python research/step0_adjustment_check.py <corpus_dir>
#     (Colab:  !python step0_adjustment_check.py /content/drive/MyDrive/Bukowski)
# Optional: TIINGO_API_KEY in the env adds the dividend test (close vs adjClose).
#
# Three independent reads:
#   1. SPLIT test (no network): prev close / split-day open on known splits.
#      ~= split factor -> raw (split step present);  ~= 1 -> split-adjusted.
#   2. DIVIDEND test (Tiingo): file Close on 2015-01-02 vs Tiingo close / adjClose
#      for big dividend payers. Whichever it matches is the basis.
#   3. FINGERPRINT: row count + first/last Close for the sample tickers, so the
#      Drive and VPS outputs can be diffed to see if they are the same files.
import json
import os
import sys
import urllib.request
from pathlib import Path

import pandas as pd

corpus = Path(sys.argv[1] if len(sys.argv) > 1 else ".")

SPLITS = [  # (ticker, first trading day at the new price, factor)
    ("NVDA", "2024-06-10", 10), ("NVDA", "2021-07-20", 4), ("AAPL", "2020-08-31", 4),
    ("AAPL", "2014-06-09", 7), ("TSLA", "2020-08-31", 5), ("TSLA", "2022-08-25", 3),
    ("AMZN", "2022-06-06", 20), ("GOOGL", "2022-07-18", 20), ("WMT", "2024-02-26", 3),
    ("CMG", "2024-06-26", 50), ("AVGO", "2024-07-15", 10), ("SMCI", "2024-10-01", 10),
]
DIV_PAYERS = ["XOM", "KO", "T", "VZ", "JNJ", "PG", "MO", "PFE"]
DIV_DATE = "2015-01-02"


def load(tk):
    f = corpus / f"{tk}.csv"
    if not f.exists():
        return None
    d = pd.read_csv(f, usecols=["Date", "Open", "High", "Low", "Close"])
    d["Date"] = pd.to_datetime(d["Date"]).dt.strftime("%Y-%m-%d")
    return d.sort_values("Date").drop_duplicates("Date").reset_index(drop=True)


print(f"corpus: {corpus}\n\n== 1. SPLIT test (ratio ~factor => RAW, ~1 => split-ADJUSTED)")
for tk, day, factor in SPLITS:
    d = load(tk)
    if d is None:
        print(f"  {tk:6s} {day}  (file missing)"); continue
    i = d.index[d["Date"] >= day]
    if len(i) == 0 or i[0] == 0:
        print(f"  {tk:6s} {day}  (date not in file)"); continue
    i = i[0]
    ratio = d.at[i - 1, "Close"] / d.at[i, "Open"]
    verdict = "RAW" if abs(ratio - factor) / factor < 0.2 else ("ADJ" if abs(ratio - 1) < 0.2 else "??")
    print(f"  {tk:6s} {day}  factor {factor:>2}  prevClose/open = {ratio:7.3f}  -> {verdict}")

print(f"\n== 2. DIVIDEND test on {DIV_DATE} (needs TIINGO_API_KEY)")
token = os.environ.get("TIINGO_API_KEY") or os.environ.get("TIINGO_TOKEN")
if not token:
    print("  skipped: no TIINGO_API_KEY in env")
else:
    for tk in DIV_PAYERS:
        d = load(tk)
        if d is None:
            print(f"  {tk:5s} (file missing)"); continue
        row = d[d["Date"] == DIV_DATE]
        if row.empty:
            print(f"  {tk:5s} (date not in file)"); continue
        url = (f"https://api.tiingo.com/tiingo/daily/{tk}/prices?startDate={DIV_DATE}"
               f"&endDate={DIV_DATE}&token={token}")
        try:
            t = json.load(urllib.request.urlopen(url, timeout=20))[0]
        except Exception as e:  # network / symbol issues are reported, not fatal
            print(f"  {tk:5s} tiingo error: {e}"); continue
        fc = float(row["Close"].iloc[0])
        raw, adj = t["close"], t["adjClose"]
        verdict = "RAW" if abs(fc - raw) < abs(fc - adj) else "ADJ"
        print(f"  {tk:5s} file {fc:9.3f} | tiingo close {raw:9.3f} adjClose {adj:9.3f}  -> {verdict}")

print("\n== 3. FINGERPRINT (diff this block between Drive and VPS)")
for tk in sorted({s[0] for s in SPLITS} | set(DIV_PAYERS)):
    d = load(tk)
    if d is None:
        print(f"  {tk:6s} missing"); continue
    print(f"  {tk:6s} rows {len(d):5d}  {d.at[0,'Date']} {d.at[0,'Close']:.4f}  "
          f"{d['Date'].iloc[-1]} {d['Close'].iloc[-1]:.4f}")
