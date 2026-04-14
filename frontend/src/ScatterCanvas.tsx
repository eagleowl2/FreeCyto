import React, { useEffect, useRef } from "react";

export type ScatterPoint = { x: number; y: number };

interface Props {
  points: ScatterPoint[];
  plotAreaW: number;
  plotAreaH: number;
  /** Pixel width/height of backing store (scaled by CSS to plot area). */
  pixelScale?: number;
}

/** Renders normalized (0–1) scatter in the inner plot area; avoids 10k+ SVG `<circle>` nodes. */
export const ScatterCanvas: React.FC<Props> = ({ points, plotAreaW, plotAreaH, pixelScale = 2 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const w = Math.max(64, Math.floor(plotAreaW * pixelScale));
  const h = Math.max(64, Math.floor(plotAreaH * pixelScale));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || plotAreaW <= 0 || plotAreaH <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const sx = w / plotAreaW;
    const sy = h / plotAreaH;
    const r = Math.max(0.8, 1.4 * Math.min(sx, sy) * 0.5);
    ctx.fillStyle = "rgba(74, 222, 128, 0.55)";
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p) continue;
      const px = p.x * plotAreaW * sx;
      const py = (1 - p.y) * plotAreaH * sy;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [points, plotAreaW, plotAreaH, w, h]);

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
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
