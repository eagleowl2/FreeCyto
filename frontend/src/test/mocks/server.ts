import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

// ─── Shared state so tests can observe what the backend received ───────────────
export let lastEventsRequest: URL | null = null;
export let lastDensityRequest: URL | null = null;
export const resetRequestLog = () => {
  lastEventsRequest = null;
  lastDensityRequest = null;
};

// ─── Default handlers — happy path ────────────────────────────────────────────
export const defaultHandlers = [
  // Health
  http.get("http://127.0.0.1:8765/api/health", () =>
    HttpResponse.json({ status: "ok" }),
  ),

  // Load file
  http.post("http://127.0.0.1:8765/api/files/load", () =>
    HttpResponse.json({
      files: [
        {
          id: "test-file-id",
          path: "/fake/WBC_CP8.fcs",
          sample_name: "WBC_CP8",
          event_count: 422888,
          channels: [
            { name: "FSC-A", index: 1, stain: null, display_name: "FSC-A", range: 262144 },
            { name: "SSC-A", index: 4, stain: null, display_name: "SSC-A", range: 262144 },
            { name: "BV421-A", index: 7, stain: "CD19", display_name: "BV421-A :: CD19", range: 262144 },
          ],
          spillover: null,
        },
      ],
    }),
  ),

  // Events — returns realistic linear scatter data
  http.get("http://127.0.0.1:8765/api/files/:fileId/events", ({ request }) => {
    lastEventsRequest = new URL(request.url);
    const tx = lastEventsRequest.searchParams.get("transform_x") ?? "linear";
    const ty = lastEventsRequest.searchParams.get("transform_y") ?? "linear";
    return HttpResponse.json(makeEventsResponse(tx, ty));
  }),

  // Density
  http.get("http://127.0.0.1:8765/api/files/:fileId/density", ({ request }) => {
    lastDensityRequest = new URL(request.url);
    return HttpResponse.json(makeDensityResponse());
  }),

  // Gates (empty)
  http.get("http://127.0.0.1:8765/api/files/:fileId/gates", () =>
    HttpResponse.json([]),
  ),

  // Session restore — no session
  http.get("http://127.0.0.1:8765/api/session/restore", () =>
    HttpResponse.json({ available: false }),
  ),
];

export const server = setupServer(...defaultHandlers);

// ─── Data factories ────────────────────────────────────────────────────────────

/** Make a realistic events payload for a given transform. */
export function makeEventsResponse(
  transformX = "linear",
  transformY = "linear",
): { channel_names: string[]; events: number[][] } {
  // FSC-A range 0..262144; SSC-A similar
  const raw = Array.from({ length: 50 }, (_, i) => [
    10000 + i * 5000, // FSC-A
    8000 + i * 4000, // SSC-A
  ]);
  const transform = (v: number, tx: string) => {
    if (tx === "log") return Math.log10(Math.max(v, 1));
    if (tx === "arcsinh") return Math.asinh(v / 150);
    return v;
  };
  return {
    channel_names: ["FSC-A", "SSC-A"],
    events: raw.map(([x, y]) => [transform(x, transformX), transform(y, transformY)]),
  };
}

/** All-zero events — simulates channels with no signal, reproducing the crash. */
export function makeZeroEventsResponse(): { channel_names: string[]; events: number[][] } {
  return {
    channel_names: ["FSC-A", "SSC-A"],
    events: Array.from({ length: 50 }, () => [0, 0]),
  };
}

/** Events where log transform produces xMin === xMax (all same value). */
export function makeCollapsingEventsResponse(): { channel_names: string[]; events: number[][] } {
  // All identical values → after normalisation xMin === xMax → crash
  return {
    channel_names: ["FSC-A", "SSC-A"],
    events: Array.from({ length: 50 }, () => [Math.log10(1000), Math.log10(500)]),
  };
}

export function makeDensityResponse() {
  // C-2: 10×10 instead of 200×200 — the large array was causing Node heap OOM
  // during vitest re-runs. Resolution does not matter for integration tests.
  const BINS = 10;
  const bins = Array.from({ length: BINS }, () =>
    Array.from({ length: BINS }, () => Math.floor(Math.random() * 50)),
  );
  return {
    file_id: "test-file-id",
    x_channel: "FSC-A",
    y_channel: "SSC-A",
    transform_x: "linear",
    transform_y: "linear",
    x_min: 0,
    x_max: 5.4,
    y_min: 0,
    y_max: 5.4,
    bins_x: BINS,
    bins_y: BINS,
    counts: bins,
  };
}
