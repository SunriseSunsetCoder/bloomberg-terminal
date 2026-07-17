"use client";

import {
  Activity,
  AlertTriangle,
  BarChart2,
  Briefcase,
  Database,
  HelpCircle,
  Moon,
  Newspaper,
  RefreshCw,
  Sun,
  TrendingUp,
  TrendingDown,
  Wifi,
  Zap,
} from "lucide-react";
import { BloombergButton } from "../core/bloomberg-button";
import { useMarketDataQuery } from "../hooks";
import { useRegimeData, regimeColor, regimeBg } from "../hooks";
import { bloombergColors } from "../lib/theme-config";

type TerminalHeaderProps = {
  isDarkMode: boolean;
  onCancelClick: () => void;
  onNewClick: () => void;
  onBlancClick: () => void;
  onNewsClick: () => void;
  onMoversClick: () => void;
  onVolatilityClick: () => void;
  onRmiClick: () => void;
  onFleetClick: () => void;
  onIVClick: () => void;
  onJackClick: () => void;
  onJackAnalyticsClick: () => void;
  onHelpClick: () => void;
  onThemeToggle: () => void;
};

function RegimeBadge({
  label,
  regime,
  confidence,
}: {
  label: string;
  regime: string;
  confidence: number;
}) {
  const shortRegime: Record<string, string> = {
    TRENDING_UP: "↑ TREND",
    TRENDING_DOWN: "↓ TREND",
    CHOPPY: "~ CHOP",
    BREAKOUT: "⚡ BRKOUT",
  };

  return (
    <div
      className={`flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-mono ${regimeBg(regime)}`}
    >
      <span className="text-gray-500">{label}:</span>
      <span className={`font-bold ${regimeColor(regime)}`}>
        {shortRegime[regime] ?? regime}
      </span>
      <span className="text-gray-600">{(confidence * 100).toFixed(0)}%</span>
    </div>
  );
}

export function TerminalHeader({
  isDarkMode,
  onCancelClick,
  onNewClick,
  onBlancClick,
  onNewsClick,
  onMoversClick,
  onVolatilityClick,
  onRmiClick,
  onFleetClick,
  onIVClick,
  onJackClick,
  onJackAnalyticsClick,
  onHelpClick,
  onThemeToggle,
}: TerminalHeaderProps) {
  const {
    isLoading,
    isRealTimeEnabled,
    isFromRedis,
    dataSource,
    lastUpdated,
    refreshData,
    toggleRealTimeUpdates,
  } = useMarketDataQuery();

  const { data: regimeData, isError: regimeError } = useRegimeData();

  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  const getDataFreshnessIndicator = () => {
    if (!lastUpdated) return null;
    const now = new Date();
    const diffSeconds = Math.floor((now.getTime() - lastUpdated.getTime()) / 1000);
    let color = "bg-green-500";
    let pulseClass = "animate-pulse";
    if (diffSeconds > 60) {
      color = "bg-red-500";
      pulseClass = "";
    } else if (diffSeconds > 30) {
      color = "bg-yellow-500";
      pulseClass = "animate-pulse";
    } else if (diffSeconds > 10) {
      color = "bg-green-500";
      pulseClass = "";
    }
    return (
      <div className="flex items-center gap-1">
        <div className={`h-2 w-2 rounded-full ${color} ${pulseClass}`} />
        <span className="text-xs">{diffSeconds}s</span>
      </div>
    );
  };

  const esRegime = regimeData?.regimes?.ES;
  const nqRegime = regimeData?.regimes?.NQ;

  return (
    <div className={`flex flex-col bg-[${colors.surface}]`}>
      {/* Main button row */}
      <div className="flex flex-wrap gap-1 px-2 py-1">
        <BloombergButton color="red" onClick={onCancelClick}>
          CANCL
        </BloombergButton>
        <BloombergButton color="green" onClick={onNewClick}>
          NEW
        </BloombergButton>
        <BloombergButton color="green" onClick={onBlancClick}>
          BLANC
        </BloombergButton>
        <BloombergButton color="green" onClick={onNewsClick}>
          <Newspaper className="h-3 w-3 mr-1" />
          NEWS
        </BloombergButton>
        <BloombergButton color="green" onClick={onMoversClick}>
          <TrendingUp className="h-3 w-3 mr-1" />
          GMOV
        </BloombergButton>
        <BloombergButton color="green" onClick={onVolatilityClick}>
          <BarChart2 className="h-3 w-3 mr-1" />
          GVOL
        </BloombergButton>
        <BloombergButton color="green" onClick={onRmiClick}>
          <Activity className="h-3 w-3 mr-1" />
          RMI
        </BloombergButton>
        <BloombergButton color="green" onClick={onFleetClick}>
          <Activity className="h-3 w-3 mr-1" />
          FLEET
        </BloombergButton>
        <BloombergButton color="green" onClick={onIVClick}>
          <Zap className="h-3 w-3 mr-1" />
          IV
		</BloombergButton>
        <BloombergButton color="green" onClick={onJackClick}>
          <Briefcase className="h-3 w-3 mr-1" />
          JACK
        </BloombergButton>
        <BloombergButton color="green" onClick={onJackAnalyticsClick}>
          <BarChart2 className="h-3 w-3 mr-1" />
          JANLY
        </BloombergButton>
        <BloombergButton color="accent" onClick={onHelpClick}>
          <HelpCircle className="h-3 w-3 mr-1" />
          HELP
        </BloombergButton>
        <BloombergButton color="accent" onClick={onThemeToggle}>
          {isDarkMode ? (
            <Sun className="h-3 w-3 mr-1" />
          ) : (
            <Moon className="h-3 w-3 mr-1" />
          )}
          {isDarkMode ? "LIGHT" : "DARK"}
        </BloombergButton>

        <div className="ml-auto flex items-center gap-2">
          <BloombergButton
            color="accent"
            onClick={refreshData}
            disabled={isLoading}
          >
            REFR
          </BloombergButton>
          <BloombergButton
            color={isRealTimeEnabled ? "red" : "green"}
            onClick={toggleRealTimeUpdates}
            disabled={isLoading}
          >
            {isRealTimeEnabled ? "STOP" : "LIVE"}
          </BloombergButton>

          <div className="flex items-center gap-2 text-xs">
            {isLoading ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : isRealTimeEnabled ? (
              <Wifi className="h-3 w-3 text-green-500" />
            ) : isFromRedis ? (
              <Database className="h-3 w-3 text-green-500" />
            ) : (
              <AlertTriangle className="h-3 w-3 text-yellow-500" />
            )}
            <span
              className={isFromRedis ? "text-green-500" : "text-yellow-500"}
            >
              {dataSource === "alpha-vantage"
                ? "API"
                : isFromRedis
                  ? "Redis"
                  : "Local"}
            </span>
            {getDataFreshnessIndicator()}
            {lastUpdated && (
              <span className="text-gray-400">
                {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Regime badge strip */}
      <div className="flex items-center gap-2 px-2 py-1 border-t border-gray-800 bg-gray-900/60">
        <span className="text-xs text-gray-600 font-mono uppercase tracking-wider">
          REGIME
        </span>
        {esRegime?.regime ? (
          <RegimeBadge
            label="ES"
            regime={esRegime.regime}
            confidence={esRegime.confidence}
          />
        ) : (
          <span className="text-xs text-gray-700 font-mono">ES: loading...</span>
        )}
        {nqRegime?.regime ? (
          <RegimeBadge
            label="NQ"
            regime={nqRegime.regime}
            confidence={nqRegime.confidence}
          />
        ) : (
          <span className="text-xs text-gray-700 font-mono">NQ: loading...</span>
        )}
        {regimeData?.fromCache && (
          <span className="text-xs text-gray-600 font-mono ml-1">cached</span>
        )}
        {regimeError && (
          <span className="text-xs text-yellow-600 font-mono">
            regime unavailable
          </span>
        )}
      </div>
    </div>
  );
}
