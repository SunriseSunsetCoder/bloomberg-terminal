-- =============================================================================
-- JACK persistence schema v1.0
-- =============================================================================

CREATE TABLE IF NOT EXISTS setups (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker                TEXT    NOT NULL,
    handle_low_date       TEXT    NOT NULL,
    signal_date           TEXT,
    first_seen_at         TEXT    NOT NULL,
    last_seen_at          TEXT    NOT NULL,
    first_seen_status     TEXT    NOT NULL,
    last_seen_status      TEXT    NOT NULL,
    entry                 REAL,
    stop                  REAL,
    t05_target            REAL,
    breakout_level        REAL,
    cup_depth_pct         REAL,
    handle_retr_pct       REAL,
    -- Watchlist retirement: set when a later weekly scan no longer carries this
    -- setup, so a stale idea drops out of the pending set (and therefore out of
    -- alerts). NULL = live on the watchlist. Cleared again if the setup returns in
    -- a later scan. NEVER set on a setup that was ever marked TRADED — see
    -- retireSupersededSetups in lib/db/write.ts.
    retired_at            TEXT,
    retired_reason        TEXT,
    CHECK (first_seen_status IN ('just_fired', 'pending', 'recent_breakout', 'unknown')),
    CHECK (last_seen_status  IN ('just_fired', 'pending', 'recent_breakout', 'unknown')),
    UNIQUE (ticker, handle_low_date)
);

CREATE INDEX IF NOT EXISTS idx_setups_ticker           ON setups(ticker);
CREATE INDEX IF NOT EXISTS idx_setups_handle_low_date  ON setups(handle_low_date);
CREATE INDEX IF NOT EXISTS idx_setups_last_seen        ON setups(last_seen_at);

CREATE TABLE IF NOT EXISTS validation_runs (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp                TEXT    NOT NULL,
    input_row_count          INTEGER NOT NULL,
    total_final_count        INTEGER NOT NULL,
    live_final_count         INTEGER NOT NULL,
    pending_final_count      INTEGER NOT NULL,
    live_dropped_stale       INTEGER NOT NULL,
    pending_dropped_stale    INTEGER NOT NULL,
    live_dropped_over_cap    INTEGER NOT NULL,
    pending_dropped_over_cap INTEGER NOT NULL,
    tiingo_attempted         INTEGER NOT NULL,
    tiingo_succeeded         INTEGER NOT NULL,
    risk_per_trade           REAL    NOT NULL,
    tokens_input             INTEGER,
    tokens_output            INTEGER,
    model                    TEXT,
    raw_markdown             TEXT,
    parse_success            INTEGER NOT NULL DEFAULT 0,
    error_msg                TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON validation_runs(timestamp);

CREATE TABLE IF NOT EXISTS decisions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    setup_id              INTEGER NOT NULL REFERENCES setups(id),
    validation_run_id     INTEGER NOT NULL REFERENCES validation_runs(id),
    section               TEXT    NOT NULL,
    decision              TEXT    NOT NULL,
    shares                INTEGER,
    notional              REAL,
    earnings_flag         TEXT,
    live_close_delta_pct  REAL,
    pct_to_breakout       REAL,
    news_class            TEXT,
    sector_rs             TEXT,
    cross_asset           TEXT,
    notes                 TEXT,
    user_action           TEXT,
    user_action_at        TEXT,
    user_notes            TEXT,
    -- JACK's verdict FROZEN at the moment the user marked this decision. JACK
    -- re-validates fresh each run, so its live `decision` can flip after a mark;
    -- this preserves the decision-time context Session C needs (additive; NULL
    -- until the row is marked).
    jack_decision_at_mark TEXT,
    CHECK (section IN ('live', 'pending')),
    CHECK (user_action IS NULL OR user_action IN ('TRADED', 'PASSED', 'WATCHED'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_setup       ON decisions(setup_id);
CREATE INDEX IF NOT EXISTS idx_decisions_run         ON decisions(validation_run_id);
CREATE INDEX IF NOT EXISTS idx_decisions_decision    ON decisions(decision);
CREATE INDEX IF NOT EXISTS idx_decisions_user_action ON decisions(user_action);

CREATE TABLE IF NOT EXISTS outcomes (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    setup_id              INTEGER NOT NULL UNIQUE REFERENCES setups(id),
    fired                 INTEGER NOT NULL,
    fire_date             TEXT,
    entry_price_actual    REAL,
    entry_date_actual     TEXT,
    exit_price            REAL,
    exit_date             TEXT,
    exit_reason           TEXT,
    R_realized            REAL,
    max_favorable_pct     REAL,
    max_adverse_pct       REAL,
    -- Session B (v1.4): user-fill columns. These are the EXECUTION-quality numbers
    -- (what the trader actually got), kept alongside the theoretical replay columns
    -- above (what the setup offered). One outcomes row per setup carries both.
    -- theoretical R (R_realized) vs user_R_realized answers
    -- "was the setup good?" vs "did I trade it well?".
    user_entry_price      REAL,
    user_entry_date       TEXT,
    user_exit_price       REAL,
    user_exit_date        TEXT,
    user_R_realized       REAL,
    outcome_computed_at   TEXT NOT NULL,
    outcome_source        TEXT NOT NULL,
    CHECK (fired IN (0, 1)),
    CHECK (exit_reason IS NULL OR exit_reason IN ('target', 'stop', 'timeout', 'still_open', 'never_fired'))
);

CREATE INDEX IF NOT EXISTS idx_outcomes_setup       ON outcomes(setup_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_exit_reason ON outcomes(exit_reason);
CREATE INDEX IF NOT EXISTS idx_outcomes_fired       ON outcomes(fired);

CREATE VIEW IF NOT EXISTS decision_outcomes AS
SELECT
    d.id                     AS decision_id,
    s.ticker,
    s.handle_low_date,
    d.section,
    d.decision,
    d.shares,
    d.notional,
    d.news_class,
    d.notes,
    d.user_action,
    r.timestamp              AS run_timestamp,
    o.fired,
    o.fire_date,
    o.exit_reason,
    o.R_realized,
    o.outcome_computed_at,
    CASE WHEN r.timestamp = s.first_seen_at THEN 1 ELSE 0 END AS is_first_appearance
FROM decisions d
JOIN setups s           ON d.setup_id = s.id
JOIN validation_runs r  ON d.validation_run_id = r.id
LEFT JOIN outcomes o    ON o.setup_id = s.id;
