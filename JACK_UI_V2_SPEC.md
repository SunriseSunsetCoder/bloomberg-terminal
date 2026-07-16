# JACK UI v2 — Implementation Spec (decisions surface redesign)

**For:** Claude Code, working the `SunriseSunsetCoder/bloomberg-terminal` repo.
**Read first:** `JACK_SESSION_B_SPEC.md`, `JACK_SESSION_C_SPEC.md`, `PROJECT_STATE.md` at repo root.
**Type:** Presentation-layer rebuild. **Changes how data is entered and displayed — changes NO logic.**
**VPS:** `C:\Users\Administrator\Desktop\bloomberg-terminal` · **Win10 dev:** `C:\Repos\bloomberg-terminal`

---

## 0. What this is (and is not)

The JACK decision surface currently renders **two overlapping things**: (1) an interactive decisions table (Ticker/JACK/Action/fills) and (2) wide read-only markdown analysis tables (Table 1 Live / Table 2 Pending — 11+ columns). They show the same setups twice, force cross-referencing, and the wide markdown tables overflow / character-wrap unreadably in a constrained column.

**v2 collapses both into ONE expandable row per setup.** Each row holds the setup's data, JACK's reasoning, and the user's action controls together. Progressive disclosure (compact by default, expand on click) eliminates the width problem at its root — nothing is a wide table anymore, so there is no horizontal scroll and no character-wrapping.

**This is a rebuild of the render/input surface, NOT a logic change.** The validation pipeline, fill-save write path, re-hydration, determinism (temperature 0 + day-stable prompt + cached enrichment), and the persistence layer are all working and MUST remain untouched. See §4.

**Regression note:** the character-wrapping markdown-table regression (headers breaking one letter per line) becomes **moot** under v2 — the wide markdown tables are replaced by expandable rows. If v2 ships, the separate regression fix is unnecessary. If v2 is deferred, fix the regression separately (nowrap + overflow-x on the markdown tables only).

---

## 1. Prereq / branch

```
git fetch origin
git checkout -b jack-ui-v2 origin/main   # off FRESH origin/main
```
`git fetch && rebase origin/main` before every push. `git commit --no-verify` works now (deny rule narrowed). npm only, `.npmrc` untouched.

Read `/mnt/skills/public/frontend-design/SKILL.md` before building — keep the existing Bloomberg-terminal visual language (mono font, orange accents, the app's color tokens).

---

## 2. The design (per the approved mockup)

### Structure: two groups, expandable rows
- **Two sections, preserved:** `LIVE (n)` and `PENDING (n)`, each with a header + setup count + a hairline divider. Live = fired/actionable; Pending = watching/not-yet-fired. This distinction is NOT cosmetic — Session C needs it (a PASSED *live* setup is a strong selection signal; a WATCHED *pending* one is "not fired yet"). Keep them separate.
- **One row per setup.** No more duplicate tables. Collapsed row is a scannable line; expanded row holds everything.

### Collapsed row (scannable)
`[chevron] TICKER · [JACK verdict pill] · stop → target · R n.nn · [action badge]`
- JACK verdict as a color-coded pill: TRADE=green, SKIP=red, WATCH/WATCH-CAUTION=amber, ALREADY-FIRED/EXTENDED=gray.
- R-multiple color-coded: ≥1.5 green, ≥1.0 amber, <1.0 red.
- Action badge (right-aligned): shows current mark — `✓ TRADED` (green), `✓ PASSED` (gray), `✓ WATCHED` (blue), or `unmarked` (muted). This is the re-hydrated state from the DB.

### Expanded row (click to open)
- **Price ladder** — a horizontal visual showing stop · entry · current price · target positions, so trade geometry reads at a glance (is price past entry? how far to target? is R/R good?). Replaces four equal-weight numeric columns.
- **Reasoning/notes — full width, readable.** JACK's note (the actual analytical content: news, catalysts, sector, the "why") gets primary space, not a 200px sliver. This is the most important content when expanded.
- **Action controls:** T / P / W buttons (Traded / Passed / Watched). Active state clearly highlighted.
- **Fill panel — renders ONLY on TRADED rows.** Entry price · Entry date · Exit price · Exit date · User R · Save fills button (with the ✓ Saved / Saving… / Retry states from Session B). Do not render 13 sets of fill fields for untraded setups — the panel appears only when a row is marked TRADED.

### Space / layout
- Keep the collapsible input panel (scanner CSV + risk controls) from the prior pass — it works. The decision surface gets primary width.
- Prose wrapping stays fixed (that worked). No horizontal scroll anywhere in the decision surface — progressive disclosure removes the need.

---

## 3. Data contract (CRITICAL — write side must match Session C read side)

v2 is the **write side**; Session C is the **read side**; they share the same tables. The redesign must write EXACTLY the columns Session C aggregates. Do not change the schema — write what already exists.

| Control in the row | Writes to | Read by Session C for |
|---|---|---|
| T / P / W buttons | `decisions.user_action` = TRADED / PASSED / WATCHED | Selection analysis (universe vs selected PF) |
| Fill panel entry/exit price + dates | `outcomes.user_entry_price`, `user_entry_date`, `user_exit_price`, `user_exit_date` (+ derived `user_R_realized`) | Execution analysis (real R vs theoretical R) |
| LIVE / PENDING grouping | already in `setups`/`decisions` (section field) — display only | Distinguishing deliberate live-pass from pending-watch |
| No click (default) | `user_action` stays **NULL** | Excluded from selection math — NULL ≠ PASSED |

**Non-negotiables from the Session C spec:**
- **NULL ≠ PASSED.** An unmarked row must leave `user_action` NULL, not default to anything. The "unmarked" badge maps to NULL. Only an explicit P click writes PASSED.
- **Re-mark = UPDATE, not INSERT.** Clicking an action on an already-marked setup (e.g. after re-VALIDATE) must UPDATE the existing mark, not append a new decision row. (The current code appends — that produced 5 duplicate GLNG rows. v2 must not reproduce that; if the write route still INSERTs on re-mark, fix it to upsert the latest per setup.)

### Row data source
Render rows from the **structured JSON decisions block** (the JSON-first block shipped in the truncation fix) — NOT by scraping rendered markdown. The JSON is `setup_id`-keyed and carries the fields the row needs (ticker, section, JACK decision, entry/stop/target, breakout, note). This is why the truncation fix laid the groundwork for v2. On mount, overlay saved `user_action` + fills from the DB (the re-hydration path from Session B) onto the JSON-derived rows.

---

## 4. What must NOT change (hard guardrail)

Presentation + input rewiring ONLY. Do NOT touch:
- The validation pipeline / Claude call / determinism (temperature 0, day-stable session context, cached Tiingo enrichment).
- The fill-save write path (`updateUserFills`) — confirmed working on the VPS (GLNG 51.45 persisted). Reuse it; do not rewrite it.
- The re-hydration read route (`/api/jack-decisions` → `getUserMarksForSetups`) — reuse it.
- The `isPersistenceAvailable()` guard.
- The SQLite schema — write existing columns; no schema changes.
- The outcome tracker / replay logic.

If any of these appear to need changing to make the UI work, STOP and flag it — don't silently modify working logic to fit a presentation change.

---

## 5. Design questions to confirm before coding (batch)

1. **Default expanded state** — expand nothing by default (fully scannable), or auto-expand LIVE rows only? Recommend: all collapsed by default; user expands what they want. Confirm.
2. **Re-mark upsert** — confirm the write route should UPDATE the existing `user_action`/decision per setup rather than INSERT a new row (fixing the duplicate-GLNG behavior). This is a small write-route change — is it in scope for v2, or a separate fix? Recommend in-scope (it's part of making the data C-clean).
3. **Keep a raw/markdown fallback?** — some users want the full markdown output for copy/paste. Keep a "Copy" or raw-view toggle, or fully replace markdown with rows? Recommend: keep a Copy button for the raw text, but the rows are the primary surface.
4. **Pending fills** — Pending setups rarely have fills (not fired). Show the fill panel if a Pending row is somehow marked TRADED, or restrict fills to Live? Recommend: fills available whenever TRADED regardless of section (edge case, but consistent).

---

## 6. Constraints

- Branch `jack-ui-v2` off fresh `origin/main`; rebase before push.
- `git commit --no-verify`; npm only; `.npmrc` untouched.
- **No localStorage/sessionStorage** — React state only.
- Read the frontend-design skill; keep Bloomberg-terminal visual language.
- Presentation + input rewiring only — no logic changes (§4). Complete drop-in files. Atomic commits.

---

## 7. Self-test before reporting done

- Typecheck clean (ignore pre-existing `ai/route.ts`).
- **Data contract verified:** mark a Live row TRADED + fills → query DB, confirm `decisions.user_action='TRADED'` + `outcomes` fills landed. Mark another PASSED → confirm `user_action='PASSED'`. Leave one unmarked → confirm `user_action` stays NULL.
- **Re-mark is UPDATE not INSERT:** mark a setup, re-VALIDATE, re-mark it → confirm ONE marked decision per setup, not duplicates.
- **Re-hydration:** save fills, navigate away, return → row re-shows TRADED + fills.
- **No horizontal scroll / no char-wrap** anywhere in the decision surface (the whole point).
- Layout + real save→leave→return flow can only be fully confirmed on the VPS — note that in the report; verify the data paths locally.

---

## 8. Methodology reminder

This UI exists to make the *input* to Session C trustworthy: clean per-setup actions, correct NULL-vs-PASSED, no duplicate marks, real fills. A prettier surface that writes ambiguous or duplicated data is worse than the ugly one. The redesign's job is disciplined, unambiguous capture — the data model (which Session C reads) is the point; the UI is how you feed it without errors.
