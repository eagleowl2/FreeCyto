import React, { useEffect, useRef } from "react";

export type DensityColormap = "jet" | "viridis" | "inferno";
export type DensityScale = "log" | "linear";

interface Props {
  counts: number[][];
  width: number;
  height: number;
  colormap?: DensityColormap;
  scale?: DensityScale;
}

/** Classic 4-segment jet (FlowJo-style). */
function jetColor(t: number): [number, number, number] {
  const r = Math.max(0, Math.min(255, Math.round(255 * (1.5 - Math.abs(4 * t - 3)))));
  const g = Math.max(0, Math.min(255, Math.round(255 * (1.5 - Math.abs(4 * t - 2)))));
  const b = Math.max(0, Math.min(255, Math.round(255 * (1.5 - Math.abs(4 * t - 1)))));
  return [r, g, b];
}

const VIRIDIS_LUT: [number, number, number][] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
];

const INFERNO_LUT: [number, number, number][] = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 52],
  [252, 173, 96],
  [252, 253, 191],
];

function lutColor(t: number, lut: [number, number, number][]): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (lut.length - 1);
  const i0 = Math.floor(x);
  const i1 = Math.min(lut.length - 1, i0 + 1);
  const f = x - i0;
  const a = lut[i0]!;
  const b = lut[i1]!;
  return [
    Math.round(a[0]! + (b[0]! - a[0]!) * f),
    Math.round(a[1]! + (b[1]! - a[1]!) * f),
    Math.round(a[2]! + (b[2]! - a[2]!) * f),
  ];
}

function mapColor(t: number, colormap: DensityColormap): [number, number, number] {
  if (colormap === "viridis") return lutColor(t, VIRIDIS_LUT);
  if (colormap === "inferno") return lutColor(t, INFERNO_LUT);
  return jetColor(t);
}

export const PseudocolorCanvas: React.FC<Props> = ({
  counts,
  width,
  height,
  colormap = "jet",
  scale = "log",
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !counts.length || width <= 0 || height <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const nY = counts.length;
    const nX = counts[0]?.length ?? 0;
    if (nX === 0) return;

    let maxV = 0;
    for (let yi = 0; yi < nY; yi++) {
      const row = counts[yi];
      if (!row) continue;
      for (let xi = 0; xi < nX; xi++) {
        const v = row[xi] ?? 0;
        const nv = scale === "log" ? Math.log1p(v) : v;
        if (nv > maxV) maxV = nv;
      }
    }

    const norm = (v: number) => {
      const nv = scale === "log" ? Math.log1p(v) : v;
      return maxV > 0 ? nv / maxV : 0;
    };

    const imgData = ctx.createImageData(width, height);
    const cellW = width / nX;
    const cellH = height / nY;

    for (let yi = 0; yi < nY; yi++) {
      for (let xi = 0; xi < nX; xi++) {
        const c = counts[yi]?.[xi] ?? 0;
        const t = norm(c);
        const [r, g, b] = t === 0 ? [255, 255, 255] : mapColor(t, colormap);
        const px0 = Math.floor(xi * cellW);
        const py0 = Math.floor((nY - 1 - yi) * cellH);
        const px1 = Math.ceil((xi + 1) * cellW);
        const py1 = Math.ceil((nY - yi) * cellH);
        for (let py = py0; py < py1; py++) {
          for (let px = px0; px < px1; px++) {
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const idx = (py * width + px) * 4;
            imgData.data[idx] = r;
            imgData.data[idx + 1] = g;
            imgData.data[idx + 2] = b;
            imgData.data[idx + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }, [counts, width, height, colormap, scale]);

  return (
    <canvas
      ref={canvasRef}
      width={Math.max(1, Math.floor(width))}
      height={Math.max(1, Math.floor(height))}
      style={{
        display: "block",
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
};
