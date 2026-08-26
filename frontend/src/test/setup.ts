import "@testing-library/jest-dom";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, afterAll, vi } from "vitest";
import { server } from "./mocks/server";
import { resetUiStore } from "../stores/uiStore";
import { resetPlotStore } from "../stores/plotStore";
import { resetGateDrawStore } from "../stores/gateDrawStore";
import { resetGateDataStore } from "../stores/gateDataStore";
import { resetCompensationStore } from "../stores/compensationStore";

// MSW
beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// React cleanup
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// Phase X: the Zustand stores are module-level singletons, so — unlike the
// `useState` hooks they replaced — they do NOT reset when App unmounts. Without
// this, state written by one test (an armed gate tool, an open panel, a zoom
// window) leaks into the next test in the same file. Reset them alongside the
// React cleanup so every test starts from the documented initial state.
afterEach(() => {
  resetUiStore();
  resetPlotStore();
  resetGateDrawStore();
  resetGateDataStore();
  resetCompensationStore();
});

// ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(_el: Element) {
    this.cb(
      [{ contentRect: { width: 480, height: 480 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// Canvas
class MinimalCanvasRenderingContext2D {
  createImageData(w: number, h: number) {
    return { data: new Uint8ClampedArray(4), width: w, height: h };
  }
  putImageData() {}
  clearRect() {}
  fillRect() {}
  drawImage() {}
  beginPath() {}
  arc() {}
  fill() {}
  fillStyle = "";
  getImageData() { return { data: new Uint8ClampedArray(4), width: 1, height: 1 }; }
}
// Cast required: the overloaded signature of getContext is too narrow for a generic mock.
(HTMLCanvasElement.prototype as any).getContext = function(type: string) {
  if (type === "2d") return new MinimalCanvasRenderingContext2D() as unknown as CanvasRenderingContext2D;
  return null;
};

// Electron bridge
(globalThis as any).opencyto = {
  openFcsFiles: vi.fn().mockResolvedValue([]),
  saveWorkspaceFile: vi.fn().mockResolvedValue({ canceled: true }),
  loadWorkspaceFile: vi.fn().mockResolvedValue({ canceled: true }),
  version: "test",
};

// window.confirm
globalThis.confirm = vi.fn().mockReturnValue(false);

// localStorage
const localStorageStore: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]); },
  length: 0,
  key: () => null,
} as Storage;
