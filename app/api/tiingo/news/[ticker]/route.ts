import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const TIINGO_NEWS_BASE = "https://api.tiingo.com/tiingo/news";

interface NewsArticle {
  publishedDate: string;
  title: string;
  source: string;
  url?: string;
  description?: string;
  tags?: string[];
}

interface NewsResponse {
  ticker: string;
  articles: NewsArticle[];
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
  const days = parseInt(searchParams.get("days") ?? "7", 10);
  const limit = parseInt(searchParams.get("limit") ?? "10", 10);

  const token = process.env.TIINGO_API_KEY;
  if (!token) {
    return NextResponse.json<NewsResponse>(
      { ticker, articles: [], source: "tiingo", error: "TIINGO_API_KEY not set" },
      { status: 500 }
    );
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split("T")[0];

  const url = `${TIINGO_NEWS_BASE}?tickers=${ticker}&startDate=${startDateStr}&limit=${limit}&sortBy=publishedDate`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
      next: { revalidate: 1800 }, // 30min cache — news updates during the day
    });

    if (!res.ok) {
      return NextResponse.json<NewsResponse>(
        {
          ticker,
          articles: [],
          source: "tiingo",
          error: `Tiingo returned ${res.status}`,
        },
        { status: res.status }
      );
    }

    const data = (await res.json()) as Array<{
      publishedDate: string;
      title: string;
      source: string;
      url?: string;
      description?: string;
      tags?: string[];
    }>;

    const articles: NewsArticle[] = data.map((d) => ({
      publishedDate: d.publishedDate,
      title: d.title,
      source: d.source,
      url: d.url,
      description: d.description,
      tags: d.tags,
    }));

    return NextResponse.json<NewsResponse>({
      ticker,
      articles,
      source: "tiingo",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json<NewsResponse>(
      { ticker, articles: [], source: "tiingo", error: msg },
      { status: 502 }
    );
  }
}
