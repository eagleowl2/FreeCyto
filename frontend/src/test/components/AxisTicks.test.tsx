import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { AxisTicks } from "../../AxisTicks";

describe("AxisTicks — crash prevention", () => {
  // Helper: render AxisTicks without throwing
  function renderSafely(props: Parameters<typeof AxisTicks>[0]) {
    let error: Error | null = null;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <svg>
          <AxisTicks {...props} />
        </svg>,
      );
    } catch (e) {
      error = e as Error;
    }
    spy.mockRestore();
    return error;
  }

  it("does NOT throw when min === max === 0 (degenerate log range)", () => {
    const error = renderSafely({
      axis: "x",
      min: 0,
      max: 0,
      transform: "log",
      pixelStart: 68,
      pixelEnd: 480,
      axisPixel: 480,
      fill: "#1e293b",
    });
    expect(error).toBeNull();
  });

  it("does NOT throw when min === max (any non-zero value)", () => {
    const error = renderSafely({
      axis: "x",
      min: 4.698,
      max: 4.698, // all events had identical log10 value
      transform: "log",
      pixelStart: 68,
      pixelEnd: 480,
      axisPixel: 480,
      fill: "#1e293b",
    });
    expect(error).toBeNull();
  });

  it("does NOT throw when min > max (inverted range — malformed data)", () => {
    const error = renderSafely({
      axis: "x",
      min: 5,
      max: 3,
      transform: "log",
      pixelStart: 68,
      pixelEnd: 480,
      axisPixel: 480,
      fill: "#1e293b",
    });
    expect(error).toBeNull();
  });

  it("renders correct number of ticks for log transform on typical range", () => {
    const { container } = render(
      <svg>
        <AxisTicks
          axis="x"
          min={0}
          max={5.4}
          transform="log"
          pixelStart={68}
          pixelEnd={480}
          axisPixel={480}
          fill="#1e293b"
        />
      </svg>,
    );
    const ticks = container.querySelectorAll("line");
    expect(ticks.length).toBeGreaterThanOrEqual(4); // at least 10^0 through 10^4
    expect(ticks.length).toBeLessThanOrEqual(10); // never more than 10
  });

  it("renders correct number of ticks for linear transform", () => {
    const { container } = render(
      <svg>
        <AxisTicks
          axis="x"
          min={0}
          max={262144}
          transform="linear"
          pixelStart={68}
          pixelEnd={480}
          axisPixel={480}
          fill="#1e293b"
        />
      </svg>,
    );
    const tickLabels = container.querySelectorAll("text");
    expect(tickLabels.length).toBeGreaterThanOrEqual(3);
    expect(tickLabels.length).toBeLessThanOrEqual(8);
  });

  it("renders finite pixel positions for all ticks (no NaN or Infinity in x/y attrs)", () => {
    const { container } = render(
      <svg>
        <AxisTicks
          axis="x"
          min={0}
          max={5.4}
          transform="log"
          pixelStart={68}
          pixelEnd={480}
          axisPixel={480}
          fill="#1e293b"
        />
      </svg>,
    );
    const lines = container.querySelectorAll("line");
    lines.forEach((line) => {
      ["x1", "x2", "y1", "y2"].forEach((attr) => {
        const val = Number(line.getAttribute(attr));
        expect(isFinite(val)).toBe(true);
      });
    });
  });
});
