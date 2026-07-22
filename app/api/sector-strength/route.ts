import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import {
  computeSectorBoard,
  SECTOR_UNIVERSE,
  SECTOR_BASELINE,
  type SectorBoard,
} from "@/lib/sector-strength";

export const maxDuration = 30; // 12 parallel Tiingo EOD fetches on a cold cache
export const dynamic = "force-dynamic";

// Tiingo + Redis only (no better-sqlite3) → works on Vercel AND the VPS, unlike
// the DB-backed JACK routes. No isPersistenceAvailable guard needed.
const REDIS_KEY = "sector_strength";
const TTL_SECONDS = 3600; // 1-hour result cache — EOD data changes once/day
const WINDOW_DAYS = 130; // ≥ 63 trading bars for the 3-month lookback, with buffer

export interface SectorStrengthResponse extends SectorBoard {
  ok: boolean;
  generatedAt: string;
  source: "cache" | "tiingo";
  error?: string;
}

interface EodPayload {
  bars?: Array<{ close: number }>;
  error?: string;
}

function baseUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

// Fetch one ticker's closes via the existing internal EOD proxy (benefits from its
// own 8-hr fetch cache). A failure returns [] so that ticker's metrics go null and
// it sinks to the bottom — never throws.
async function fetchCloses(base: string, ticker: string): Promise<number[]> {
  try {
    const res = await fetch(`${base}/api/tiingo/eod/${ticker}?days=${WINDOW_DAYS}`);
    if (!res.ok) return [];
    const data = (await res.json()) as EodPayload;
    if (data.error || !Array.isArray(data.bars)) return [];
    return data.bars.map((b) => b.close).filter((c): c is number => Number.isFinite(c));
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  // 1. Serve the cached board if present (TTL handles staleness).
  try {
    const cached = (await redis.get(REDIS_KEY)) as SectorStrengthResponse | null;
    if (cached && Array.isArray(cached.sectors)) {
      return NextResponse.json<SectorStrengthResponse>({ ...cached, source: "cache" });
    }
  } catch {
    // Redis unavailable → fall through and compute fresh.
  }

  // 2. Cold cache: fetch all tickers (11 sectors + SPY) in parallel, compute, cache.
  const base = baseUrl(req);
  const tickers = [...SECTOR_UNIVERSE.map((s) => s.ticker), SECTOR_BASELINE];
  try {
    const closeLists = await Promise.all(tickers.map((t) => fetchCloses(base, t)));
    const closesByTicker: Record<string, number[]> = {};
    tickers.forEach((t, i) => {
      closesByTicker[t] = closeLists[i];
    });

    const board = computeSectorBoard(closesByTicker);
    const payload: SectorStrengthResponse = {
      ok: true,
      generatedAt: new Date().toISOString(),
      source: "tiingo",
      ...board,
    };

    try {
      await redis.set(REDIS_KEY, payload, { ex: TTL_SECONDS });
    } catch {
      // Non-fatal — still return the freshly computed board.
    }

    return NextResponse.json<SectorStrengthResponse>(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<SectorStrengthResponse>(
      {
        ok: false,
        generatedAt: new Date().toISOString(),
        source: "tiingo",
        spy: null,
        sectors: [],
        rsAvailable: false,
        error: msg,
      },
      { status: 502 }
    );
  }
}
