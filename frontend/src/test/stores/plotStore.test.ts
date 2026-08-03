import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_X_TRANSFORM,
  DEFAULT_Y_TRANSFORM,
  PLOT_BG_STORAGE_KEY,
  VALID_DENSITY_COLORMAPS,
  resetPlotStore,
  usePlotStore,
  type ZoomState,
} from "../../stores/plotStore";

// The store is a module-level singleton; reset it between tests so each starts
// from the known initial state.
afterEach(() => {
  globalThis.localStorage.removeItem(PLOT_BG_STORAGE_KEY);
  resetPlotStore();
});

describe("plotStore — plot/view settings slice (Phase X)", () => {
  it("initialises to the documented defaults", () => {
    const s = usePlotStore.getState();
    expect(s.plotMode).toBe("density");
    expect(s.densityColormap).toBe("jet");
    expect(s.densityDisplayScale).toBe("log");
    expect(s.transformX).toBe(DEFAULT_X_TRANSFORM);
    expect(s.transformY).toBe(DEFAULT_Y_TRANSFORM);
    expect(s.showBackgate).toBe(false);
    expect(s.showContours).toBe(false);
    expect(s.zoom).toBeNull();
    expect(s.isPanning).toBe(false);
  });

  it("keeps the transform defaults the backend/tests rely on", () => {
    // gateCreation.test.tsx asserts transform_x === "log" on the gate payload.
    expect(DEFAULT_X_TRANSFORM).toBe("log");
    expect(DEFAULT_Y_TRANSFORM).toBe("linear");
    expect([...VALID_DENSITY_COLORMAPS]).toEqual(["jet", "viridis", "inferno"]);
  });

  it("accepts a direct value (useState-style)", () => {
    usePlotStore.getState().setPlotMode("histogram");
    expect(usePlotStore.getState().plotMode).toBe("histogram");
    usePlotStore.getState().setDensityColormap("viridis");
    expect(usePlotStore.getState().densityColormap).toBe("viridis");
  });

  it("accepts a functional updater (useState-style)", () => {
    const { setShowContours } = usePlotStore.getState();
    setShowContours((c) => !c);
    expect(usePlotStore.getState().showContours).toBe(true);
    setShowContours((c) => !c);
    expect(usePlotStore.getState().showContours).toBe(false);
  });

  it("stores and clears the zoom window, including via an updater", () => {
    const z: ZoomState = { xMin: 0, xMax: 1, yMin: 2, yMax: 3 };
    usePlotStore.getState().setZoom(z);
    expect(usePlotStore.getState().zoom).toEqual(z);

    // Functional form must receive the previous zoom — this is how the pan
    // handlers in App.tsx update the window.
    usePlotStore.getState().setZoom((prev) =>
      prev ? { ...prev, xMin: prev.xMin + 10, xMax: prev.xMax + 10 } : null,
    );
    expect(usePlotStore.getState().zoom).toEqual({ xMin: 10, xMax: 11, yMin: 2, yMax: 3 });

    usePlotStore.getState().setZoom(null);
    expect(usePlotStore.getState().zoom).toBeNull();
  });

  it("updates only the targeted field, leaving siblings untouched", () => {
    usePlotStore.getState().setTransformX("arcsinh");
    const s = usePlotStore.getState();
    expect(s.transformX).toBe("arcsinh");
    expect(s.transformY).toBe(DEFAULT_Y_TRANSFORM);
    expect(s.plotMode).toBe("density");
  });

  it("resetPlotStore() returns every field to its initial value", () => {
    const st = usePlotStore.getState();
    st.setPlotMode("points");
    st.setShowBackgate(true);
    st.setIsPanning(true);
    st.setZoom({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 });

    resetPlotStore();

    const s = usePlotStore.getState();
    expect(s.plotMode).toBe("density");
    expect(s.showBackgate).toBe(false);
    expect(s.isPanning).toBe(false);
    expect(s.zoom).toBeNull();
  });

  it("hydrates plotBgMode from localStorage on reset", () => {
    // "dark" is the default when nothing (or anything but "white") is stored.
    expect(usePlotStore.getState().plotBgMode).toBe("dark");

    globalThis.localStorage.setItem(PLOT_BG_STORAGE_KEY, "white");
    resetPlotStore();
    expect(usePlotStore.getState().plotBgMode).toBe("white");

    globalThis.localStorage.setItem(PLOT_BG_STORAGE_KEY, "garbage");
    resetPlotStore();
    expect(usePlotStore.getState().plotBgMode).toBe("dark");
  });
});
