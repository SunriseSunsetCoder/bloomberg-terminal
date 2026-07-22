"use client";

import type { ReactNode } from "react";
import { useSectorStrength } from "../hooks/useSectorStrength";
import type { SectorRow } from "@/lib/sector-strength";

interface PanelColors {
  background: string;
  surface: string;
  text: string;
  border: string;
  accent: string;
  positive: string;
  negative: string;
}

interface SectorStrengthPanelProps {
  colors: PanelColors;
}

const pct = (n: number | null | undefined): string =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

export function SectorStrengthPanel({ colors }: SectorStrengthPanelProps) {
  const { data, isLoading, error } = useSectorStrength();

  const asOf =
    data?.generatedAt != null
      ? new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;

  // Color a % value green/red (muted for null).
  const num = (n: number | null | undefined, bold = false) => (
    <span
      className={`font-mono tabular-nums ${bold ? "font-bold" : ""}`}
      style={{ color: n == null ? colors.text : n >= 0 ? colors.positive : colors.negative, opacity: n == null ? 0.5 : 1 }}
    >
      {pct(n)}
    </span>
  );

  const header = (
    <div className="flex items-baseline justify-between mb-2">
      <span className="text-[11px] font-bold tracking-widest font-mono" style={{ color: colors.accent }}>
        SECTOR STRENGTH · vs SPY (3M)
      </span>
      {asOf != null && (
        <span className="text-[10px] font-mono" style={{ color: colors.text, opacity: 0.6 }}>
          as of {asOf} · {data?.source ?? ""}
        </span>
      )}
    </div>
  );

  const shell = (children: ReactNode) => (
    <div className="rounded border p-2.5" style={{ borderColor: colors.border, backgroundColor: colors.surface }}>
      {header}
      {children}
    </div>
  );

  if (isLoading) {
    return shell(
      <div className="text-[11px] font-mono animate-pulse" style={{ color: colors.text, opacity: 0.7 }}>
        Loading sector strength…
      </div>
    );
  }
  if (error || !data?.ok || !data.sectors || data.sectors.length === 0) {
    return shell(
      <div className="text-[11px] font-mono" style={{ color: colors.text, opacity: 0.6 }}>
        Sector strength unavailable{data?.error ? ` — ${data.error}` : ""}.
      </div>
    );
  }

  const cellHead = "text-[9px] uppercase tracking-widest font-mono px-1.5 py-1 text-right";
  const cell = "text-[11px] font-mono px-1.5 py-1 text-right";

  return shell(
    <>
      {!data.rsAvailable && (
        <div className="text-[10px] font-mono mb-1.5" style={{ color: colors.negative }}>
          SPY baseline unavailable — ranked by raw 3-month.
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ color: colors.text, opacity: 0.6 }}>
              <th className={`${cellHead} text-left w-6`}>#</th>
              <th className={`${cellHead} text-left`}>Sector · Ticker</th>
              <th className={cellHead}>Today</th>
              <th className={cellHead}>1W</th>
              <th className={cellHead}>1M</th>
              <th className={cellHead}>3M</th>
              <th className={cellHead}>RS 3M</th>
            </tr>
          </thead>
          <tbody>
            {data.sectors.map((s: SectorRow, i: number) => (
              <tr key={s.ticker} className="border-t" style={{ borderColor: colors.border }}>
                <td className="text-[11px] font-mono px-1.5 py-1 text-left" style={{ color: colors.text, opacity: 0.55 }}>
                  {i + 1}
                </td>
                <td className="text-[11px] font-mono px-1.5 py-1 text-left" style={{ color: colors.text }}>
                  <span>{s.name}</span>
                  <span style={{ color: colors.accent }}> · {s.ticker}</span>
                </td>
                <td className={cell}>{num(s.today)}</td>
                <td className={cell}>{num(s.w1)}</td>
                <td className={cell}>{num(s.m1)}</td>
                <td className={cell}>{num(s.m3)}</td>
                <td className={cell}>{num(data.rsAvailable ? s.rs3m : null, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
