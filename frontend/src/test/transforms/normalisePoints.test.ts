import { describe, it, expect } from "vitest";

// Copy of the normalisePoints function — or import it once extracted to its own module
function normalisePoints(rawPoints: { x: number; y: number }[]) {
  if (!rawPoints.length) return null;
  const xs = rawPoints.map((p) => p.x);
  const ys = rawPoints.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const norm = (v: number, min: number, max: number) =>
    max === min ? 0.5 : (v - min) / (max - min);
  const points = rawPoints.map((p) => ({
    x: norm(p.x, xMin, xMax),
    y: norm(p.y, yMin, yMax),
  }));
  return { points, xMin, xMax, yMin, yMax };
}

describe("normalisePoints — range edge cases", () => {
  it("returns null for empty input", () => {
    expect(normalisePoints([])).toBeNull();
  });

  it("handles all-zero points (log of 0 clamped to log10(1)=0)", () => {
    const result = normalisePoints(Array.from({ length: 100 }, () => ({ x: 0, y: 0 })));
    expect(result).not.toBeNull();
    expect(result!.xMin).toBe(0);
    expect(result!.xMax).toBe(0); // zero-width range
    expect(result!.points[0]!.x).toBe(0.5); // norm returns 0.5 for degenerate range
    expect(isFinite(result!.points[0]!.x)).toBe(true); // MUST be finite, not NaN or Infinity
  });

  it("handles all-identical points (log of constant)", () => {
    const v = Math.log10(50000); // ~4.7
    const result = normalisePoints(Array.from({ length: 50 }, () => ({ x: v, y: v })));
    expect(result).not.toBeNull();
    expect(result!.points.every((p) => p.x === 0.5 && p.y === 0.5)).toBe(true);
    expect(result!.points.every((p) => isFinite(p.x) && isFinite(p.y))).toBe(true);
  });

  it("handles negative values produced by log transform with small positive events", () => {
    // log10(5) ≈ 0.7, log10(1) = 0 — small positive range
    const result = normalisePoints([{ x: 0, y: 0 }, { x: 0.699, y: 0.301 }]);
    expect(result).not.toBeNull();
    expect(result!.points.every((p) => isFinite(p.x) && isFinite(p.y))).toBe(true);
  });

  it("handles single point", () => {
    const result = normalisePoints([{ x: 42, y: 99 }]);
    expect(result).not.toBeNull();
    expect(result!.points[0]).toEqual({ x: 0.5, y: 0.5 });
  });
});
