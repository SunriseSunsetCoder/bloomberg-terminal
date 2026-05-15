"use client";

import { Activity, AlertTriangle, CheckCircle, RefreshCw, XCircle } from "lucide-react";
import { useFleetData } from "../hooks/useFleetData";
import type { BotState } from "../hooks/useFleetData";
import { bloombergColors } from "../lib/theme-config";

type FleetViewProps = {
  isDarkMode: boolean;
  onBack: () => void;
};

function ddColor(pct: number): string {
  if (pct >= 0.66) return "text-red-500";
  if (pct >= 0.33) return "text-yellow-400";
  return "text-green-400";
}

function ddBar(pct: number): string {
  if (pct >= 0.66) return "bg-red-500";
  if (pct >= 0.33) return "bg-yellow-400";
  return "bg-green-500";
}

function BotRow({ bot, isDarkMode }: { bot: BotState; isDarkMode: boolean }) {
  const winRate =
    bot.dailyTrades > 0
      ? Math.round((bot.dailyWins / bot.dailyTrades) * 100)
      : 0;

  return (
    <tr className={`border-b border-gray-700 hover:bg-gray-800/40 transition-colors`}>
      {/* Bot ID */}
      <td className="px-3 py-2 font-mono text-xs text-yellow-400 whitespace-nowrap">
        {bot.id}
      </td>

      {/* Instrument + Direction */}
      <td className="px-3 py-2 text-xs text-gray-300 whitespace-nowrap">
        {bot.instrument}
        <span className="ml-1 text-gray-500 text-[10px]">
          {bot.direction === "LongsOnly" ? "L" : bot.direction === "ShortsOnly" ? "S" : "L/S"}
        </span>
      </td>

      {/* Status */}
      <td className="px-3 py-2 text-center">
        {bot.isTradingBlocked ? (
          <span className="inline-flex items-center gap-1 text-red-400 text-xs font-bold">
            <XCircle className="h-3 w-3" /> BLOCKED
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-green-400 text-xs">
            <CheckCircle className="h-3 w-3" /> ACTIVE
          </span>
        )}
      </td>

      {/* Daily PnL */}
      <td className={`px-3 py-2 text-xs font-mono text-right ${bot.dailyPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
        {bot.dailyPnL >= 0 ? "+" : ""}
        {bot.dailyPnL.toFixed(2)}
      </td>

      {/* Trades / WR */}
      <td className="px-3 py-2 text-xs text-gray-300 text-center whitespace-nowrap">
        {bot.dailyTrades}T
        <span className="ml-1 text-gray-500">
          {bot.dailyTrades > 0 ? `${winRate}%` : "—"}
        </span>
      </td>

      {/* DD% bar */}
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${ddBar(bot.ddUsedPct)}`}
              style={{ width: `${Math.min(bot.ddUsedPct * 100, 100)}%` }}
            />
          </div>
          <span className={`text-xs font-mono ${ddColor(bot.ddUsedPct)}`}>
            {(bot.ddUsedPct * 100).toFixed(0)}%
          </span>
        </div>
      </td>

      {/* Last trade */}
      <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
        {bot.lastTradeResult ? (
          <span className={bot.lastTradeResult === "WIN" ? "text-green-400" : bot.lastTradeResult === "LOSS" ? "text-red-400" : "text-yellow-400"}>
            {bot.lastTradeResult}
          </span>
        ) : "—"}
      </td>
    </tr>
  );
}

export function FleetView({ isDarkMode, onBack }: FleetViewProps) {
  const { data: fleet, isLoading, isError, dataUpdatedAt, refetch } = useFleetData();
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const totalPnL = fleet?.bots.reduce((sum, b) => sum + b.dailyPnL, 0) ?? 0;
  const blockedCount = fleet?.bots.filter((b) => b.isTradingBlocked).length ?? 0;
  const activeBots = (fleet?.bots.length ?? 0) - blockedCount;

  return (
    <div className={`flex flex-col h-full bg-[${colors.background}] text-[${colors.text}]`}>

      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 bg-gray-900">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-xs text-gray-400 hover:text-white transition-colors px-2 py-1 border border-gray-600 rounded"
          >
            ← BACK
          </button>
          <span className="text-yellow-400 font-bold text-sm font-mono tracking-widest">
            BOT FLEET MONITOR
          </span>
          {fleet && (
            <span className={`text-xs ${fleet.meta.isStale ? "text-red-400" : "text-green-400"}`}>
              {fleet.meta.isStale ? "⚠ STALE" : `● LIVE · ${fleet.meta.ageSeconds}s ago`}
            </span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> REFRESH
        </button>
      </div>

      {/* Summary strip */}
      {fleet && (
        <div className="flex gap-6 px-4 py-2 border-b border-gray-700 bg-gray-900/60 text-xs font-mono">
          <span>
            SESSION: <span className="text-white">{fleet.sessionDate}</span>
          </span>
          <span>
            BOTS: <span className="text-green-400">{activeBots} ACTIVE</span>
            {blockedCount > 0 && <span className="text-red-400 ml-1">{blockedCount} BLOCKED</span>}
          </span>
          <span>
            FLEET PnL:{" "}
            <span className={totalPnL >= 0 ? "text-green-400" : "text-red-400"}>
              {totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)}
            </span>
          </span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-3">
        {isLoading && (
          <div className="flex items-center justify-center h-40 gap-2 text-gray-400">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span className="text-sm font-mono">FETCHING FLEET DATA...</span>
          </div>
        )}

        {isError && (
          <div className="flex flex-col items-center justify-center h-40 gap-3 text-gray-500">
            <AlertTriangle className="h-8 w-8 text-yellow-500" />
            <p className="text-sm font-mono">NO FLEET DATA — BRIDGE SERVER OFFLINE OR NT8 NOT RUNNING</p>
            <button
              onClick={() => refetch()}
              className="text-xs text-yellow-400 border border-yellow-600 px-3 py-1 rounded hover:bg-yellow-900/20"
            >
              RETRY
            </button>
          </div>
        )}

        {fleet && fleet.bots.length > 0 && (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-600">
                <th className="px-3 py-2 text-xs text-gray-500 font-normal uppercase tracking-wider">Bot</th>
                <th className="px-3 py-2 text-xs text-gray-500 font-normal uppercase tracking-wider">Instr</th>
                <th className="px-3 py-2 text-xs text-gray-500 font-normal uppercase tracking-wider text-center">Status</th>
                <th className="px-3 py-2 text-xs text-gray-500 font-normal uppercase tracking-wider text-right">Daily PnL</th>
                <th className="px-3 py-2 text-xs text-gray-500 font-normal uppercase tracking-wider text-center">Trades/WR</th>
                <th className="px-3 py-2 text-xs text-gray-500 font-normal uppercase tracking-wider">DD%</th>
                <th className="px-3 py-2 text-xs text-gray-500 font-normal uppercase tracking-wider">Last</th>
              </tr>
            </thead>
            <tbody>
              {fleet.bots.map((bot) => (
                <BotRow key={bot.id} bot={bot} isDarkMode={isDarkMode} />
              ))}
            </tbody>
          </table>
        )}

        {fleet && fleet.bots.length === 0 && (
          <div className="flex items-center justify-center h-40 text-gray-500 font-mono text-sm">
            NO BOTS REGISTERED
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1 border-t border-gray-700 bg-gray-900 text-xs text-gray-600 font-mono flex gap-4">
        <span>REFRESHES EVERY 30s</span>
        <span className="text-red-400/60">RED = DD &gt;66%</span>
        <span className="text-yellow-400/60">AMBER = DD &gt;33%</span>
        <span className="text-green-400/60">GREEN = DD &lt;33%</span>
      </div>
    </div>
  );
}
