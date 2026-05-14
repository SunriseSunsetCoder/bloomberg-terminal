import { type NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

// ── QuantConnect Auth ─────────────────────────────────────────────────────────
function getQCHeaders(): HeadersInit {
  const userId = process.env.QC_USER_ID ?? "";
  const apiToken = process.env.QC_API_TOKEN ?? "";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const hash = crypto
    .createHash("sha256")
    .update(`${apiToken}:${timestamp}`)
    .digest("hex");
  const credentials = Buffer.from(`${userId}:${hash}`).toString("base64");
  return {
    Authorization: `Basic ${credentials}`,
    Timestamp: timestamp,
    "Content-Type": "application/json",
  };
}

const QC_BASE = "https://www.quantconnect.com/api/v2";

async function qcPost(endpoint: string, body: object) {
  const res = await fetch(`${QC_BASE}${endpoint}`, {
    method: "POST",
    headers: getQCHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

async function qcGet(endpoint: string) {
  const res = await fetch(`${QC_BASE}${endpoint}`, {
    method: "GET",
    headers: getQCHeaders(),
  });
  return res.json();
}

// ── Covered Call Strategy (LEAN C#) ──────────────────────────────────────────
const COVERED_CALL_ALGORITHM = `
using QuantConnect;
using QuantConnect.Algorithm;
using QuantConnect.Data;
using QuantConnect.Data.Market;
using QuantConnect.Orders;
using QuantConnect.Securities.Option;
using System;
using System.Linq;


    public class CoveredCallAlgorithm : QCAlgorithm
    {
        private Symbol _equitySymbol;
        private Symbol _optionSymbol;
        private const string Ticker = "SPY";
        private const decimal IVRankThreshold = 0.50m;
        private const int TargetDelta = 30;
        private const int MinDTE = 21;
        private const int MaxDTE = 45;
        private const decimal ProfitTarget = 0.50m;
        private DateTime _lastTradeDate = DateTime.MinValue;

        public override void Initialize()
        {
            SetStartDate(2022, 1, 1);
            SetEndDate(2024, 12, 31);
            SetCash(100000);

            _equitySymbol = AddEquity(Ticker, Resolution.Daily).Symbol;

            var option = AddOption(Ticker, Resolution.Daily);
            option.SetFilter(u => u
                .Strikes(-5, +10)
                .Expiration(MinDTE, MaxDTE)
                .CallsOnly());
            _optionSymbol = option.Symbol;

            SetBenchmark(_equitySymbol);
        }

        public override void OnData(Slice slice)
        {
            // Buy and hold 100 shares if we don't have them
            if (!Portfolio[_equitySymbol].Invested)
            {
                var price = Securities[_equitySymbol].Price;
                if (price > 0)
                {
                    var shares = (int)(Portfolio.Cash / price / 100) * 100;
                    if (shares >= 100)
                        MarketOrder(_equitySymbol, shares);
                }
                return;
            }

            // Close profitable short calls
            foreach (var holding in Portfolio.Values
                .Where(h => h.Symbol.SecurityType == SecurityType.Option && h.IsShort))
            {
                var unrealizedPct = holding.UnrealizedProfitPercent;
                if (unrealizedPct >= ProfitTarget)
                {
                    MarketOrder(holding.Symbol, -holding.Quantity);
                    Log($"Closed covered call at {ProfitTarget:P0} profit target");
                }
            }

            // Sell new covered call if no open short call
            var hasShortCall = Portfolio.Values
                .Any(h => h.Symbol.SecurityType == SecurityType.Option && h.IsShort);

            if (hasShortCall || (DateTime.Now - _lastTradeDate).TotalDays < 7)
                return;

            if (!slice.OptionChains.ContainsKey(_optionSymbol)) return;
            var chain = slice.OptionChains[_optionSymbol];

            // Target ~30 delta call, 21-45 DTE
            var target = chain
                .Where(c => c.Right == OptionRight.Call
                    && c.Expiry > Time.AddDays(MinDTE)
                    && c.Expiry < Time.AddDays(MaxDTE)
                    && Math.Abs(c.Greeks.Delta - (TargetDelta / 100m)) < 0.10m)
                .OrderBy(c => Math.Abs(c.Greeks.Delta - (TargetDelta / 100m)))
                .FirstOrDefault();

            if (target == null) return;

            var sharesOwned = (int)Portfolio[_equitySymbol].Quantity;
            var contractsToSell = -(sharesOwned / 100);

            if (contractsToSell < -1) contractsToSell = -1;

            MarketOrder(target.Symbol, contractsToSell);
            _lastTradeDate = DateTime.Now;
            Log($"Sold covered call: {target.Symbol} Delta={target.Greeks.Delta:F2} " +
                $"Strike={target.Strike} Expiry={target.Expiry:yyyy-MM-dd} " +
                $"Premium={target.LastPrice:C2}");
        }
    }
}`;

// ── Poll for backtest result ──────────────────────────────────────────────────
async function pollBacktest(
  projectId: number,
  backtestId: string,
  maxAttempts = 30
): Promise<object> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const result = await qcGet(
      `/backtests/read?projectId=${projectId}&backtestId=${backtestId}`
    );
    if (result.backtest?.completed) return result.backtest;
    if (result.backtest?.error) throw new Error(result.backtest.error);
  }
  throw new Error("Backtest timed out after 2 minutes");
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const userId = process.env.QC_USER_ID;
    const apiToken = process.env.QC_API_TOKEN;

    if (!userId || !apiToken) {
      return NextResponse.json(
        { error: "QC_USER_ID and QC_API_TOKEN must be set in .env.local" },
        { status: 500 }
      );
    }

 const body = await req.json();
    const strategy = body.strategy ?? "covered_call";
    console.log("Step 1: Creating project...");

    const projectName = `Terminal-${strategy}-${Date.now()}`;
    const project = await qcPost("/projects/create", {
      name: projectName,
      language: "C#",
    });

    if (!project.projects?.[0]?.projectId) {
      return NextResponse.json({ error: "Failed to create project", detail: project }, { status: 500 });
    }
    const projectId = project.projects[0].projectId;
    console.log("Step 1 done. projectId:", projectId);
    console.log("Step 2: Adding file...");

    const fileResult = await qcPost("/files/create", {
      projectId,
      name: "main.cs",
      content: COVERED_CALL_ALGORITHM,
    });
    console.log("File result:", JSON.stringify(fileResult).slice(0, 200));
    console.log("Step 3: Compiling...");

    const compile = await qcPost("/compile/create", { projectId });
    console.log("Compile result:", JSON.stringify(compile).slice(0, 200));

    if (!compile.compileId) {
      return NextResponse.json({ error: "Compilation failed", detail: compile }, { status: 500 });
    }

    await new Promise((r) => setTimeout(r, 5000));
    console.log("Step 4: Creating backtest...");

    const backtest = await qcPost("/backtests/create", {
      projectId,
      compileId: compile.compileId,
      backtestName: `${strategy}-${new Date().toISOString().split("T")[0]}`,
    });
    console.log("Backtest result:", JSON.stringify(backtest).slice(0, 200));

    if (!backtest.backtest?.backtestId) {
      return NextResponse.json({ error: "Failed to start backtest", detail: backtest }, { status: 500 });
    }

    const backtestId = backtest.backtest.backtestId;
    console.log("Step 5: Polling for results. backtestId:", backtestId);

    const result = await pollBacktest(projectId, backtestId) as Record<string, unknown>;
    const stats = result.statistics as Record<string, string> ?? {};

    return NextResponse.json({
      success: true,
      strategy,
      projectId,
      backtestId,
      summary: {
        totalReturn: stats["Total Return"] ?? "N/A",
        annualReturn: stats["Annual Return"] ?? "N/A",
        sharpeRatio: stats["Sharpe Ratio"] ?? "N/A",
        maxDrawdown: stats["Max Drawdown"] ?? "N/A",
        winRate: stats["Win Rate"] ?? "N/A",
        totalTrades: stats["Total Trades"] ?? "N/A",
        averageWin: stats["Average Win"] ?? "N/A",
        averageLoss: stats["Average Loss"] ?? "N/A",
        profitLossRatio: stats["Profit-Loss Ratio"] ?? "N/A",
        benchmarkReturn: stats["Benchmark Return"] ?? "N/A",
      },
      viewUrl: `https://www.quantconnect.com/terminal/#open/${projectId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const stack = err instanceof Error ? err.stack : "";
    console.log("BACKTEST ERROR:", message, stack);
    return NextResponse.json({ error: message, stack }, { status: 500 });
  }
}