import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect } from "react";
import { jackResultAtom } from "@/components/bloomberg/atoms";
import type { JackDecisionClient, JackValidationResponse } from "./useJackValidation";

/**
 * useJackBoard — hydrate the board from SQLite when the client has none.
 *
 * WHY
 *
 * The board used to exist in exactly one place: the JSON body of the VALIDATE
 * POST, mirrored into jackResultAtom (a plain, in-memory Jotai atom). That is
 * fine when a human presses the button — the browser receives the response.
 *
 * It fails for the nightly pipeline. pipeline/ingest.py POSTs the same CSV to
 * the same endpoint from the VPS: the run persists and becomes the current run,
 * but the response goes to a Python process. The atom stays null, so the
 * terminal shows the empty "paste scanner CSV" state while the board sits
 * complete in jack.db. This hook asks the server for it instead.
 *
 * PRECEDENCE — a live VALIDATE always wins.
 *
 * The fetch is `enabled` only while the atom is empty, and the write-back is
 * guarded again at commit time. So pressing VALIDATE behaves exactly as it does
 * today: its response lands in the atom, this query stops running, and a
 * hydrated board can never overwrite a fresher one. Hydration fills the empty
 * state and nothing else.
 *
 * It also fixes the refresh-wipe, which was a real bug independent of the
 * pipeline — the board vanished on F5 and everyone just re-pasted.
 */

export interface JackBoardResponse {
  runId: number | null;
  decisions: JackDecisionClient[];
  riskPerTrade: number;
  runTimestamp: string | null;
  persistenceAvailable: boolean;
  hydrated: boolean;
  error?: string;
}

async function fetchBoard(): Promise<JackBoardResponse> {
  const res = await fetch("/api/jack-board", { cache: "no-store" });
  return (await res.json()) as JackBoardResponse;
}

/**
 * Shape a hydrated board into the SAME response object a VALIDATE produces, so
 * jack-view has exactly one render path and cannot drift between the two.
 */
function toValidationResponse(board: JackBoardResponse): JackValidationResponse {
  const live = board.decisions.filter((d) => d.section === "live").length;
  const pending = board.decisions.filter((d) => d.section === "pending").length;
  const zero = { inputCount: 0, droppedHandleStale: 0, droppedOverCap: 0, finalCount: 0 };

  return {
    schemaVersion: "1.2",
    timestamp: board.runTimestamp ?? new Date().toISOString(),
    strategy: "Cup with Handle t05",
    riskPerTrade: board.riskPerTrade,
    // No markdown is stored per-run in a readable form, and inventing one would
    // be worse than saying plainly where this board came from.
    markdown:
      `> **Board restored from the database** (run #${board.runId}` +
      (board.runTimestamp ? ` · ${board.runTimestamp}` : "") +
      `).\n> Levels, tier, size bucket, handle score, entry status, fired state and ` +
      `the stored analysis notes are all live. Re-run VALIDATE for a fresh ` +
      `analysis pass.\n\n`,
    model: "restored",
    inputRowCount: board.decisions.length,
    filterStats: {
      inputRowCount: board.decisions.length,
      live: { ...zero, inputCount: live, finalCount: live },
      pending: { ...zero, inputCount: pending, finalCount: pending },
      totalFinal: board.decisions.length,
      tiingoCallsAttempted: 0,
      tiingoCallsSucceeded: 0,
    },
    decisions: board.decisions,
    persistenceAvailable: board.persistenceAvailable,
    degraded: false,
    error: board.error ?? null,
  };
}

export function useJackBoard() {
  const [result, setResult] = useAtom(jackResultAtom);
  const hasBoard = (result?.decisions?.length ?? 0) > 0;

  const query = useQuery({
    queryKey: ["jack-board"],
    queryFn: fetchBoard,
    // Only ask when the client has nothing. A VALIDATE response disables this.
    enabled: !hasBoard,
    staleTime: 1000 * 60,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!query.data) return;
    if (query.data.runId === null || query.data.decisions.length === 0) return;
    // Re-check at commit time: a VALIDATE may have landed while this was in
    // flight, and a hydrated board must never clobber a fresher one.
    setResult((current) =>
      (current?.decisions?.length ?? 0) > 0 ? current : toValidationResponse(query.data)
    );
  }, [query.data, setResult]);

  return {
    isHydrating: query.isLoading && !hasBoard,
    hydrationError: query.data?.error ?? (query.error ? String(query.error) : null),
  };
}
