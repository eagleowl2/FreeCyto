/**
 * gateDrawStore — Phase X, slice 3: gate drawing / tool interaction state.
 *
 * The gate domain in App.tsx splits cleanly into two halves:
 *
 *   1. **Drawing state** (this store) — which tool is armed, whether draw mode
 *      is on, the in-progress shape being dragged out, the "pending" shape
 *      awaiting a name, the drag-preview overlay, and the name-validation
 *      error. All of it is transient, local, and touched only by pointer and
 *      keyboard handlers. Nothing here is fetched from or pushed to the
 *      backend.
 *
 *   2. **Gate data** (deferred to slice 4) — gateTree, activeGateId, per-gate
 *      stats and their loading/error flags. That half is driven by async
 *      effects against `/api/files/:id/gates` and `/api/gates/:id/stats`, so it
 *      is migrated separately rather than bundled in here.
 *
 * Splitting this way keeps slice 3 the same shape as slices 1–2: a pure
 * declaration-site substitution with no behavioural risk.
 *
 * Design note — drop-in compatibility (same convention as uiStore/plotStore):
 *   Every setter mirrors React's `useState` updater signature, accepting either
 *   a value (`setDrawMode(false)`) or a functional updater
 *   (`setDrawingPolygon((p) => …)`), so all existing App.tsx call sites are
 *   unchanged.
 *
 * See src/stores/README.md for the full slice plan.
 */

import { create } from "zustand";

/** React-style updater: a new value or a function of the previous value. */
type SetStateAction<T> = T | ((prev: T) => T);
type Setter<T> = (v: SetStateAction<T>) => void;

/** Axis-aligned bounds in transform space. Shared with App.tsx's undo stack. */
export type BoundsSnapshot = { x_min: number; y_min: number; x_max: number; y_max: number };

/** Which gate tool is currently armed. `null` = no tool selected. */
export type GateTool =
  | "rectangle"
  | "polygon"
  | "quadrant"
  | "ellipse"
  | "interval"
  | "boolean"
  | null;

/** Rubber-band rectangle, in screen coords, while the pointer is down. */
export type DrawingRect = { startX: number; startY: number; endX: number; endY: number };

/** Vertices accumulated so far for an in-progress polygon, in screen coords. */
export type DrawingPolygon = { points: { x: number; y: number }[] };

/** In-progress 1-D interval selection on a histogram, in screen coords. */
export type DrawingInterval = { startX: number; endX: number };

/** Finished rectangle awaiting a name before it is POSTed. Normalised coords. */
export type PendingGate = {
  nxMin: number;
  nyMin: number;
  nxMax: number;
  nyMax: number;
  gateName: string;
};

/** Finished ellipse awaiting a name before it is POSTed. Normalised coords. */
export type PendingEllipse = {
  nCx: number;
  nCy: number;
  nRx: number;
  nRy: number;
  gateName: string;
};

/** Finished interval awaiting a name before it is POSTed. Transform-space coords. */
export type PendingInterval = { xMin: number; xMax: number; gateName: string };

/**
 * Visual state for a gate being dragged/resized. The drag itself is tracked in
 * a ref (no re-render per mousemove); this is the committed preview frame.
 */
export type PreviewGate =
  | (BoundsSnapshot & { id: string; kind: "rect" })
  | { id: string; kind: "poly"; vertices: number[][] }
  | null;

/** The gate-drawing fields owned by this store. */
interface GateDrawFields {
  gateTool: GateTool;
  drawMode: boolean;
  drawingRect: DrawingRect | null;
  drawingPolygon: DrawingPolygon | null;
  drawingInterval: DrawingInterval | null;
  pendingGate: PendingGate | null;
  pendingEllipse: PendingEllipse | null;
  pendingInterval: PendingInterval | null;
  previewGate: PreviewGate;
  gateNameError: string | null;
}

type GateDrawKey = keyof GateDrawFields;

/** Each field gets a `set<Field>` action with the React `useState` signature. */
type GateDrawSetters = {
  [K in GateDrawKey as `set${Capitalize<K>}`]: Setter<GateDrawFields[K]>;
};

export type GateDrawState = GateDrawFields & GateDrawSetters;

/**
 * `gateTool` defaults to "rectangle" (the toolbar shows Rect pre-selected);
 * everything else starts empty. `drawMode` is false — the user must arm it via
 * the toolbar or the "+ add child gate" button.
 */
function initialFields(): GateDrawFields {
  return {
    gateTool: "rectangle",
    drawMode: false,
    drawingRect: null,
    drawingPolygon: null,
    drawingInterval: null,
    pendingGate: null,
    pendingEllipse: null,
    pendingInterval: null,
    previewGate: null,
    gateNameError: null,
  };
}

export const useGateDrawStore = create<GateDrawState>((set) => {
  /** Build a React-style setter bound to a single field. */
  const makeSetter =
    <K extends GateDrawKey>(key: K): Setter<GateDrawFields[K]> =>
    (v) =>
      set((s) => ({
        [key]:
          typeof v === "function"
            ? (v as (prev: GateDrawFields[K]) => GateDrawFields[K])(s[key])
            : v,
      }) as Pick<GateDrawFields, K>);

  return {
    ...initialFields(),
    setGateTool: makeSetter("gateTool"),
    setDrawMode: makeSetter("drawMode"),
    setDrawingRect: makeSetter("drawingRect"),
    setDrawingPolygon: makeSetter("drawingPolygon"),
    setDrawingInterval: makeSetter("drawingInterval"),
    setPendingGate: makeSetter("pendingGate"),
    setPendingEllipse: makeSetter("pendingEllipse"),
    setPendingInterval: makeSetter("pendingInterval"),
    setPreviewGate: makeSetter("previewGate"),
    setGateNameError: makeSetter("gateNameError"),
  };
});

/** Reset all gate-drawing state to its initial value — for tests. */
export function resetGateDrawStore(): void {
  useGateDrawStore.setState({ ...initialFields() });
}
