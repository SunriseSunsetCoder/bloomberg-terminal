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

  // Session B additions (all backward-compatible — `days` behaves as before when
  // these are absent):
  //   startDate=YYYY-MM-DD  explicit window start (overrides `days`). The outcome
  //                         tracker passes handle_low_date so it gets the full
  //                         post-setup history (≥90 trading days) for the replay.
  //   endDate=YYYY-MM-DD    explicit window end (defaults to today).
  //   raw=1                 return UNADJUSTED OHLC. The replay compares against
  //                         nominal breakout/stop/target price levels, so raw
  //                         (split/div-unadjusted) prices line up; the default
  //                         (adjusted) is kept for the enrichment callers.
  const startDateParam = searchParams.get("startDate");
  const endDateParam = searchParams.get("endDate");
  const useRaw = searchParams.get("raw") === "1";

  const token = process.env.TIINGO_API_KEY;
  if (!token) {
    return NextResponse.json<EodResponse>(
      { ticker, bars: [], source: "tiingo", error: "TIINGO_API_KEY not set" },
      { status: 500 }
    );
  }

  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const endStr = endDateParam ?? fmt(new Date());
  let startStr: string;
  if (startDateParam) {
    startStr = startDateParam;
  } else {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startStr = fmt(startDate);
  }

  const url = `${TIINGO_BASE}/${ticker}/prices?startDate=${startStr}&endDate=${endStr}&format=json`;

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
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      adjOpen: number;
      adjHigh: number;
      adjLow: number;
      adjClose: number;
      adjVolume: number;
    }>;

    const bars: Bar[] = data.map((d) => ({
      date: d.date.split("T")[0],
      open: useRaw ? d.open : d.adjOpen,
      high: useRaw ? d.high : d.adjHigh,
      low: useRaw ? d.low : d.adjLow,
      close: useRaw ? d.close : d.adjClose,
      volume: useRaw ? d.volume : d.adjVolume,
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
