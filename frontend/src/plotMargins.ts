/** Shared plot chrome (Sprint: FlowJo UX — margins match SVG overlay and canvas). */

export const PLOT_REF = 480;

export const PLOT_MARGINS = { top: 12, right: 16, bottom: 52, left: 68 } as const;

export function plotScaledMargins(plotW: number, plotH: number) {
  const sx = plotW / PLOT_REF;
  const sy = plotH / PLOT_REF;
  return {
    ml: PLOT_MARGINS.left * sx,
    mr: PLOT_MARGINS.right * sx,
    mt: PLOT_MARGINS.top * sy,
    mb: PLOT_MARGINS.bottom * sy,
  };
}
