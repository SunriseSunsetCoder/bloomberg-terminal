import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const TIINGO_BASE = "https://api.tiingo.com/tiingo/daily";

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface EodResponse {
  ticker: string;
  bars: Bar[];
  latestClose?: number;
  latestDate?: string;
  source: "tiingo" | "cache";
  error?: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker: rawTicker } = await params;
  const ticker = rawTicker.toUpperCase();
  const { searchParams } = new URL(req.url);
  const days = parseInt(searchParams.get("days") ?? "30", 10);

  const token = process.env.TIINGO_API_KEY;
  if (!token) {
    return NextResponse.json<EodResponse>(
      { ticker, bars: [], source: "tiingo", error: "TIINGO_API_KEY not set" },
      { status: 500 }
    );
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  const url = `${TIINGO_BASE}/${ticker}/prices?startDate=${fmt(startDate)}&endDate=${fmt(endDate)}&format=json`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
      next: { revalidate: 28800 }, // 8hr cache — daily data doesn't change intraday
    });

    if (!res.ok) {
      return NextResponse.json<EodResponse>(
        {
          ticker,
          bars: [],
          source: "tiingo",
          error: `Tiingo returned ${res.status}`,
        },
        { status: res.status }
      );
    }

    const data = (await res.json()) as Array<{
      date: string;
      adjOpen: number;
      adjHigh: number;
      adjLow: number;
      adjClose: number;
      adjVolume: number;
    }>;

    const bars: Bar[] = data.map((d) => ({
      date: d.date.split("T")[0],
      open: d.adjOpen,
      high: d.adjHigh,
      low: d.adjLow,
      close: d.adjClose,
      volume: d.adjVolume,
    }));

    const latest = bars.length > 0 ? bars[bars.length - 1] : null;

    return NextResponse.json<EodResponse>({
      ticker,
      bars,
      latestClose: latest?.close,
      latestDate: latest?.date,
      source: "tiingo",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<EodResponse>(
      { ticker, bars: [], source: "tiingo", error: msg },
      { status: 502 }
    );
  }
}
