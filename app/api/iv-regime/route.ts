import { type NextRequest, NextResponse } from "next/server";

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL!;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
const CACHE_TTL = 3600; // 1 hour — VIX closes daily, no need to refetch faster
const YF_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const YF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ── Redis helpers (envelope-safe) ─────────────────────────────────────────────
async function redisGet(key: string) {
  const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    cache: "no-store",
  });
  const data = await res.json();
  if (!data.result) return null;
  try {
    const parsed = JSON.parse(data.result);
    if (
      parsed && typeof parsed === "object" &&
      "value" in parsed && "ex" in parsed &&
      !("regime" in parsed) && !("ivRank" in parsed)
    ) {
      console.log(`Legacy envelope detected for ${key}, ignoring cached value`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: object, ttl: number) {
  const res = await fetch(`${UPSTASH_URL}/set/${key}?EX=${ttl}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "text/plain",
    },
    body: JSON.stringify(value),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    console.log(`Redis SET ${key} failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

// ── Yahoo Finance ─────────────────────────────────────────────────────────────
async function fetchYahooCloses(symbol: string): Promise<number[] | null> {
  const url = `${YF_BASE}/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": YF_UA, Accept: "application/json" },
    });
    if (!res.ok) {
      console.log(`Yahoo fetch ${symbol} failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) {
      console.log(`Yahoo ${symbol}: no close series in response`);
      return null;
    }
    // Drop nulls (holidays / pre-listing) and return chronological order
    return closes.filter((v: unknown): v is number => typeof v === "number" && Number.isFinite(v));
  } catch (e) {
    console.log(`Yahoo fetch ${symbol} threw:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// ── Computations ──────────────────────────────────────────────────────────────
function computeIVRank(closes: number[]): { rank: number; pct: number; sampleSize: number } {
  // Use the last 252 closes (or all if fewer). The most recent close is the "current".
  const window = closes.slice(-252);
  const sampleSize = window.length;
  const current = window[window.length - 1];
  const historical = window.slice(0, -1);
  if (historical.length === 0) return { rank: 50, pct: 50, sampleSize };

  const lo = Math.min(...historical);
  const hi = Math.max(...historical);
  const rank = hi > lo ? ((current - lo) / (hi - lo)) * 100 : 50;
  const belowCurrent = historical.filter((v) => v < current).length;
  const pct = (belowCurrent / historical.length) * 100;

  return {
    rank: Math.max(0, Math.min(100, rank)),
    pct: Math.max(0, Math.min(100, pct)),
    sampleSize,
  };
}

function classifyTermStructure(ratio: number): "CONTANGO" | "FLAT" | "BACKWARDATION" {
  if (ratio < 0.95) return "CONTANGO";
  if (ratio > 1.05) return "BACKWARDATION";
  return "FLAT";
}

function classifyRegime(
  ivRank: number,
  termState: "CONTANGO" | "FLAT" | "BACKWARDATION",
): { regime: "LOW_CONTANGO" | "NORMAL" | "ELEVATED" | "PANIC"; confidence: number } {
  // PANIC: extreme IV or term inversion
  if (ivRank > 80 || termState === "BACKWARDATION") {
    const conf = termState === "BACKWARDATION" ? 0.92 : Math.min(0.92, 0.6 + (ivRank - 80) / 100);
    return { regime: "PANIC", confidence: conf };
  }
  // ELEVATED: high IV but no inversion yet
  if (ivRank > 60) {
    return { regime: "ELEVATED", confidence: 0.5 + (ivRank - 60) / 80 };
  }
  // LOW_CONTANGO: depressed IV in contango — premium-selling tailwind
  if (ivRank < 30 && termState === "CONTANGO") {
    return { regime: "LOW_CONTANGO", confidence: 0.6 + (30 - ivRank) / 100 };
  }
  // NORMAL: middle ground
  return { regime: "NORMAL", confidence: 0.55 };
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const refresh = req.nextUrl.searchParams.has("refresh");
    if (!refresh) {
      const cached = await redisGet("iv:regime");
      if (cached) return NextResponse.json({ ...cached, fromCache: true });
    }

    console.log("Computing IV regime from VIX/VIX3M/VIX9D...");

    const [vixCloses, vix3mCloses, vix9dCloses] = await Promise.all([
      fetchYahooCloses("^VIX"),
      fetchYahooCloses("^VIX3M"),
      fetchYahooCloses("^VIX9D"),
    ]);

    if (!vixCloses || vixCloses.length < 30) {
      return NextResponse.json(
        { error: "VIX data unavailable from Yahoo (need >= 30 daily closes)" },
        { status: 503 },
      );
    }

    const vix = vixCloses[vixCloses.length - 1];
    const vix3m = vix3mCloses?.[vix3mCloses.length - 1] ?? null;
    const vix9d = vix9dCloses?.[vix9dCloses.length - 1] ?? null;

    // Pick term-structure long leg: VIX3M preferred, VIX9D fallback
    let longLeg: number | null = null;
    let termStructureSource: "VIX3M" | "VIX9D" | "NONE" = "NONE";
    if (vix3m && vix3m > 0) {
      longLeg = vix3m;
      termStructureSource = "VIX3M";
    } else if (vix9d && vix9d > 0) {
      longLeg = vix9d;
      termStructureSource = "VIX9D";
    }

    const termStructureRatio = longLeg ? vix / longLeg : 1.0;
    const termStructureState = classifyTermStructure(termStructureRatio);

    const { rank: ivRank, pct: ivPercentile, sampleSize } = computeIVRank(vixCloses);
    const { regime, confidence } = classifyRegime(ivRank, termStructureState);

    const degraded = sampleSize < 252 || termStructureSource !== "VIX3M";

    const result = {
      schemaVersion: "1.0" as const,
      timestamp: new Date().toISOString(),
      vix: Math.round(vix * 100) / 100,
      vix3m: vix3m !== null ? Math.round(vix3m * 100) / 100 : null,
      vix9d: vix9d !== null ? Math.round(vix9d * 100) / 100 : null,
      termStructureRatio: Math.round(termStructureRatio * 1000) / 1000,
      termStructureSource,
      termStructureState,
      ivRank: Math.round(ivRank * 10) / 10,
      ivPercentile: Math.round(ivPercentile * 10) / 10,
      regime,
      confidence: Math.round(confidence * 100) / 100,
      sampleSize,
      degraded,
    };

    try {
      await redisSet("iv:regime", result, CACHE_TTL);
    } catch (e) {
      console.log("IV regime cache write failed:", e);
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.log("IV regime route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
