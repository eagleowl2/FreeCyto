import React from "react";

export type AxisTransform = "linear" | "log" | "arcsinh" | "logicle";

function generateTicks(
  min: number,
  max: number,
  transform: AxisTransform,
  cofactor = 150,
): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max <= min) return [min];
  if (transform === "linear") {
    const range = max - min;
    const step = 10 ** Math.floor(Math.log10(range / 5));
    const candidates = [1, 2, 2.5, 5, 10];
    const niceStep =
      (candidates.find((s) => range / (s * step) <= 6) ?? 1) * step;
    const ticks: number[] = [];
    const start = Math.ceil(min / niceStep - 1e-9) * niceStep;
    for (let t = start; t <= max + 1e-9 * Math.abs(max); t += niceStep) {
      ticks.push(t);
      if (ticks.length > 12) break;
    }
    return ticks.length ? ticks : [min, max];
  }
  if (transform === "log") {
    // Guard against transient mixed state (e.g. log transform selected while range is still linear).
    // Without this cap, a large linear range can trigger millions of iterations and freeze the UI.
    const ticks: number[] = [];
    const start = Math.floor(min);
    const end = Math.ceil(max);
    const span = end - start;
    if (!Number.isFinite(span) || span <= 0) return [min];
    const maxTicks = 12;
    const step = Math.max(1, Math.ceil(span / maxTicks));
    for (let exp = start; exp <= end + 1e-9; exp += step) {
      ticks.push(exp);
      if (ticks.length > maxTicks) break;
    }
    return ticks.length ? ticks : [min, max];
  }
  if (transform === "arcsinh") {
    const cand = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
    return cand.filter((t) => t >= min - 0.2 && t <= max + 0.2);
  }
  const cand = [0, 1, 2, 3, 4, 4.5];
  return cand.filter((t) => t >= min - 0.2 && t <= max + 0.2);
}

function formatTickValue(value: number, transform: AxisTransform): string {
  if (transform === "log" || transform === "logicle") {
    if (Math.abs(value) < 1e-9) return "1";
    return `10^${Math.round(value)}`;
  }
  if (transform === "arcsinh") {
    return value.toFixed(0);
  }
  const v = value;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return v.toFixed(0);
}

export interface AxisTicksProps {
  axis: "x" | "y";
  min: number;
  max: number;
  transform: AxisTransform;
  /** X axis: left edge of inner plot; Y axis: unused (use plotTop). */
  pixelStart: number;
  /** X axis: right edge of inner plot; Y axis: inner plot height (from min to max data). */
  pixelEnd: number;
  /** X axis: y coordinate of horizontal axis line; Y axis: x coordinate of vertical axis (inner left). */
  axisPixel: number;
  /** Y axis: top (min pixel y) of inner plot area. */
  plotTop?: number;
  tickLen?: number;
  fill?: string;
  cofactor?: number;
}

/** SVG numeric ticks in plot margin (Sprint: FlowJo-style axis labels). */
export const AxisTicks: React.FC<AxisTicksProps> = ({
  axis,
  min,
  max,
  transform,
  pixelStart,
  pixelEnd,
  axisPixel,
  plotTop,
  tickLen = 5,
  fill = "#1e293b",
  cofactor = 150,
}) => {
  const ticks = React.useMemo(
    () => generateTicks(min, max, transform, cofactor),
    [min, max, transform, cofactor],
  );
  const span = pixelEnd - pixelStart;
  const norm = (v: number) => (max > min ? (v - min) / (max - min) : 0.5);

  if (axis === "x") {
    return (
      <g>
        {ticks.map((t) => {
          const nx = norm(t);
          const x = pixelStart + span * nx;
          return (
            <g key={`xt-${t}`}>
              <line
                x1={x}
                x2={x}
                y1={axisPixel}
                y2={axisPixel + tickLen}
                stroke={fill}
                strokeWidth={1}
              />
              <text
                x={x}
                y={axisPixel + tickLen + 12}
                textAnchor="middle"
                fill={fill}
                fontSize={11}
              >
                {transform === "log" || transform === "logicle" ? (
                  <>
                    <tspan>10</tspan>
                    <tspan dy="-4" fontSize="0.72em">
                      {Math.round(t)}
                    </tspan>
                    <tspan dy="4" fontSize="1em" />
                  </>
                ) : (
                  formatTickValue(t, transform)
                )}
              </text>
            </g>
          );
        })}
      </g>
    );
  }

  const innerH = pixelEnd;
  const top = plotTop ?? 0;
  return (
    <g>
      {ticks.map((t) => {
        const ny = norm(t);
        const y = top + innerH * (1 - ny);
        return (
          <g key={`yt-${t}`}>
            <line
              x1={axisPixel - tickLen}
              x2={axisPixel}
              y1={y}
              y2={y}
              stroke={fill}
              strokeWidth={1}
            />
            <text
              x={axisPixel - tickLen - 6}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              fill={fill}
              fontSize={11}
            >
              {transform === "log" || transform === "logicle" ? (
                <>
                  <tspan>10</tspan>
                  <tspan dy="-4" fontSize="0.72em">
                    {Math.round(t)}
                  </tspan>
                  <tspan dy="4" fontSize="1em" />
                </>
              ) : (
                formatTickValue(t, transform)
              )}
            </text>
          </g>
        );
      })}
    </g>
  );
};
