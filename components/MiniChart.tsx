"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface Point {
  /** Unix seconds */
  t: number;
  v: number | null;
}

interface Props {
  title: string;
  hint?: string;
  unit: string;
  color: string;
  data: Point[];
  decimals?: number;
  /** Fixed y range, e.g. [0, 100] for percentages. Omit to fit the data. */
  domain?: [number | "auto", number | "auto"];
  /** Draws a dashed alert line, e.g. the 65 V low-voltage limit. */
  limit?: { y: number; label: string };
  /**
   * If two readings are further apart than this (seconds), the line is broken
   * instead of drawing a straight bridge across the time the device was off.
   */
  gapS: number;
}

const axis = { stroke: "#475569", tick: { fill: "#64748b", fontSize: 10 } };

const timeTick = (t: number) =>
  new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Inserts a null between readings separated by more than `gapS`. */
export function withGaps(points: Point[], gapS: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i].t - points[i - 1].t > gapS) {
      out.push({ t: (points[i].t + points[i - 1].t) / 2, v: null });
    }
    out.push(points[i]);
  }
  return out;
}

export default function MiniChart({
  title,
  hint,
  unit,
  color,
  data,
  decimals = 1,
  domain = ["auto", "auto"],
  limit,
  gapS,
}: Props) {
  const series = withGaps(data, gapS);
  const latest = [...data].reverse().find((p) => p.v !== null)?.v;

  return (
    <div className="chartbox">
      <div className="chart-head">
        <div>
          <h2>
            <span className="swatch" style={{ background: color }} />
            {title}
          </h2>
          {hint && <div className="hint">{hint}</div>}
          {limit && <div className="hint limit-hint">- - - alert line: {limit.label}</div>}
        </div>
        <div className="chart-latest">
          {latest === undefined || latest === null ? "--" : latest.toFixed(decimals)}
          <span className="unit">{unit}</span>
        </div>
      </div>

      <div className="canvas-wrap">
        {data.length === 0 ? (
          <div className="empty">No readings yet</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={timeTick}
                minTickGap={36}
                {...axis}
              />
              <YAxis domain={domain} width={48} allowDecimals {...axis} />
              <Tooltip
                cursor={{ stroke: "#64748b", strokeWidth: 1 }}
                contentStyle={{
                  background: "#1e293b",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#94a3b8" }}
                itemStyle={{ color: "#e2e8f0" }}
                labelFormatter={(t) =>
                  new Date(Number(t) * 1000).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                }
                formatter={(v) => [`${Number(v).toFixed(decimals)} ${unit}`, title]}
              />
              {limit && (
                <ReferenceLine
                  y={limit.y}
                  stroke="#f87171"
                  strokeDasharray="4 4"
                  ifOverflow="extendDomain"
                />
              )}
              <Line
                type="monotone"
                dataKey="v"
                stroke={color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: "#1e293b", strokeWidth: 2 }}
                isAnimationActive={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
