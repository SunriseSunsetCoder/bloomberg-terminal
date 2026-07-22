import { useMutation } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect } from "react";
import { jackResultAtom, jackIsPendingAtom } from "@/components/bloomberg/atoms";

export interface SectionStats {
  inputCount: number;
  droppedHandleStale: number;
  droppedOverCap: number;
  finalCount: number;
}

export interface FilterStats {
  inputRowCount: number;
  live: SectionStats;
  pending: SectionStats;
  totalFinal: number;
  tiingoCallsAttempted: number;
  tiingoCallsSucceeded: number;
}

export interface JackDecisionClient {
  decisionId: number | null;
  setupId: number | null;
  ticker: string;
  handleLowDate: string;
  section: "live" | "pending" | "open";
  decision: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  // v2 expandable-row content (plumbed from the JSON decision + enriched data).
  shares: number | null;
  breakout: number | null;
  currentPrice: number | null;
  note: string | null;
  newsClass: string | null;
  sectorRs: string | null;
  crossAsset: string | null;
  earningsFlag: string | null;
  pctToBreakout: number | null;
  // Bug A re-hydration: existing user marks for this setup, so re-VALIDATE
  // re-displays them instead of blank rows.
  userAction: "TRADED" | "PASSED" | "WATCHED" | null;
  userEntryPrice: number | null;
  userEntryDate: string | null;
  userExitPrice: number | null;
  userExitDate: string | null;
  // Frozen decision-time context (marked rows only).
  jackDecisionAtMark: string | null;
  sharesAtMark: number | null;
  // ---- handle_score signal (recommendation; the user decides + sizes) ----
  handleScore?: number | null;
  sizeBucket?: "full" | "half" | "skip" | null;
  // ---- scanner classification columns (setup-level, from the weekly CSV) ----
  sector?: string | null; // GICS sector name
  tier?: string | null; // handle quintile Q3/Q4/Q5
  priority?: number | null; // rank, higher = take first (drives the LIVE sort)
  // ---- handle/cup geometry (parsed; shown in the expand's SETUP GEOMETRY line) ----
  cupDepthPct?: number | null;
  handleRetrPct?: number | null;
  daysSinceHandleLow?: number | null;
  fullShares?: number | null;
  fullNotional?: number | null;
  halfShares?: number | null;
  halfNotional?: number | null;
  recShares?: number | null;
  recNotional?: number | null;
  // ---- Open-position management (section "open" only; undefined elsewhere) ----
  // PART A: frozen entry THESIS text ("why I entered"), immutable.
  jackAnalysisAtMark?: string | null;
  // PART B: fast rules-based numbers + at-a-glance marker (from current price).
  unrealizedPct?: number | null;
  daysHeld?: number | null;
  rulesFlag?: string | null;
  rulesTone?: "danger" | "warn" | "good" | "neutral" | null;
  // PART C: live LLM position re-read — updates each run, prominent. NOT a
  // trade/skip verdict; a HOLD/EXIT/REDUCE call on the open position.
  liveReadVerdict?: "HOLD" | "EXIT" | "REDUCE" | "UNKNOWN" | null;
  liveReadThesisStatus?: string | null;
  liveReadReasoning?: string | null;
}

export interface JackValidationResponse {
  schemaVersion: "1.2";
  timestamp: string;
  strategy: string;
  riskPerTrade: number;
  markdown: string;
  model: string;
  inputRowCount: number;
  filterStats: FilterStats;
  tokens?: { input: number; output: number };
  degraded?: boolean;
  error?: string | null;
  // Session B — interactive decision rows + persistence availability flag.
  decisions?: JackDecisionClient[];
  persistenceAvailable?: boolean;
}

export interface JackValidationRequest {
  csv: string;
  riskPerTrade?: number;
}

async function postValidation(
  body: JackValidationRequest
): Promise<JackValidationResponse> {
  const res = await fetch("/api/jack-validation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as JackValidationResponse;
}

/**
 * useJackValidation
 *
 * Wraps React Query's useMutation and mirrors the result into a Jotai atom
 * so it persists across view navigation (e.g., user clicks BACK to market
 * view then returns to JACK — the prior result is still there).
 *
 * Returns:
 *   - mutate / mutateAsync: trigger a validation run
 *   - data: the latest result, sourced from atom (survives unmount)
 *   - isPending: true while a request is in flight
 *   - reset: clear both the mutation cache AND the atom
 */
export function useJackValidation() {
  const [persistedResult, setPersistedResult] = useAtom(jackResultAtom);
  const [, setPersistedPending] = useAtom(jackIsPendingAtom);

  const mutation = useMutation<JackValidationResponse, Error, JackValidationRequest>({
    mutationFn: postValidation,
    onSuccess: (data) => {
      setPersistedResult(data);
    },
  });

  // Mirror in-flight state into the atom so a remounted component can show
  // the spinner if a request is still pending elsewhere.
  useEffect(() => {
    setPersistedPending(mutation.isPending);
  }, [mutation.isPending, setPersistedPending]);

  return {
    ...mutation,
    // Prefer the persisted atom value over the mutation's own data field —
    // mutation.data resets to undefined on unmount; persistedResult survives.
    data: persistedResult ?? mutation.data,
    reset: () => {
      mutation.reset();
      setPersistedResult(null);
    },
  };
}
