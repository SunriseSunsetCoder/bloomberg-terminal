// =============================================================================
// US market hours — PURE, DST-safe. All wall-clock via Intl in America/New_York,
// so "10:00 ET" / "18:00 ET" / "09:30–16:00" are correct in EST or EDT without any
// fixed-UTC assumption. Weekends + NYSE holidays are skipped. Unit-testable.
// =============================================================================

// NYSE full-closure holidays (YYYY-MM-DD, ET). "If-easy" set — erring toward FEWER
// entries is the safe failure: a missed holiday just means a refresh runs on a
// closed day (IEX/EOD return the last close, outcomes no-op) — harmless. Extend as
// years roll over (half-day early closes are intentionally NOT here — see spec).
export const NYSE_HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed; Jul 4 is a Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26", // Good Friday
  "2027-05-31",
  "2027-06-18", // Juneteenth (observed; Jun 19 is a Saturday)
  "2027-07-05", // Independence Day (observed; Jul 4 is a Sunday)
  "2027-09-06",
  "2027-11-25",
  "2027-12-24", // Christmas (observed; Dec 25 is a Saturday)
]);

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface EtParts {
  dateISO: string; // YYYY-MM-DD (ET)
  weekday: number; // 0=Sun … 6=Sat
  hour: number; // 0-23 (ET wall-clock)
  minute: number; // 0-59
}

/** ET wall-clock parts of `now` (DST-safe via Intl). */
export function etParts(now: Date = new Date()): EtParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    dateISO: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/** ET calendar date, YYYY-MM-DD (matches positionEtDay's format). */
export function etDateISO(now: Date = new Date()): string {
  return etParts(now).dateISO;
}

/** A trading day = Mon–Fri (ET) and not a NYSE holiday. */
export function isTradingDay(now: Date = new Date()): boolean {
  const p = etParts(now);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return !NYSE_HOLIDAYS.has(p.dateISO);
}

/**
 * Is the US equity market in a regular session right now? Trading day AND
 * 09:30 ≤ ET < 16:00. (Half-day early closes are not special-cased — see spec: on
 * those ~3 days/yr the last print is already the close, so intraday is harmless.)
 */
export function isMarketOpen(now: Date = new Date()): boolean {
  if (!isTradingDay(now)) return false;
  const { hour, minute } = etParts(now);
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}
