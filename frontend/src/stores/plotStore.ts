/**
 * plotStore — Phase X, slice 2: plot / view settings.
 *
 * Holds the "how is the plot rendered" state that previously lived as ~10
 * independent `useState` hooks inside the App.tsx monolith: plot mode, density
 * colormap/scale, background theme, per-axis transforms, backgate/contour
 * overlays, and zoom/pan view state.
 *
 * These are view-only settings — they never own the *data* being plotted
 * (points, density, histogram), only how it is displayed — which makes them the
 * natural second slice after `uiStore`.
 *
 * Design note — drop-in compatibility (same convention as uiStore):
 *   Every setter mirrors React's `useState` updater signature, accepting either
 *   a value (`setZoom(null)`) or a functional updater (`setZoom((z) => …)`), so
 *   the App.tsx migration is a pure declaration-site substitution and all
 *   existing call sites keep working unchanged.
 *
 * See src/stores/README.md for the full slice plan.
 */

import { create } from "zustand";
import type { DensityColormap, DensityScale } from "../PseudocolorCanvas";

/** React-style updater: a new value or a function of the previous value. */
type SetStateAction<T> = T | ((prev: T) => T);
type Setter<T> = (v: SetStateAction<T>) => void;

export type TransformKind = "linear" | "log" | "arcsinh" | "logicle";
export type PlotMode = "points" | "density" | "histogram";
export type PlotBgMode = "dark" | "white";
export type ZoomState = { xMin: number; xMax: number; yMin: number; yMax: number };

export const DEFAULT_X_TRANSFORM: TransformKind = "log";
export const DEFAULT_Y_TRANSFORM: TransformKind = "linear";
export const VALID_DENSITY_COLORMAPS: readonly DensityColormap[] = ["jet", "viridis", "inferno"];

/** localStorage key for the persisted plot background theme. */
export const PLOT_BG_STORAGE_KEY = "freecyto_plot_bg";

/**
 * Read the persisted background theme. Wrapped in try/catch because
 * localStorage can throw (privacy mode, disabled storage) and this runs at
 * module-eval time.
 */
function readPersistedBgMode(): PlotBgMode {
  try {
    return globalThis.localStorage?.getItem(PLOT_BG_STORAGE_KEY) === "white" ? "white" : "dark";
  } catch {
    return "dark";
  }
}

/** The view-settings fields owned by this store. */
interface PlotFields {
  plotMode: PlotMode;
  densityColormap: DensityColormap;
  densityDisplayScale: DensityScale;
  plotBgMode: PlotBgMode;
  transformX: TransformKind;
  transformY: TransformKind;
  /** R-3: show the parent population as a faded background overlay. */
  showBackgate: boolean;
  /** O: density contour lines toggle. */
  showContours: boolean;
  /** P-2: current zoom window in transform space, or null for auto-fit. */
  zoom: ZoomState | null;
  /** True while the user is pan-dragging (Space+drag) — cursor style only. */
  isPanning: boolean;
}

type PlotKey = keyof PlotFields;

/** Each field gets a `set<Field>` action with the React `useState` signature. */
type PlotSetters = {
  [K in PlotKey as `set${Capitalize<K>}`]: Setter<PlotFields[K]>;
};

export type PlotState = PlotFields & PlotSetters;

function initialFields(): PlotFields {
  return {
    plotMode: "density",
    densityColormap: "jet",
    densityDisplayScale: "log",
    plotBgMode: readPersistedBgMode(),
    transformX: DEFAULT_X_TRANSFORM,
    transformY: DEFAULT_Y_TRANSFORM,
    showBackgate: false,
    showContours: false,
    zoom: null,
    isPanning: false,
  };
}

export const usePlotStore = create<PlotState>((set) => {
  /** Build a React-style setter bound to a single field. */
  const makeSetter = <K extends PlotKey>(key: K): Setter<PlotFields[K]> => (v) =>
    set((s) => ({
      [key]:
        typeof v === "function"
          ? (v as (prev: PlotFields[K]) => PlotFields[K])(s[key])
          : v,
    }) as Pick<PlotFields, K>);

  return {
    ...initialFields(),
    setPlotMode: makeSetter("plotMode"),
    setDensityColormap: makeSetter("densityColormap"),
    setDensityDisplayScale: makeSetter("densityDisplayScale"),
    setPlotBgMode: makeSetter("plotBgMode"),
    setTransformX: makeSetter("transformX"),
    setTransformY: makeSetter("transformY"),
    setShowBackgate: makeSetter("showBackgate"),
    setShowContours: makeSetter("showContours"),
    setZoom: makeSetter("zoom"),
    setIsPanning: makeSetter("isPanning"),
  };
});

/** Reset all plot/view settings to their initial state — for tests. */
export function resetPlotStore(): void {
  usePlotStore.setState({ ...initialFields() });
}
