import { afterEach, describe, expect, it } from "vitest";
import {
  resetGateDrawStore,
  useGateDrawStore,
  type DrawingPolygon,
  type PendingGate,
} from "../../stores/gateDrawStore";

// The store is a module-level singleton; reset it between tests so each starts
// from the known initial state.
afterEach(() => {
  resetGateDrawStore();
});

describe("gateDrawStore — gate drawing slice (Phase X)", () => {
  it("initialises with the rectangle tool armed and nothing in progress", () => {
    const s = useGateDrawStore.getState();
    // The toolbar renders Rect as pre-selected, so this default is load-bearing.
    expect(s.gateTool).toBe("rectangle");
    expect(s.drawMode).toBe(false);
    expect(s.drawingRect).toBeNull();
    expect(s.drawingPolygon).toBeNull();
    expect(s.drawingInterval).toBeNull();
    expect(s.pendingGate).toBeNull();
    expect(s.pendingEllipse).toBeNull();
    expect(s.pendingInterval).toBeNull();
    expect(s.previewGate).toBeNull();
    expect(s.gateNameError).toBeNull();
  });

  it("accepts a direct value (useState-style)", () => {
    useGateDrawStore.getState().setGateTool("polygon");
    expect(useGateDrawStore.getState().gateTool).toBe("polygon");
    useGateDrawStore.getState().setDrawMode(true);
    expect(useGateDrawStore.getState().drawMode).toBe(true);
    useGateDrawStore.getState().setGateTool(null);
    expect(useGateDrawStore.getState().gateTool).toBeNull();
  });

  it("accepts a functional updater (useState-style)", () => {
    const { setDrawMode } = useGateDrawStore.getState();
    setDrawMode((d) => !d);
    expect(useGateDrawStore.getState().drawMode).toBe(true);
    setDrawMode((d) => !d);
    expect(useGateDrawStore.getState().drawMode).toBe(false);
  });

  it("appends polygon vertices via a functional updater", () => {
    // This is how the polygon click handler in App.tsx accumulates vertices —
    // it must see the previous point list, not a stale closure.
    const { setDrawingPolygon } = useGateDrawStore.getState();
    setDrawingPolygon({ points: [{ x: 1, y: 1 }] });
    setDrawingPolygon((p: DrawingPolygon | null) =>
      p ? { points: [...p.points, { x: 2, y: 2 }] } : null,
    );
    setDrawingPolygon((p: DrawingPolygon | null) =>
      p ? { points: [...p.points, { x: 3, y: 3 }] } : null,
    );
    expect(useGateDrawStore.getState().drawingPolygon?.points).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it("holds a pending rectangle and lets its name be edited in place", () => {
    const pending: PendingGate = { nxMin: 0.2, nyMin: 0.2, nxMax: 0.6, nyMax: 0.6, gateName: "" };
    useGateDrawStore.getState().setPendingGate(pending);
    // The gate-name input updates only the name field, preserving the geometry.
    useGateDrawStore.getState().setPendingGate((p) =>
      p ? { ...p, gateName: "Lymphocytes" } : null,
    );
    const s = useGateDrawStore.getState();
    expect(s.pendingGate).toEqual({ ...pending, gateName: "Lymphocytes" });
  });

  it("stores a rect preview gate for the drag overlay", () => {
    useGateDrawStore.getState().setPreviewGate({
      id: "g1", kind: "rect", x_min: 0, y_min: 0, x_max: 1, y_max: 1,
    });
    expect(useGateDrawStore.getState().previewGate).toEqual({
      id: "g1", kind: "rect", x_min: 0, y_min: 0, x_max: 1, y_max: 1,
    });
    useGateDrawStore.getState().setPreviewGate(null);
    expect(useGateDrawStore.getState().previewGate).toBeNull();
  });

  it("stores a poly preview gate for the drag overlay", () => {
    useGateDrawStore.getState().setPreviewGate({
      id: "g2", kind: "poly", vertices: [[0, 0], [1, 0], [1, 1]],
    });
    const pv = useGateDrawStore.getState().previewGate;
    expect(pv?.kind).toBe("poly");
    expect(pv && "vertices" in pv ? pv.vertices : null).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it("updates only the targeted field, leaving siblings untouched", () => {
    useGateDrawStore.getState().setGateNameError("Name already in use");
    const s = useGateDrawStore.getState();
    expect(s.gateNameError).toBe("Name already in use");
    expect(s.pendingGate).toBeNull();
    expect(s.drawMode).toBe(false);
    expect(s.gateTool).toBe("rectangle");
  });

  it("resetGateDrawStore() returns every field to its initial value", () => {
    const st = useGateDrawStore.getState();
    st.setGateTool("ellipse");
    st.setDrawMode(true);
    st.setDrawingRect({ startX: 1, startY: 2, endX: 3, endY: 4 });
    st.setPendingInterval({ xMin: 0, xMax: 1, gateName: "CD3+" });
    st.setGateNameError("boom");

    resetGateDrawStore();

    const s = useGateDrawStore.getState();
    expect(s.gateTool).toBe("rectangle");
    expect(s.drawMode).toBe(false);
    expect(s.drawingRect).toBeNull();
    expect(s.pendingInterval).toBeNull();
    expect(s.gateNameError).toBeNull();
  });
});
