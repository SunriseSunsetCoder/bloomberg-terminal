# Futures Bots — Program State (top-level roll-up)

_Top of the state hierarchy. Business goal: build bots to run a futures trading business. This doc is a thin index — detail lives in the child docs. Last updated: 2026-07-23._

## Roll-up chain

```
Futures Bots (this doc)
└── Bloomberg terminal  →  bloomberg-terminal-state.md   (the research + execution product)
    └── JACK            →  jack-state.md                 (Cup-with-Handle t05 strategy module)
└── Fleet bots          →  (not yet captured — see fleet_bot_cheatsheet_v8_2.pdf)
```

## Components

**Bloomberg terminal** — the working product. A Bloomberg-terminal clone that surfaces validated swing setups, sizing, and outcome tracking. Fully live and iterated on. See `bloomberg-terminal-state.md`. Its flagship module, **JACK**, runs the Bulkowski Cup-with-Handle t05 strategy (PF 2.09 IS / 1.70 OOS) — see `jack-state.md`.

**Fleet bots** — the broader "bots to run the business" side. Reference material exists (`fleet_bot_cheatsheet_v8_2.pdf` in this project) but there is no state doc yet. TBD: when this work starts, add `fleet-bots-state.md` as a sibling and link it here.

## Status at a glance

JACK is live on the VPS, gathering outcome data. F1 (sector panel), F2 (setup detail), F3 (candle chart) all shipped and verified 2026-07-23. Selection logic is stable; next move is to let live outcomes accumulate before the next change. Fleet-bots work not yet started here.
