import { type NextRequest, NextResponse } from "next/server";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL!;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
const CACHE_TTL = 60; // 60s per ticker

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
      !("strategy" in parsed) && !("regime" in parsed)
    ) return null;
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

// ── Internal IV regime fetch (calls our own route) ────────────────────────────
async function getIVRegime(origin: string) {
  const cached = await redisGet("iv:regime");
  if (cached) return cached;
  // Fallback: trigger the route to compute fresh
  const res = await fetch(`${origin}/api/iv-regime`, { cache: "no-store" });
  if (!res.ok) return null;
  return await res.json();
}

// ── Claude options playbook ───────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a systematic options strategist advising a quantitative trader. You output ONLY valid JSON, no markdown, no preamble.

Your job: given an IV regime snapshot, recommend a single primary options strategy with strike-selection rules and DTE band.

Academic anchors:
- LOW_CONTANGO (IV Rank <30, contango): premium decay favors short vol. Bollen-Whaley (2004) variance risk premium is positive in contango → sell premium. Strategies: short strangle, iron condor, covered call.
- NORMAL: balanced. Defined-risk premium selling (iron condors, credit spreads) at reasonable deltas.
- ELEVATED (IV Rank 60-80): high but no panic. Reduce size, defined risk only, shorter DTE to reduce gamma exposure.
- PANIC (IV Rank >80 OR backwardation): vol-of-vol blow-up risk. Buy premium or stay flat. Long puts, long strangles, calendar spreads (long vega). Never naked short vol.

Output schema (STRICT):
{
  "strategy": "<short strategy name, e.g. 'Short Iron Condor' or 'Long Put'>",
  "direction": "SHORT_VOL" | "LONG_VOL" | "NEUTRAL_VOL" | "DIRECTIONAL",
  "strikeRule": "<concrete strike selection, e.g. '15-delta short legs, 5-delta long legs'>",
  "dteBand": "<DTE range, e.g. '21-45 DTE'>",
  "sizing": "<size guidance, e.g. 'half normal' or 'standard'>",
  "rationale": "<one sentence tying strategy to regime metrics>",
  "regimeFit": "STRONG" | "MODERATE" | "WEAK",
  "warnings": ["<optional warning strings>"]
}`;

async function callClaude(regime: Record<string, unknown>, ticker: string) {
  const userMsg = `Ticker: ${ticker}
IV regime snapshot:
${JSON.stringify(regime, null, 2)}

Recommend the single best options strategy for this regime. Output JSON only.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("Anthropic returned no text content");

  // Strip any accidental markdown fences and parse
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const ticker = (req.nextUrl.searchParams.get("ticker") || "SPY").toUpperCase();
    const refresh = req.nextUrl.searchParams.has("refresh");
    const cacheKey = `options-signal:${ticker}`;

    if (!refresh) {
      const cached = await redisGet(cacheKey);
      if (cached) return NextResponse.json({ ...cached, fromCache: true });
    }

    const origin = req.nextUrl.origin;
    const regime = await getIVRegime(origin);
    if (!regime || regime.error) {
      return NextResponse.json(
        { error: "IV regime unavailable", details: regime?.error },
        { status: 503 },
      );
    }

    let signal;
    try {
      signal = await callClaude(regime, ticker);
    } catch (e) {
      // Graceful degrade: return regime alone if Claude call fails
      console.log("Claude signal call failed:", e instanceof Error ? e.message : e);
      return NextResponse.json(
        {
          ticker,
          regime,
          signal: null,
          error: "Strategy generation failed",
          details: e instanceof Error ? e.message : String(e),
        },
        { status: 200 },
      );
    }

    const result = {
      ticker,
      timestamp: new Date().toISOString(),
      regime,
      signal,
      // For single-name tickers other than SPY/QQQ, flag that VIX is an approximation
      ivProxyNote:
        ticker === "SPY" || ticker === "QQQ"
          ? null
          : "VIX used as IV proxy — single-name IV may diverge significantly",
    };

    try {
      await redisSet(cacheKey, result, CACHE_TTL);
    } catch (e) {
      console.log("Options signal cache write failed:", e);
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.log("Options signal route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
