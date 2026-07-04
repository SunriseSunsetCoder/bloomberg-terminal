import { type NextRequest, NextResponse } from "next/server";

const AV_KEY = process.env.ALPHA_VANTAGE_API_KEY!;
const AV_BASE = "https://www.alphavantage.co/query";
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL!;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
const CACHE_TTL = 300; // 5 minutes

// ── Redis helpers ─────────────────────────────────────────────────────────────
async function redisGet(key: string) {
  const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    cache: "no-store",
  });
  const data = await res.json();
  if (!data.result) return null;
  try {
    const parsed = JSON.parse(data.result);
    // Defensive: detect legacy envelope shape from prior broken writes and reject
    // so callers fall through to recompute instead of returning garbage.
    if (parsed && typeof parsed === "object" && "value" in parsed && "ex" in parsed && !("regimes" in parsed) && !("regime" in parsed)) {
      console.log(`Legacy envelope detected for ${key}, ignoring cached value`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: object, ttl: number) {
  // Upstash REST: POST /set/{key}?EX={seconds} with raw value as the body.
  // The previous {value, ex} envelope was being stored verbatim — this is the fix.
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

// ── Alpha Vantage daily OHLCV ─────────────────────────────────────────────────
async function fetchDailyOHLCV(symbol: string, days = 30) {
  const url = `${AV_BASE}?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=compact&apikey=${AV_KEY}`;
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();

  if (!data["Time Series (Daily)"]) {
    console.log(`No daily data for ${symbol}:`, JSON.stringify(data).slice(0, 200));
    return null;
  }

  const series = data["Time Series (Daily)"];
  const dates = Object.keys(series).sort().reverse().slice(0, days);

  return dates.map((date) => ({
    date,
    open: parseFloat(series[date]["1. open"]),
    high: parseFloat(series[date]["2. high"]),
    low: parseFloat(series[date]["3. low"]),
    close: parseFloat(series[date]["4. close"]),
    volume: parseFloat(series[date]["5. volume"]),
  }));
}

// ── Signal computations ───────────────────────────────────────────────────────
function computeATR(candles: ReturnType<typeof fetchDailyOHLCV> extends Promise<infer T> ? NonNullable<T> : never, period = 14) {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    trs.push(Math.max(hl, hc, lc));
  }

  // ATR as simple average of last `period` true ranges
  const recent = trs.slice(0, period);
  const currentATR = recent.reduce((a, b) => a + b, 0) / recent.length;

  // ATR percentile vs all computed TRs
  const sorted = [...trs].sort((a, b) => a - b);
  const rank = sorted.filter((v) => v <= currentATR).length / sorted.length;

  return { currentATR, atrPct: rank };
}

function computeADX(candles: ReturnType<typeof fetchDailyOHLCV> extends Promise<infer T> ? NonNullable<T> : never, period = 14) {
  if (candles.length < period + 2) return { adx: 20 };

  const dmPlus: number[] = [];
  const dmMinus: number[] = [];
  const trs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    trs.push(Math.max(hl, hc, lc));
  }

  // Smooth over period
  const smooth = (arr: number[]) => {
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const result = [sum];
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i];
      result.push(sum);
    }
    return result;
  };

  const sTR = smooth(trs);
  const sDMPlus = smooth(dmPlus);
  const sDMMinus = smooth(dmMinus);

  const diPlus = sDMPlus.map((v, i) => (sTR[i] ? (v / sTR[i]) * 100 : 0));
  const diMinus = sDMMinus.map((v, i) => (sTR[i] ? (v / sTR[i]) * 100 : 0));

  const dx = diPlus.map((v, i) => {
    const sum = v + diMinus[i];
    return sum ? (Math.abs(v - diMinus[i]) / sum) * 100 : 0;
  });

  const adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  return { adx, diPlus: diPlus[0], diMinus: diMinus[0] };
}

function computeRealizedVolRatio(candles: ReturnType<typeof fetchDailyOHLCV> extends Promise<infer T> ? NonNullable<T> : never) {
  const returns = candles.slice(0, 21).map((c, i) =>
    i === 0 ? 0 : Math.log(c.close / candles[i - 1].close)
  ).slice(1);

  const recent5 = returns.slice(0, 5);
  const all20 = returns.slice(0, 20);

  const vol = (arr: number[]) => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
  };

  const recentVol = vol(recent5);
  const baseVol = vol(all20);
  return baseVol > 0 ? recentVol / baseVol : 1;
}

// ── Regime classification ─────────────────────────────────────────────────────
function classifyRegime(atrPct: number, adx: number, volRatio: number, diPlus: number, diMinus: number) {
  // BREAKOUT: volatility expanding strongly
  if (atrPct > 0.80 && volRatio > 1.3) {
    return { regime: "BREAKOUT", confidence: Math.min(0.95, (atrPct + volRatio / 3) / 1.5) };
  }

  // TRENDING: strong ADX with directional bias
  if (adx > 25) {
    if (diPlus > diMinus) {
      return { regime: "TRENDING_UP", confidence: Math.min(0.95, adx / 50) };
    }
    return { regime: "TRENDING_DOWN", confidence: Math.min(0.95, adx / 50) };
  }

  // CHOPPY: low ADX, compressed vol
  if (adx < 20 && atrPct < 0.50) {
    return { regime: "CHOPPY", confidence: Math.min(0.90, (1 - adx / 30) * 0.8 + 0.1) };
  }

  // Mild trend
  if (adx >= 20 && adx <= 25) {
    if (diPlus > diMinus) {
      return { regime: "TRENDING_UP", confidence: 0.55 };
    }
    return { regime: "TRENDING_DOWN", confidence: 0.55 };
  }

  return { regime: "CHOPPY", confidence: 0.50 };
}

// ── Per-instrument classifier ─────────────────────────────────────────────────
async function classifyInstrument(symbol: string, label: string) {
  const candles = await fetchDailyOHLCV(symbol, 30);
  if (!candles || candles.length < 16) {
    return {
      schemaVersion: "1.0",
      timestamp: new Date().toISOString(),
      instrument: label,
      regime: "CHOPPY",
      confidence: 0.40,
      atrPct: 0.50,
      adx: 20,
      realizedVolRatio: 1.0,
      error: "Insufficient data",
    };
  }

  const { atrPct } = computeATR(candles);
  const { adx, diPlus = 20, diMinus = 20 } = computeADX(candles);
  const realizedVolRatio = computeRealizedVolRatio(candles);
  const { regime, confidence } = classifyRegime(atrPct, adx, realizedVolRatio, diPlus, diMinus);

  return {
    schemaVersion: "1.0",
    timestamp: new Date().toISOString(),
    instrument: label,
    proxy: symbol,
    regime,
    confidence: Math.round(confidence * 100) / 100,
    atrPct: Math.round(atrPct * 100) / 100,
    adx: Math.round(adx * 10) / 10,
    realizedVolRatio: Math.round(realizedVolRatio * 100) / 100,
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    // Check Redis cache first
    const cached = await redisGet("regime:all");
    if (cached && !req.nextUrl.searchParams.has("refresh")) {
      return NextResponse.json({ ...cached, fromCache: true });
    }

    console.log("Computing regime classifiers for ES (SPY) and NQ (QQQ)...");

    // Fetch both instruments — stagger to avoid rate limits
    const esRegime = await classifyInstrument("SPY", "ES");
    await new Promise((r) => setTimeout(r, 1000));
    const nqRegime = await classifyInstrument("QQQ", "NQ");

    const result = {
      timestamp: new Date().toISOString(),
      regimes: { ES: esRegime, NQ: nqRegime },
    };

    // Cache in Redis
    try {
      await redisSet("regime:all", result, CACHE_TTL);
      // Also write individual keys for CommandCenter to read (P11)
      await redisSet("regime:ES", esRegime, CACHE_TTL);
      await redisSet("regime:NQ", nqRegime, CACHE_TTL);
    } catch (e) {
      console.log("Redis cache write failed:", e);
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.log("Regime route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}