import { type NextRequest, NextResponse } from "next/server";

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL!;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
const STALE_THRESHOLD_SECONDS = 300;

async function redisGet(key: string) {
  const url = `${UPSTASH_URL}/get/${key}`;
  console.log("Redis GET URL:", url.replace(UPSTASH_URL, "[UPSTASH]"));
  
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  console.log("Redis response status:", res.status);

  if (!res.ok) {
    const text = await res.text();
    console.log("Redis error body:", text);
    throw new Error(`Redis GET failed: ${res.status}`);
  }

  const data = await res.json();
  console.log("Redis result type:", typeof data.result, "value:", data.result ? "present" : "null");

  if (data.result === null || data.result === undefined) return null;

  try {
    return JSON.parse(data.result);
  } catch {
    return data.result;
  }
}

export async function GET(req: NextRequest) {
  try {
    console.log("Fleet route hit");
    const fleet = await redisGet("fleet:state");
    console.log("Fleet data:", fleet ? "found" : "not found");

    if (!fleet) {
      return NextResponse.json(
        { error: "No fleet data available", stale: true },
        { status: 404 }
      );
    }

    const lastUpdate = new Date(fleet.timestamp);
    const ageSeconds = (Date.now() - lastUpdate.getTime()) / 1000;
    const isStale = ageSeconds > STALE_THRESHOLD_SECONDS;

    return NextResponse.json({
      ...fleet,
      meta: {
        ageSeconds: Math.round(ageSeconds),
        isStale,
        retrievedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.log("Fleet route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}