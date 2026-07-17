# JACK Session C — Implementation Spec (analytics: edge-decay + selection value + execution)

**For:** Claude Code, working the `SunriseSunsetCoder/bloomberg-terminal` repo.
**Read first:** `JACK_SESSION_B_SPEC.md`, `JACK_UI_V2_SPEC.md`, `PROJECT_STATE.md` at repo root.
**Type:** Read/analytics layer over Session B's data. Adds views; changes no write logic.
**VPS:** `C:\Users\Administrator\Desktop\bloomberg-terminal` · **Win10 dev:** `C:\Repos\bloomberg-terminal`

---

## 0. Foundation is now VALIDATED (new since the pre-backfill draft)

The replay math is **proven**. A backfill of 6 real trades (BNY, UNM, WELL, EXPD closed; MET, MAA open) ran against real Tiingo prices and PASSED: all 4 winners fired and hit target (none stopped out), both open positions correctly deferred to `still_open` (90-day resolution window not elapsed), and EXPD showed the theoretical-vs-execution divergence (setup target-hit ~+1.1R vs actual +0.49R from a mis-set-TP early exit). So Session C is built on a **confirmed-correct outcome tracker**, not an assumed one. The `decision_outcomes` view now holds real, validated rows.

Session C answers **three** questions — the third is now first-class because execution divergence is proven real (EXPD):
1. **Is the strategy edge still there?** — outcomes of all resolved setups over time (decay detection).
2. **Is my selection adding value?** — universe PF vs selected PF.
3. **Am I executing my picks well?** — theoretical R vs my actual-fill R (the EXPD-style divergence).

---

## 1. Scope

Pure analytics panel over existing data. Views in §4. **No schema changes expected** — reads `decision_outcomes` + `outcomes` + `decisions` + `setups`. If a query helper is missing, add read-only helpers; do NOT alter tables. The interactive mark/fill UI already shipped in v2, so C is analytics only.

---

## 2. Prereq / branch

```
git fetch origin
git checkout -b jack-session-c-analytics origin/main   # off FRESH origin/main
```
`git fetch && rebase origin/main` before every push. `git commit --no-verify` works. npm only, `.npmrc` untouched, no localStorage.

**Merge-order note:** several JACK branches are stacked unmerged (jack-fixes-batch, jack-markdown-raw-fix, jack-backfill-6-trades). Confirm the safe merge order and that origin/main contains the frozen-verdict + markdown-raw + backfill work BEFORE branching C, so C starts from the complete foundation and the backfilled outcomes are present in the DB.

Read `/mnt/skills/public/frontend-design/SKILL.md` before UI — keep the Bloomberg-terminal language (mono, orange accents). Reuse v2 aesthetics (pills, R coloring, expandable detail) where they fit.

---

## 3. Data model (read the live schema first)

Open `lib/db/schema.sql` and confirm the `decision_outcomes` view + column names. Key fields:

- `outcomes`: `fired`, `exit_reason` (target/stop/timeout/never_fired/still_open), `R_realized` (THEORETICAL), `user_entry_price/date`, `user_exit_price/date`, `user_R_realized` (ACTUAL), `max_favorable_pct`, `max_adverse_pct`, resolution/fire dates.
- `decisions`: `user_action` (TRADED/PASSED/WATCHED/NULL), `jack_decision_at_mark` (JACK's verdict frozen at mark time), Claude's live decision, setup linkage.
- `setups`: geometry, `handle_low_date`, section (live/pending), first/last seen.

### CRITICAL modeling distinctions — get these right or the numbers lie

1. **NULL user_action != PASSED.** Unmarked = unreviewed, not skipped. Selection analysis compares TRADED against explicitly PASSED only. NULL is excluded from selection math but counts in the universe.
2. **Universe PF** = all RESOLVED setups, theoretical R_realized, excluding `never_fired` (no trade) and `still_open`/deferred (MET/MAA — not yet resolved). `timeout` = mark-to-market, included.
3. **Selected PF — compute BOTH ways, show BOTH:**
   - (a) theoretical R_realized for TRADED setups — "did I pick good setups?" (apples-to-apples vs universe)
   - (b) user_R_realized where fills exist — "did I execute them well?"
4. **Execution delta** = per-traded-setup `user_R_realized - R_realized`. The EXPD signal generalized. Negative = underperformed the setup (early exit, bad TP — EXPD). Positive = beat it (e.g. WELL pre-breakout entry shrinking the risk denominator). **Flag sign AND cause — a positive delta from a pre-breakout entry is idiosyncratic, not skill.**
5. **jack_decision_at_mark vs live decision:** selection analysis uses what JACK said WHEN MARKED (frozen), not its drifting current verdict. This makes "did I beat JACK's call" honest.
6. **still_open handling:** deferred setups (MET/MAA) are NOT resolved — exclude from PF/win-rate, but SHOW separately as "open positions" with mark-to-market so live exposure is visible without polluting resolved stats.

---

## 4. The views

Single "JACK Analytics" panel (button in terminal header). Sections:

### View 1 — Edge over time (decay detection)
Rolling performance of ALL resolved universe setups, bucketed by period. Per bucket: n, win rate, avg R, PF. Time series so decay is visible — is the Cup-with-Handle edge (backtest PF 2.09 IS / 1.70 OOS) holding or drifting toward 1.0? Independent of the user's choices.

### View 2 — Universe vs Selected (selection value)
Headline comparison:
- Universe: n, win rate, avg R, PF (all resolved, theoretical R)
- Selected (theoretical): TRADED setups, theoretical R
- Selected (actual): same on user_R_realized where available
- Delta + verdict, gated on sample size (§5).

### View 3 — Execution quality (theoretical vs actual) — NOW FIRST-CLASS
Per-traded-setup theoretical R vs actual R, and the delta (EXPD divergence generalized):
- Aggregate: mean AND median execution delta (are you systematically leaving money on the table, or beating your setups?)
- Per-trade drill: biggest positive/negative deltas with cause hints (early exit? pre-breakout entry? held past target?)
- EXPD archetype: setup +1.1R, actual +0.49R -> bad-TP execution loss. This view turns that one lesson into a measured pattern.

### View 4 — Decision-type breakdown (is my discrimination real signal?)
- TRADED outcomes vs explicitly-PASSED outcomes (both theoretical R). PASSED underperforming TRADED -> skip instinct is real signal. PASSED outperforming -> you skipped winners.
- Cross with jack_decision_at_mark: when you OVERRODE JACK (traded its SKIP / passed its TRADE), did overriding help?
- Per-ticker timeline drill-down.

---

## 5. Sample-size guards (non-negotiable — this is a research tool)

Mirror the futures-book n>=30 discipline. Views WILL look authoritative on tiny n and be meaningless.

- Show n prominently on every stat/bucket/verdict.
- Any PF / win-rate / delta on n < 30 -> explicit "LOW SAMPLE — not reliable" flag (visual, not buried). Named constant (default 30), not a magic number.
- Universe-vs-selected VERDICT must NOT render as a conclusion below threshold — show raw numbers, suppress verdict with "insufficient data" until both arms clear n>=30.
- **Current reality: ~4 resolved trades (backfilled closed winners) + 2 open.** EVERYTHING is low-sample now. Views must degrade gracefully and truthfully — build now so they're ready to fill, but they must scream "insufficient data" at n=4, not flatter. With the 90-day gate, resolved outcomes accumulate slowly; first trustworthy read is many months out.
- Execution delta care: WELL's large positive actual-R (pre-breakout entry) is real but idiosyncratic — one such trade dominates a small-n mean. Show median alongside mean; flag outlier-driven aggregates.

---

## 6. Design questions to confirm before coding (batch)

1. **Time bucketing** — monthly or quarterly? By resolution date or setup date (handle_low_date)? Recommend quarterly + setup date (IS/OOS framing). Confirm.
2. **Selected PF headline** — theoretical R (selection quality) or actual R (real P&L)? Recommend theoretical headline, actual secondary. Confirm.
3. **Low-sample threshold** — n>=30 (futures parity) or different for equities? Confirm constant.
4. **Charting library** — check package.json for what's already in the repo (recharts?). Use existing; do NOT add a dep. Report what's there.
5. **Open-position display** — separate "open exposure" strip with mark-to-market (MET/MAA), or omit until resolved? Recommend show separately.

---

## 7. Constraints

- Branch off fresh origin/main; rebase before push. git commit --no-verify; npm only; .npmrc untouched.
- No schema changes expected (read-only). If unavoidable, additive only, flag in §6.
- Don't touch isPersistenceAvailable(), write paths, determinism, or the replay. Analytics routes Vercel-guarded (read localhost SQLite).
- No localStorage/sessionStorage — React state only. Complete drop-in files. Atomic commits.

---

## 8. Self-test before reporting done

- Typecheck clean (ignore pre-existing ai/route.ts).
- Seed resolved outcomes across >=2 buckets + mixed user_action (TRADED/PASSED/NULL) + a still_open + a negative-delta and positive-delta execution case. Hand-verify each view.
- **Verify low-sample guard FIRES** at n<30 (verdict suppressed + flag shown) — C's correctness gate, as the backfill was B's.
- Verify NULL excluded from selection math but in universe; still_open excluded from resolved stats but shown in open-exposure.
- Verify against REAL backfilled VPS data: 4 closed winners appear as resolved target-hits; MET/MAA as open; EXPD's execution delta (~ -0.6R) surfaces in View 3.

---

## 9. Methodology reminder (PROJECT_STATE section 4)

Disciplined measurement, not decoration. Three hard truths: is the edge decaying, is my selection helping, am I executing well. Don't fabricate. Don't render conclusions the sample can't support — a confident verdict on 6 trades is worse than none. Show n everywhere. The tool's job is honesty about whether the discretionary picking AND execution earn their keep over trading the full universe mechanically.

---

## 10. What Session C completes

Full loop: scanner -> screened setups -> deterministic JACK validation -> decisions + fills (persisted) -> VALIDATED replay outcomes -> analytics measuring edge-decay, selection value, and execution quality over time. The recorder records the truth (proven by the 6-trade backfill); C is where accumulated truth becomes insight. It rests on a confirmed-correct foundation.
