import React from "react";
import { GateTreePanel } from "./components/GateTreePanel";
import type { GateNode } from "./types/gates";
import { breadcrumbPath, findNode, flattenTree } from "./types/gates";
import { getUiChannelLabel } from "./channelAliases";
import { PseudocolorCanvas, type DensityColormap, type DensityScale } from "./PseudocolorCanvas";
import { ScatterCanvas } from "./ScatterCanvas";
import { AxisTicks } from "./AxisTicks";
import { plotScaledMargins } from "./plotMargins";

type HealthState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok" }
  | { status: "error"; message: string };

type LoadedFile = {
  id: string;
  path: string;
  sample_name?: string | null;
  event_count: number;
  channels: string[];
  spillover?: number[][] | null;
};

type ScatterPoint = { x: number; y: number };

const API_BASE = "http://127.0.0.1:8765";

type ChannelInfo = {
  name: string;
  index: number;
  stain: string | null;
  display_name: string;
  ui_label: string;
  range: number | null;
};

type DensityData = {
  binsX: number;
  binsY: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  counts: number[][];
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export const App: React.FC = () => {
  const [health, setHealth] = React.useState<HealthState>({ status: "idle" });

  const [fcsPath, setFcsPath] = React.useState("");
  const [loadedFiles, setLoadedFiles] = React.useState<LoadedFile[]>([]);
  const [compText, setCompText] = React.useState("");
  const [compStatus, setCompStatus] = React.useState<"idle" | "applying" | "error" | "success">("idle");
  const [compError, setCompError] = React.useState<string | null>(null);
  const [file, setFile] = React.useState<LoadedFile | null>(null);
  const [channels, setChannels] = React.useState<ChannelInfo[]>([]);
  const [xChannel, setXChannel] = React.useState("");
  const [yChannel, setYChannel] = React.useState("");
  const [plotMode, setPlotMode] = React.useState<"points" | "density">("points");
  const [densityColormap, setDensityColormap] = React.useState<DensityColormap>("jet");
  const [densityDisplayScale, setDensityDisplayScale] = React.useState<DensityScale>("log");
  const [plotBgMode, setPlotBgMode] = React.useState<"dark" | "white">(() => {
    try {
      return globalThis.localStorage?.getItem("freecyto_plot_bg") === "white" ? "white" : "dark";
    } catch {
      return "dark";
    }
  });
  const [transformX, setTransformX] = React.useState<"linear" | "log" | "arcsinh" | "logicle">("linear");
  const [transformY, setTransformY] = React.useState<"linear" | "log" | "arcsinh" | "logicle">("linear");
  const [points, setPoints] = React.useState<ScatterPoint[]>([]);
  /** Min/max in current transform space (plot axes). Gate coordinates are in this space. */
  const [transformedRange, setTransformedRange] = React.useState<{
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
  } | null>(null);
  const [density, setDensity] = React.useState<DensityData | null>(null);
  const [gateMessage, setGateMessage] = React.useState<string | null>(null);
  const [gateTree, setGateTree] = React.useState<GateNode[]>([]);
  const [activeGateId, setActiveGateId] = React.useState<string | null>(null);
  const [gateTreeLoading, setGateTreeLoading] = React.useState(false);
  const [gateTreeError, setGateTreeError] = React.useState<string | null>(null);
  const gateList = React.useMemo(() => flattenTree(gateTree), [gateTree]);
  const visibleGates = React.useMemo(
    () =>
      flattenTree(gateTree).filter(
        (g) =>
          g.parent_gate_id === activeGateId &&
          g.x_channel === xChannel &&
          g.y_channel === yChannel,
      ),
    [gateTree, activeGateId, xChannel, yChannel],
  );
  const [gateNameError, setGateNameError] = React.useState<string | null>(null);
  const [drawingRect, setDrawingRect] = React.useState<
    { startX: number; startY: number; endX: number; endY: number } | null
  >(null);
  const [pendingGate, setPendingGate] = React.useState<{
    nxMin: number;
    nyMin: number;
    nxMax: number;
    nyMax: number;
    gateName: string;
  } | null>(null);
  const [gateTool, setGateTool] = React.useState<"rectangle" | "polygon" | "quadrant" | null>("rectangle");
  const [drawMode, setDrawMode] = React.useState(false);
  const [drawingPolygon, setDrawingPolygon] = React.useState<{ points: { x: number; y: number }[] } | null>(null);
  const [fcsStatus, setFcsStatus] = React.useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [fcsError, setFcsError] = React.useState<string | null>(null);
  const [debugLogPath, setDebugLogPath] = React.useState<string>("");
  const [debugUiStatus, setDebugUiStatus] = React.useState<string>("");
  const [debugLastRuntimeError, setDebugLastRuntimeError] = React.useState<string>("");

  /** Monotonic id for plot data fetches; stale responses must not overwrite React state (see FRONTEND_REVIEW #1). */
  const plotRequestGenerationRef = React.useRef(0);

  /** Remember X/Y channel + transforms per file when switching loaded files (FRONTEND_APP_REVIEW NEW-13). */
  const perFileAxesRef = React.useRef(
    new Map<string, { x: string; y: string; tx: typeof transformX; ty: typeof transformY }>(),
  );

  const sessionRestoreAttemptedRef = React.useRef(false);
  const debugLog = React.useCallback((msg: string) => {
    void window.opencyto?.appendDebugLog?.(msg);
  }, []);

  const checkHealth = React.useCallback(async () => {
    setHealth({ status: "loading" });
    try {
      const data = await getJson<{ status?: string }>(`${API_BASE}/api/health`);
      if (data.status === "ok") {
        setHealth({ status: "ok" });
      } else {
        setHealth({ status: "error", message: "Unexpected response from backend" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setHealth({ status: "error", message });
    }
  }, []);

  React.useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  React.useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      setDebugLastRuntimeError(`[window.error] ${e.message}`);
      debugLog(`[window.error] message=${e.message} file=${e.filename}:${e.lineno}:${e.colno}`);
      if (e.error && typeof e.error === "object" && "stack" in e.error) {
        debugLog(`[window.error.stack] ${String((e.error as { stack?: unknown }).stack ?? "")}`);
      }
    };
    const onRej = (e: PromiseRejectionEvent) => {
      setDebugLastRuntimeError(`[window.unhandledrejection] ${String(e.reason)}`);
      debugLog(`[window.unhandledrejection] ${String(e.reason)}`);
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    void window.opencyto?.getDebugLogPath?.().then((p) => {
      setDebugLogPath(p);
      debugLog(`[debug.log.path] ${p}`);
    });
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, [debugLog]);

  React.useEffect(() => {
    try {
      globalThis.localStorage?.setItem("freecyto_plot_bg", plotBgMode);
    } catch {
      /* ignore */
    }
  }, [plotBgMode]);

  type EventsResponse = { channel_names: string[]; events: number[][]; };

  function normalisePoints(rawPoints: ScatterPoint[]): {
    points: ScatterPoint[];
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
  } | null {
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

  // Intentionally `[]`: uses only `plotRequestGenerationRef` and React state setters (stable). Pass all varying inputs as arguments.
  const fetchEventsAndPlot = React.useCallback(
    async (
      fileId: string,
      x: string,
      y: string,
      tx: string,
      ty: string,
      plotGeneration: number,
    ) => {
      const params = new URLSearchParams({
        max_events: "15000",
        x_channel: x,
        y_channel: y,
        transform_x: tx,
        transform_y: ty,
      });
      const eventsResp = await getJson<EventsResponse>(
        `${API_BASE}/api/files/${encodeURIComponent(fileId)}/events?${params}`,
      );
      if (plotGeneration !== plotRequestGenerationRef.current) return;
      const rawPoints: ScatterPoint[] = eventsResp.events.map((row) => ({
        x: row[0] ?? 0,
        y: row[1] ?? 0,
      }));
      const result = normalisePoints(rawPoints);
      if (plotGeneration !== plotRequestGenerationRef.current) return;
      if (!result) throw new Error("No events returned for plotting");
      debugLog(
        `[fetchEventsAndPlot] file=${fileId} tx=${tx} ty=${ty} points=${rawPoints.length} xRange=[${result.xMin},${result.xMax}] yRange=[${result.yMin},${result.yMax}]`,
      );
      setTransformedRange({
        xMin: result.xMin,
        xMax: result.xMax,
        yMin: result.yMin,
        yMax: result.yMax,
      });
      setPoints(result.points);
      setDensity(null);
    },
    [],
  );

  type DensityResponse = {
    file_id: string;
    x_channel: string;
    y_channel: string;
    transform_x: string | null;
    transform_y: string | null;
    x_min: number;
    x_max: number;
    y_min: number;
    y_max: number;
    bins_x: number;
    bins_y: number;
    counts: number[][];
  };

  // Intentionally `[]` — same rationale as `fetchEventsAndPlot`.
  const fetchDensityAndPlot = React.useCallback(
    async (fileId: string, x: string, y: string, tx: string, ty: string, plotGeneration: number) => {
      const params = new URLSearchParams({
        x_channel: x,
        y_channel: y,
        transform_x: tx,
        transform_y: ty,
        bins_x: "200",
        bins_y: "200",
        max_events: "200000",
      });
      const densityResp = await getJson<DensityResponse>(
        `${API_BASE}/api/files/${encodeURIComponent(fileId)}/density?${params}`,
      );
      if (plotGeneration !== plotRequestGenerationRef.current) return;
      const nextDensity: DensityData = {
        binsX: densityResp.bins_x,
        binsY: densityResp.bins_y,
        xMin: densityResp.x_min,
        xMax: densityResp.x_max,
        yMin: densityResp.y_min,
        yMax: densityResp.y_max,
        counts: densityResp.counts,
      };
      if (plotGeneration !== plotRequestGenerationRef.current) return;
      setTransformedRange({
        xMin: nextDensity.xMin,
        xMax: nextDensity.xMax,
        yMin: nextDensity.yMin,
        yMax: nextDensity.yMax,
      });
      setPoints([]);
      setDensity(nextDensity);
    },
    [],
  );

  // Intentionally `[]` — same rationale as `fetchEventsAndPlot`.
  const fetchGateDensityAndPlot = React.useCallback(
    async (gateId: string, x: string, y: string, tx: string, ty: string, plotGeneration: number) => {
      const params = new URLSearchParams({
        x_channel: x,
        y_channel: y,
        transform_x: tx,
        transform_y: ty,
        bins_x: "200",
        bins_y: "200",
        max_events: "200000",
      });
      const densityResp = await getJson<DensityResponse>(
        `${API_BASE}/api/gates/${encodeURIComponent(gateId)}/density?${params}`,
      );
      if (plotGeneration !== plotRequestGenerationRef.current) return;
      const nextDensity: DensityData = {
        binsX: densityResp.bins_x,
        binsY: densityResp.bins_y,
        xMin: densityResp.x_min,
        xMax: densityResp.x_max,
        yMin: densityResp.y_min,
        yMax: densityResp.y_max,
        counts: densityResp.counts,
      };
      if (plotGeneration !== plotRequestGenerationRef.current) return;
      setTransformedRange({
        xMin: nextDensity.xMin,
        xMax: nextDensity.xMax,
        yMin: nextDensity.yMin,
        yMax: nextDensity.yMax,
      });
      setPoints([]);
      setDensity(nextDensity);
    },
    [],
  );

  /** Always pass an explicit path from the browse dialog (`paths[0]`). */
  const handleLoadFcs = React.useCallback(async (path: string) => {
    const pathTrim = path.trim();
    if (!pathTrim) return;
    setFcsStatus("loading");
    setFcsError(null);
    setPoints([]);
    setDensity(null);
    setFile(null);
    setChannels([]);
    setXChannel("");
    setYChannel("");

    try {
      type LoadResponse = {
        files: Array<{
          id: string;
          path: string;
          sample_name?: string | null;
          event_count: number;
          channels: Array<{ name: string; index: number; stain: string | null; display_name: string; range: number | null }>;
          spillover?: number[][] | null;
        }>;
      };

      const loadResp = await postJson<LoadResponse>(`${API_BASE}/api/files/load`, {
        paths: [pathTrim],
        downsample_events: 50000,
      });

      if (!loadResp.files.length) throw new Error("Backend returned no files");
      const first = loadResp.files[0];
      const firstChannels: ChannelInfo[] = first.channels.map((c) => ({
        name: c.name,
        index: c.index,
        stain: c.stain ?? null,
        display_name: c.display_name ?? c.name,
        ui_label: getUiChannelLabel(c.name, c.display_name ?? c.name, first.path ?? first.sample_name ?? null),
        range: c.range ?? null,
      }));
      const names = firstChannels.map((c) => c.name);
      const xPref = ["FSC-A", "FSC", "FSC-H"];
      const yPref = ["SSC-A", "SSC", "SSC-H"];
      const pick = (prefs: string[]) => prefs.find((p) => names.includes(p)) ?? null;
      let xName = pick(xPref) ?? names[0] ?? "";
      let yName = pick(yPref) ?? names[1] ?? names[0] ?? "";

      const loaded: LoadedFile = {
        id: first.id,
        path: first.path,
        sample_name: first.sample_name,
        event_count: first.event_count,
        channels: names,
        spillover: first.spillover ?? null,
      };
      setFile(loaded);
      setLoadedFiles((prev) => {
        const existingIdx = prev.findIndex((f) => f.id === loaded.id);
        if (existingIdx === -1) return [...prev, loaded];
        const copy = prev.slice();
        copy[existingIdx] = loaded;
        return copy;
      });
      setChannels(firstChannels);
      setXChannel(xName);
      setYChannel(yName);
      setTransformX("linear");
      setTransformY("linear");
      perFileAxesRef.current.set(loaded.id, { x: xName, y: yName, tx: "linear", ty: "linear" });
      setFcsStatus("loaded");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFcsError(message);
      setFcsStatus("error");
    }
  }, []);

  // Refetch events when file, axes, transform, or active gate changes.
  // Invariant: `handleLoadFcs` clears x/y then sets file + channels in one React 18 batch so this effect
  // does not run with a new `file.id` and stale channels (FRONTEND_APP_REVIEW NEW-4).
  React.useEffect(() => {
    if (!file?.id || !xChannel || !yChannel) return;
    const plotGeneration = ++plotRequestGenerationRef.current;
    debugLog(
      `[plotEffect.start] gen=${plotGeneration} file=${file.id} x=${xChannel} y=${yChannel} tx=${transformX} ty=${transformY} gate=${activeGateId ?? "root"} mode=${plotMode}`,
    );
    setFcsError(null);
    setFcsStatus("loading");
    setTransformedRange(null);
    setDensity(null);
    void (async () => {
      try {
        if (activeGateId) {
          if (plotMode === "density") {
            await fetchGateDensityAndPlot(
              activeGateId,
              xChannel,
              yChannel,
              transformX,
              transformY,
              plotGeneration,
            );
            if (plotGeneration === plotRequestGenerationRef.current) setFcsStatus("loaded");
          } else {
            const params = new URLSearchParams({
              x_channel: xChannel,
              y_channel: yChannel,
              transform_x: transformX,
              transform_y: transformY,
              max_events: "15000",
            });
            const eventsResp = await getJson<EventsResponse>(
              `${API_BASE}/api/gates/${encodeURIComponent(activeGateId)}/events?${params}`,
            );
            if (plotGeneration !== plotRequestGenerationRef.current) return;
            const rawPoints: ScatterPoint[] = eventsResp.events.map((row) => ({
              x: row[0] ?? 0,
              y: row[1] ?? 0,
            }));
            const result = normalisePoints(rawPoints);
            if (plotGeneration !== plotRequestGenerationRef.current) return;
            if (!result) {
              setPoints([]);
              setTransformedRange(null);
              setFcsStatus("loaded");
            } else {
              setTransformedRange({
                xMin: result.xMin,
                xMax: result.xMax,
                yMin: result.yMin,
                yMax: result.yMax,
              });
              setPoints(result.points);
              setFcsStatus("loaded");
            }
          }
        } else {
          if (plotMode === "density") {
            await fetchDensityAndPlot(
              file.id,
              xChannel,
              yChannel,
              transformX,
              transformY,
              plotGeneration,
            );
          } else {
            await fetchEventsAndPlot(
              file.id,
              xChannel,
              yChannel,
              transformX,
              transformY,
              plotGeneration,
            );
          }
          if (plotGeneration === plotRequestGenerationRef.current) setFcsStatus("loaded");
        }
      } catch (err) {
        if (plotGeneration !== plotRequestGenerationRef.current) return;
        debugLog(
          `[plotEffect.error] gen=${plotGeneration} msg=${err instanceof Error ? `${err.message} stack=${err.stack ?? ""}` : String(err)}`,
        );
        setFcsError(err instanceof Error ? err.message : String(err));
        setFcsStatus("error");
      }
    })();
  }, [
    file?.id,
    xChannel,
    yChannel,
    transformX,
    transformY,
    activeGateId,
    plotMode,
    fetchEventsAndPlot,
    fetchDensityAndPlot,
    fetchGateDensityAndPlot,
  ]);

  const fetchGateTree = React.useCallback(async (fileId: string) => {
    setGateTreeLoading(true);
    setGateTreeError(null);
    try {
      const tree = await getJson<GateNode[]>(
        `${API_BASE}/api/files/${encodeURIComponent(fileId)}/gates`,
      );
      setGateTree(Array.isArray(tree) ? tree : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setGateTreeError(message);
      // Keep previous gateTree on error so we don't wipe the list on transient failures
    } finally {
      setGateTreeLoading(false);
    }
  }, []);

  const loadWorkspaceFromParsedBody = React.useCallback(
    async (body: unknown) => {
      type LoadResult = {
        files_loaded: number;
        compensation_applied: number;
        gates_created: number;
        file_metadata: Array<{
          id: string;
          path: string;
          sample_name?: string | null;
          event_count: number;
          channels: Array<{
            name: string;
            index: number;
            stain: string | null;
            display_name: string;
            range: number | null;
          }>;
          spillover?: number[][] | null;
        }>;
        gates: Array<{
          id: string;
          file_id: string;
          name: string;
          type: string;
          count: number;
          pct_total: number;
          pct_of_parent: number;
        }>;
      };
      type WorkspaceAxesShape = {
        default_axes?: Record<string, Record<string, unknown>>;
        gates?: Array<{ file_id?: string; transform_x?: unknown; transform_y?: unknown }>;
      };
      const coerceAxisTransform = (v: unknown): "linear" | "log" | "arcsinh" | "logicle" =>
        v === "log" || v === "arcsinh" || v === "logicle" || v === "linear" ? v : "linear";

      const loadResult = await postJson<LoadResult>(`${API_BASE}/api/workspace/load`, body);
      const meta = loadResult.file_metadata;
      if (!meta.length) return;
      const firstMeta = meta[0]!;
      const firstChannels: ChannelInfo[] = firstMeta.channels.map((c) => ({
        name: c.name,
        index: c.index,
        stain: c.stain ?? null,
        display_name: c.display_name ?? c.name,
        ui_label: getUiChannelLabel(c.name, c.display_name ?? c.name, firstMeta.path ?? firstMeta.sample_name ?? null),
        range: c.range ?? null,
      }));
      const names = firstChannels.map((c) => c.name);
      const loaded: LoadedFile[] = meta.map((m) => ({
        id: m.id,
        path: m.path,
        sample_name: m.sample_name,
        event_count: m.event_count,
        channels: m.channels.map((c) => c.name),
        spillover: m.spillover ?? null,
      }));
      const wsShape = body as WorkspaceAxesShape;
      const firstId = firstMeta.id;
      const axes = wsShape.default_axes?.[firstId];
      let nextTx: "linear" | "log" | "arcsinh" | "logicle" = "linear";
      let nextTy: "linear" | "log" | "arcsinh" | "logicle" = "linear";
      if (axes && (axes.transform_x !== undefined || axes.transform_y !== undefined)) {
        nextTx = coerceAxisTransform(axes.transform_x);
        nextTy = coerceAxisTransform(axes.transform_y);
      } else {
        const g0 = wsShape.gates?.find((g) => g.file_id === firstId);
        if (g0) {
          nextTx = coerceAxisTransform(g0.transform_x);
          nextTy = coerceAxisTransform(g0.transform_y);
        }
      }
      let xName = names[0] ?? "";
      let yName = names[1] ?? names[0] ?? "";
      if (typeof axes?.x_channel === "string" && names.includes(axes.x_channel)) xName = axes.x_channel;
      if (typeof axes?.y_channel === "string" && names.includes(axes.y_channel)) yName = axes.y_channel;

      setLoadedFiles(loaded);
      setFile(loaded[0] ?? null);
      setChannels(firstChannels);
      setXChannel(xName);
      setYChannel(yName);
      setTransformX(nextTx);
      setTransformY(nextTy);
      setFcsPath(loaded[0]?.path ?? "");
      setFcsStatus("loaded");
      setFcsError(null);
      if (loaded[0]?.id) {
        await fetchGateTree(loaded[0].id);
        const pg = ++plotRequestGenerationRef.current;
        if (plotMode === "density") {
          await fetchDensityAndPlot(loaded[0].id, xName, yName, nextTx, nextTy, pg);
        } else {
          await fetchEventsAndPlot(loaded[0].id, xName, yName, nextTx, nextTy, pg);
        }
      }
    },
    [fetchGateTree, fetchEventsAndPlot, fetchDensityAndPlot, plotMode],
  );

  const loadWorkspaceLatestRef = React.useRef(loadWorkspaceFromParsedBody);
  loadWorkspaceLatestRef.current = loadWorkspaceFromParsedBody;

  React.useEffect(() => {
    if (health.status !== "ok") return;
    if (sessionRestoreAttemptedRef.current) return;
    sessionRestoreAttemptedRef.current = true;
    void (async () => {
      try {
        const r = await getJson<{ available: boolean; workspace?: Record<string, unknown> }>(
          `${API_BASE}/api/session/restore`,
        );
        if (!r.available || !r.workspace) return;
        const ok = window.confirm("Restore your previous OpenCyto session from the server?");
        if (!ok) return;
        await loadWorkspaceLatestRef.current(r.workspace);
      } catch {
        /* ignore */
      }
    })();
  }, [health.status]);

  React.useEffect(() => {
    if (file?.id) void fetchGateTree(file.id);
    else setGateTree([]);
    setGateMessage(null);
    setActiveGateId(null);
  }, [file?.id, fetchGateTree]);

  const clearGatesForTransformChange = React.useCallback(async () => {
    if (!file?.id) return;
    if (gateList.length === 0) return;
    try {
      await fetch(`${API_BASE}/api/files/${encodeURIComponent(file.id)}/gates`, {
        method: "DELETE",
      });
    } catch {
      /* best effort */
    }
    setGateTree([]);
    setActiveGateId(null);
    setGateMessage("Gates cleared (display transform changed).");
  }, [file?.id, gateList.length]);

  React.useEffect(() => {
    if (!gateMessage) return;
    const t = setTimeout(() => setGateMessage(null), 5000);
    return () => clearTimeout(t);
  }, [gateMessage]);

  React.useEffect(() => {
    if (!(drawMode && gateTool === "polygon")) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setDrawingPolygon(null);
        setPendingGate(null);
        setDrawMode(false);
        setGateTool(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [drawMode, gateTool]);

  const plotContainerRef = React.useRef<HTMLDivElement>(null);
  const [plotSize, setPlotSize] = React.useState({ w: 480, h: 360 });
  React.useEffect(() => {
    const el = plotContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0]?.contentRect ?? { width: 480 };
      if (width > 0) {
        const w = Math.max(420, Math.min(Math.round(width), 560));
        setPlotSize({ w, h: w });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = plotSize.w;
  const plotH = plotSize.h;
  const { ml, mr, mt, mb } = plotScaledMargins(plotW, plotH);
  const plotAreaW = plotW - ml - mr;
  const plotAreaH = plotH - mt - mb;
  const plotTickFill = plotBgMode === "white" ? "#1e293b" : "#e5e7eb";
  const plotInnerFill = plotBgMode === "white" ? "#ffffff" : "rgba(15,23,42,0.45)";
  const plotInnerStroke = plotBgMode === "white" ? "#cbd5e1" : "#4b5563";

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        background:
          "radial-gradient(circle at top, #0f172a 0, #020617 45%, #020617 100%)",
        color: "white",
        padding: "clamp(1rem, 3vw, 2.5rem)",
        boxSizing: "border-box",
      }}
    >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(260px, 320px) minmax(0, 1fr)",
              gap: "clamp(1rem, 2vw, 2.25rem)",
              alignItems: "start",
              width: "100%",
              maxWidth: "min(1200px, 100%)",
              margin: "0 auto",
            }}
          >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1.25rem",
            minWidth: 0,
          }}
        >
        <div
          style={{
            padding: "1.75rem 1.75rem",
            borderRadius: "1.25rem",
            background:
              "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.85))",
            boxShadow:
              "0 20px 50px rgba(15,23,42,0.9), 0 0 0 1px rgba(148,163,184,0.3)",
          }}
        >
          <h1
            style={{
              fontSize: "1.6rem",
              marginBottom: "0.5rem",
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "#e5e7eb",
            }}
          >
            OpenCyto Studio
          </h1>
          <p
            style={{
              marginBottom: "1.25rem",
              color: "#9ca3af",
              fontSize: "0.95rem",
            }}
          >
            Local backend status (FastAPI at{" "}
            <code style={{ fontFamily: "monospace", color: "#c4b5fd" }}>
              127.0.0.1:8765
            </code>
            ).
          </p>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "0.8rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#9ca3af",
                  marginBottom: "0.35rem",
                }}
              >
                Backend Health
              </div>
              <div style={{ fontSize: "1.05rem", fontWeight: 500 }}>
                {health.status === "idle" && "Not checked yet"}
                {health.status === "loading" && "Checking..."}
                {health.status === "ok" && (
                  <span style={{ color: "#4ade80" }}>Connected</span>
                )}
                {health.status === "error" && (
                  <span style={{ color: "#f97373" }}>Error</span>
                )}
              </div>
              {health.status === "error" && (
                <div
                  style={{
                    marginTop: "0.35rem",
                    fontSize: "0.8rem",
                    color: "#fca5a5",
                    maxWidth: "18rem",
                  }}
                >
                  {health.message}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => void checkHealth()}
              style={{
                padding: "0.55rem 1.1rem",
                borderRadius: "999px",
                border: "none",
                fontSize: "0.9rem",
                fontWeight: 500,
                cursor: "pointer",
                background:
                  "linear-gradient(135deg, #6366f1, #8b5cf6, #ec4899)",
                color: "white",
                boxShadow:
                  "0 10px 30px rgba(129,140,248,0.6), 0 0 0 1px rgba(129,140,248,0.5)",
                whiteSpace: "nowrap",
              }}
            >
              Re-check
            </button>
          </div>
        </div>

        <div
          style={{
            padding: "1.25rem 1.75rem",
            borderRadius: "1.25rem",
            background:
              "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.85))",
            boxShadow:
              "0 20px 50px rgba(15,23,42,0.9), 0 0 0 1px rgba(148,163,184,0.3)",
          }}
        >
          <div
            style={{
              fontSize: "0.8rem",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "#9ca3af",
              marginBottom: "0.75rem",
            }}
          >
            Workspace
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={async () => {
                try {
                  const res = await fetch(`${API_BASE}/api/workspace/save`, { method: "POST" });
                  if (!res.ok) throw new Error(await res.text());
                  type WsFile = { path: string; id?: string | null; n_channels?: number | null };
                  type WorkspaceSavePayload = {
                    version?: number;
                    files: WsFile[];
                    compensation: unknown;
                    gates: unknown[];
                    default_axes?: Record<
                      string,
                      { x_channel: string; y_channel: string; transform_x: string; transform_y: string }
                    >;
                  };
                  const ws = (await res.json()) as WorkspaceSavePayload;
                  const mergedAxes: NonNullable<WorkspaceSavePayload["default_axes"]> = {
                    ...(ws.default_axes ?? {}),
                  };
                  for (const entry of ws.files) {
                    const fid = entry.id;
                    if (!fid) continue;
                    if (file?.id === fid && xChannel && yChannel) {
                      mergedAxes[fid] = {
                        x_channel: xChannel,
                        y_channel: yChannel,
                        transform_x: transformX,
                        transform_y: transformY,
                      };
                    } else {
                      const saved = perFileAxesRef.current.get(fid);
                      if (saved?.x && saved.y) {
                        mergedAxes[fid] = {
                          x_channel: saved.x,
                          y_channel: saved.y,
                          transform_x: saved.tx,
                          transform_y: saved.ty,
                        };
                      }
                    }
                  }
                  const wsOut = { ...ws, default_axes: mergedAxes };
                  const result =
                    (await window.opencyto?.saveWorkspaceFile?.(JSON.stringify(wsOut, null, 2))) ?? { canceled: true };
                  if (!result.canceled) setFcsError(null);
                } catch (err) {
                  setFcsError(err instanceof Error ? err.message : String(err));
                }
              }}
              style={{
                padding: "0.4rem 0.8rem",
                borderRadius: "0.5rem",
                border: "1px solid rgba(148,163,184,0.5)",
                fontSize: "0.85rem",
                cursor: "pointer",
                background: "rgba(30,41,59,0.6)",
                color: "#e5e7eb",
              }}
            >
              Save workspace
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  const result = (await window.opencyto?.loadWorkspaceFile?.()) ?? { canceled: true };
                  if (result.canceled || !result.content) return;
                  const body = JSON.parse(result.content) as unknown;
                  await loadWorkspaceFromParsedBody(body);
                } catch (err) {
                  setFcsError(err instanceof Error ? err.message : String(err));
                }
              }}
              style={{
                padding: "0.4rem 0.8rem",
                borderRadius: "0.5rem",
                border: "1px solid rgba(74,222,128,0.5)",
                fontSize: "0.85rem",
                cursor: "pointer",
                background: "rgba(34,197,94,0.15)",
                color: "#4ade80",
              }}
            >
              Load workspace
            </button>
          </div>
        </div>
        <div
          style={{
            padding: "0.9rem 1rem",
            borderRadius: "0.9rem",
            background: "rgba(127,29,29,0.18)",
            border: "1px solid rgba(248,113,113,0.45)",
          }}
        >
          <div
            style={{
              fontSize: "0.72rem",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "#fca5a5",
              marginBottom: "0.35rem",
            }}
          >
            Crash Debug (Temporary)
          </div>
          <div style={{ fontSize: "0.78rem", color: "#fecaca", marginBottom: "0.35rem", wordBreak: "break-all" }}>
            <strong>Log file:</strong> {debugLogPath || "(not available)"}
          </div>
          {debugLastRuntimeError && (
            <div style={{ fontSize: "0.78rem", color: "#fee2e2", marginBottom: "0.35rem" }}>
              <strong>Last runtime error:</strong> {debugLastRuntimeError}
            </div>
          )}
          {debugUiStatus && (
            <div style={{ fontSize: "0.75rem", color: "#fca5a5", marginBottom: "0.35rem" }}>
              {debugUiStatus}
            </div>
          )}
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={async () => {
                const r = await window.opencyto?.clearDebugLog?.();
                if (r?.ok) {
                  setDebugUiStatus(`Cleared log at ${r.path ?? debugLogPath}`);
                  debugLog("[ui.debug] cleared log");
                } else {
                  setDebugUiStatus(`Failed to clear log: ${r?.error ?? "unknown"}`);
                }
              }}
              style={{
                padding: "0.25rem 0.55rem",
                borderRadius: "0.35rem",
                border: "1px solid rgba(252,165,165,0.65)",
                fontSize: "0.75rem",
                cursor: "pointer",
                background: "transparent",
                color: "#fecaca",
              }}
            >
              Clear debug log
            </button>
            <button
              type="button"
              onClick={() => {
                const snapshot = `[ui.debug.snapshot] file=${file?.id ?? "none"} tx=${transformX} ty=${transformY} x=${xChannel} y=${yChannel} status=${fcsStatus}`;
                debugLog(snapshot);
                setDebugUiStatus("Wrote state snapshot to debug log");
              }}
              style={{
                padding: "0.25rem 0.55rem",
                borderRadius: "0.35rem",
                border: "1px solid rgba(252,165,165,0.65)",
                fontSize: "0.75rem",
                cursor: "pointer",
                background: "transparent",
                color: "#fecaca",
              }}
            >
              Write state snapshot
            </button>
          </div>
        </div>
        </div>

        <div
          style={{
            minWidth: 0,
            width: "100%",
            display: "flex",
            flexDirection: "column",
          }}
        >
        <div
          style={{
            padding: "1.75rem 1.75rem",
            borderRadius: "1.25rem",
            background:
              "linear-gradient(145deg, rgba(15,23,42,0.97), rgba(15,23,42,0.9))",
            boxShadow:
              "0 24px 60px rgba(15,23,42,0.95), 0 0 0 1px rgba(148,163,184,0.35)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "1rem",
              gap: "1rem",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "0.8rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "#9ca3af",
                  marginBottom: "0.25rem",
                }}
              >
                Quick FSC/SSC Preview
              </div>
              <div style={{ fontSize: "1.05rem", fontWeight: 500 }}>
                Load a single FCS file and see an FSC vs SSC dot plot.
              </div>
            </div>
          </div>

          <div
            style={{
              position: "relative",
              marginBottom: "0.75rem",
            }}
          >
            <input
              type="text"
              value={fcsPath}
              readOnly
              placeholder="Select FCS file…"
              style={{
                width: "100%",
                padding: "0.55rem 7.5rem 0.55rem 0.75rem",
                borderRadius: "0.75rem",
                border: "1px solid rgba(148,163,184,0.7)",
                backgroundColor: "rgba(15,23,42,0.35)",
                color: "white",
                fontSize: "0.9rem",
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  const paths = (await window.opencyto?.openFcsFiles?.()) ?? [];
                  if (!paths || paths.length === 0) return;
                  // For now, load the first selected file; later we can batch.
                  setFcsPath(paths[0]);
                  await handleLoadFcs(paths[0]);
                } catch (err) {
                  setFcsError(err instanceof Error ? err.message : String(err));
                }
              }}
              disabled={fcsStatus === "loading"}
              style={{
                position: "absolute",
                right: "0.25rem",
                top: "0.2rem",
                padding: "0.45rem 0.9rem",
                borderRadius: "0.7rem",
                border: "none",
                fontSize: "0.85rem",
                fontWeight: 500,
                cursor: "pointer",
                background:
                  "linear-gradient(135deg, #22c55e, #16a34a, #22c55e)",
                color: "white",
                opacity: fcsStatus === "loading" ? 0.7 : 1,
                whiteSpace: "nowrap",
                boxShadow: "0 8px 20px rgba(34,197,94,0.45)",
              }}
            >
              {fcsStatus === "loading" ? "Loading…" : "Browse FCS…"}
            </button>
          </div>

          {loadedFiles.length > 0 && (
            <div
              style={{
                marginBottom: "0.8rem",
                padding: "0.45rem 0.55rem",
                borderRadius: "0.7rem",
                background: "rgba(15,23,42,0.9)",
                border: "1px solid rgba(148,163,184,0.4)",
                maxHeight: "6.5rem",
                overflowY: "auto",
              }}
            >
              <div
                style={{
                  fontSize: "0.75rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#9ca3af",
                  marginBottom: "0.25rem",
                }}
              >
                Loaded files
              </div>
              {loadedFiles.map((lf) => {
                const isActive = file?.id === lf.id;
                return (
                  <button
                    key={lf.id}
                    type="button"
                    onClick={async () => {
                      if (file?.id && file.id !== lf.id) {
                        perFileAxesRef.current.set(file.id, {
                          x: xChannel,
                          y: yChannel,
                          tx: transformX,
                          ty: transformY,
                        });
                      }
                      setActiveGateId(null);
                      setFcsStatus("loading");
                      try {
                        type ChannelsResp = {
                          id: string;
                          path: string;
                          sample_name?: string | null;
                          event_count: number;
                          channels: Array<{ name: string; index: number; stain: string | null; display_name: string; range: number | null }>;
                          spillover?: number[][] | null;
                        };
                        const meta = await getJson<ChannelsResp>(
                          `${API_BASE}/api/files/${encodeURIComponent(lf.id)}/channels`,
                        );
                        const channelMeta: ChannelInfo[] = meta.channels.map((c) => ({
                          name: c.name,
                          index: c.index,
                          stain: c.stain ?? null,
                          display_name: c.display_name ?? c.name,
                          ui_label: getUiChannelLabel(c.name, c.display_name ?? c.name, meta.path ?? meta.sample_name ?? null),
                          range: c.range ?? null,
                        }));
                        const names = channelMeta.map((c) => c.name);
                        const updated: LoadedFile = {
                          ...lf,
                          event_count: meta.event_count,
                          channels: names,
                          spillover: meta.spillover ?? lf.spillover ?? null,
                        };
                        const saved = perFileAxesRef.current.get(lf.id);
                        setFile(updated);
                        setChannels(channelMeta);
                        setXChannel(saved?.x && names.includes(saved.x) ? saved.x : names[0] ?? "");
                        setYChannel(saved?.y && names.includes(saved.y) ? saved.y : names[1] ?? names[0] ?? "");
                        if (saved) {
                          setTransformX(saved.tx ?? "linear");
                          setTransformY(saved.ty ?? "linear");
                        } else {
                          setTransformX("linear");
                          setTransformY("linear");
                        }
                        setLoadedFiles((prev) =>
                          prev.map((f) => (f.id === lf.id ? updated : f)),
                        );
                        setFcsStatus("loaded");
                      } catch {
                        setFile(lf);
                        setChannels(
                          lf.channels.map((name, idx) => ({
                            name,
                            index: idx + 1,
                            stain: null,
                            display_name: name,
                            ui_label: getUiChannelLabel(name, name, lf.path),
                            range: null,
                          })),
                        );
                        const saved = perFileAxesRef.current.get(lf.id);
                        setXChannel(saved?.x ?? lf.channels[0] ?? "");
                        setYChannel(saved?.y ?? lf.channels[1] ?? lf.channels[0] ?? "");
                        if (saved) {
                          setTransformX(saved.tx ?? "linear");
                          setTransformY(saved.ty ?? "linear");
                        } else {
                          setTransformX("linear");
                          setTransformY("linear");
                        }
                        setFcsStatus("loaded");
                      }
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "0.25rem 0.4rem",
                      borderRadius: "0.45rem",
                      border: "none",
                      backgroundColor: isActive
                        ? "rgba(34,197,94,0.18)"
                        : "transparent",
                      color: isActive ? "#bbf7d0" : "#e5e7eb",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                    }}
                  >
                    {lf.sample_name || lf.path.split(/[/\\\\]/).pop()}
                  </button>
                );
              })}
            </div>
          )}

          {file && (
            <>
              <div
                style={{
                  fontSize: "0.8rem",
                  color: "#9ca3af",
                  marginBottom: "0.5rem",
                }}
              >
                <div>
                  <strong>Sample:</strong>{" "}
                  {file.sample_name || file.path.split(/[/\\]/).pop()}
                </div>
                <div data-testid="file-event-count">
                  <strong>Events:</strong> {file.event_count.toLocaleString()}
                </div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "0.5rem 1rem",
                  marginBottom: "0.7rem",
                  alignItems: "center",
                }}
              >
                <label style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
                  X channel
                  <select
                    value={xChannel}
                    onChange={(e) => setXChannel(e.target.value)}
                    style={{
                      display: "block",
                      marginTop: "0.2rem",
                      width: "100%",
                      padding: "0.35rem",
                      borderRadius: "0.4rem",
                      border: "1px solid rgba(148,163,184,0.5)",
                      background: "rgba(15,23,42,0.8)",
                      color: "white",
                      fontSize: "0.85rem",
                    }}
                  >
                    {channels.map((ch) => (
                      <option key={ch.name} value={ch.name}>
                        {ch.ui_label}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
                  Y channel
                  <select
                    value={yChannel}
                    onChange={(e) => setYChannel(e.target.value)}
                    style={{
                      display: "block",
                      marginTop: "0.2rem",
                      width: "100%",
                      padding: "0.35rem",
                      borderRadius: "0.4rem",
                      border: "1px solid rgba(148,163,184,0.5)",
                      background: "rgba(15,23,42,0.8)",
                      color: "white",
                      fontSize: "0.85rem",
                    }}
                  >
                    {channels.map((ch) => (
                      <option key={ch.name} value={ch.name}>
                        {ch.ui_label}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
                  X transform
                  <select
                    value={transformX}
                    onChange={(e) => {
                      void (async () => {
                        const value = e.target.value as "linear" | "log" | "arcsinh" | "logicle";
                        debugLog(`[ui.transformX.change] from=${transformX} to=${value} file=${file?.id ?? "none"}`);
                        // Clear current range immediately so AxisTicks never renders a stale linear range as log.
                        setTransformedRange(null);
                        setPoints([]);
                        setDensity(null);
                        setActiveGateId(null);
                        setPendingGate(null);
                        setDrawingRect(null);
                        setDrawingPolygon(null);
                        await clearGatesForTransformChange();
                        setTransformX(value);
                        debugLog(`[ui.transformX.applied] value=${value}`);
                      })();
                    }}
                    style={{
                      display: "block",
                      marginTop: "0.2rem",
                      width: "100%",
                      padding: "0.35rem",
                      borderRadius: "0.4rem",
                      border: "1px solid rgba(148,163,184,0.5)",
                      background: "rgba(15,23,42,0.8)",
                      color: "white",
                      fontSize: "0.85rem",
                    }}
                  >
                    <option value="linear">Linear</option>
                    <option value="log">Log</option>
                    <option value="arcsinh">Arcsinh</option>
                    <option value="logicle">Logicle</option>
                  </select>
                </label>
                <label style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
                  Y transform
                  <select
                    value={transformY}
                    onChange={(e) => {
                      void (async () => {
                        const value = e.target.value as "linear" | "log" | "arcsinh" | "logicle";
                        debugLog(`[ui.transformY.change] from=${transformY} to=${value} file=${file?.id ?? "none"}`);
                        // Clear current range immediately so AxisTicks never renders a stale linear range as log.
                        setTransformedRange(null);
                        setPoints([]);
                        setDensity(null);
                        setActiveGateId(null);
                        setPendingGate(null);
                        setDrawingRect(null);
                        setDrawingPolygon(null);
                        await clearGatesForTransformChange();
                        setTransformY(value);
                        debugLog(`[ui.transformY.applied] value=${value}`);
                      })();
                    }}
                    style={{
                      display: "block",
                      marginTop: "0.2rem",
                      width: "100%",
                      padding: "0.35rem",
                      borderRadius: "0.4rem",
                      border: "1px solid rgba(148,163,184,0.5)",
                      background: "rgba(15,23,42,0.8)",
                      color: "white",
                      fontSize: "0.85rem",
                    }}
                  >
                    <option value="linear">Linear</option>
                    <option value="log">Log</option>
                    <option value="arcsinh">Arcsinh</option>
                    <option value="logicle">Logicle</option>
                  </select>
                </label>
              </div>

              <div
                style={{
                  marginTop: "0.4rem",
                  marginBottom: "0.7rem",
                  fontSize: "0.8rem",
                  color: "#9ca3af",
                }}
              >
                <div style={{ marginBottom: "0.25rem" }}>
                  <strong>Compensation (optional)</strong>
                </div>
                <div style={{ marginBottom: "0.25rem" }}>
                  Paste a square spillover matrix (comma-separated, one row per line)
                  matching this file&apos;s channel order.
                </div>
                {file?.spillover && file.spillover.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const text = file.spillover!
                        .map((row) => row.join(","))
                        .join("\n");
                      setCompText(text);
                      setCompStatus("idle");
                      setCompError(null);
                    }}
                    style={{
                      marginBottom: "0.35rem",
                      padding: "0.3rem 0.6rem",
                      borderRadius: "0.4rem",
                      border: "1px solid rgba(74,222,128,0.6)",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                      background: "rgba(34,197,94,0.2)",
                      color: "#4ade80",
                    }}
                  >
                    Use file spillover
                  </button>
                )}
                <textarea
                  value={compText}
                  onChange={(e) => {
                    setCompText(e.target.value);
                    setCompStatus("idle");
                    setCompError(null);
                  }}
                  rows={3}
                  placeholder={"1,0,0\n0,1,0\n0,0,1"}
                  style={{
                    width: "100%",
                    borderRadius: "0.6rem",
                    border: "1px solid rgba(148,163,184,0.6)",
                    backgroundColor: "rgba(15,23,42,0.7)",
                    color: "white",
                    fontSize: "0.8rem",
                    padding: "0.4rem 0.5rem",
                    fontFamily: "monospace",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: "0.35rem",
                    gap: "0.5rem",
                  }}
                >
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <button
                    type="button"
                    disabled={compStatus === "applying" || !compText.trim()}
                    onClick={async () => {
                      if (!file) return;
                      setCompStatus("applying");
                      setCompError(null);
                      try {
                        const rows = compText
                          .split(/\r?\n/)
                          .map((line) =>
                            line
                              .trim()
                              .split(/[,\t]/)
                              .filter((v) => v.length > 0)
                              .map((v) => Number(v)),
                          )
                          .filter((r) => r.length > 0);
                        if (!rows.length) {
                          throw new Error("Compensation matrix is empty");
                        }
                        const n = rows[0].length;
                        if (!rows.every((r) => r.length === n)) {
                          throw new Error("Matrix must be square (same row length)");
                        }
                        const body = { file_id: file.id, spillover: rows };
                        await postJson(`${API_BASE}/api/compensation/apply`, body);
                        setCompStatus("success");
                        const pg = ++plotRequestGenerationRef.current;
                        if (plotMode === "density") {
                          await fetchDensityAndPlot(file.id, xChannel, yChannel, transformX, transformY, pg);
                        } else {
                          await fetchEventsAndPlot(file.id, xChannel, yChannel, transformX, transformY, pg);
                        }
                      } catch (err) {
                        setCompStatus("error");
                        setCompError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    style={{
                      padding: "0.35rem 0.8rem",
                      borderRadius: "999px",
                      border: "none",
                      fontSize: "0.8rem",
                      fontWeight: 500,
                      cursor: "pointer",
                      background:
                        "linear-gradient(135deg, #22c55e, #16a34a, #22c55e)",
                      color: "white",
                      opacity: compStatus === "applying" ? 0.7 : 1,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {compStatus === "applying" ? "Applying…" : "Apply compensation"}
                  </button>
                  <button
                    type="button"
                    disabled={!file || compStatus === "applying"}
                    onClick={async () => {
                      if (!file) return;
                      setCompStatus("applying");
                      setCompError(null);
                      try {
                        const res = await fetch(
                          `${API_BASE}/api/compensation/${encodeURIComponent(file.id)}`,
                          { method: "DELETE" },
                        );
                        if (!res.ok) {
                          const t = await res.text();
                          throw new Error(t || `HTTP ${res.status}`);
                        }
                        setCompStatus("idle");
                        setCompError(null);
                        const pg = ++plotRequestGenerationRef.current;
                        if (plotMode === "density") {
                          await fetchDensityAndPlot(file.id, xChannel, yChannel, transformX, transformY, pg);
                        } else {
                          await fetchEventsAndPlot(file.id, xChannel, yChannel, transformX, transformY, pg);
                        }
                      } catch (err) {
                        setCompStatus("error");
                        setCompError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    style={{
                      padding: "0.35rem 0.8rem",
                      borderRadius: "999px",
                      border: "1px solid rgba(148,163,184,0.6)",
                      fontSize: "0.8rem",
                      fontWeight: 500,
                      cursor: "pointer",
                      background: "transparent",
                      color: "#94a3b8",
                    }}
                  >
                    Reset compensation
                  </button>
                  </div>
                  <div style={{ fontSize: "0.8rem" }}>
                    {compStatus === "success" && (
                      <span style={{ color: "#4ade80" }}>Applied</span>
                    )}
                    {compStatus === "error" && compError && (
                      <span style={{ color: "#fca5a5" }}>{compError}</span>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {fcsError && (
            <div
              style={{
                marginBottom: "0.7rem",
                fontSize: "0.8rem",
                color: "#fca5a5",
              }}
            >
              {fcsError}
            </div>
          )}

          {gateMessage && (
            <div
              style={{
                marginBottom: "0.5rem",
                fontSize: "0.8rem",
                color: "#93c5fd",
              }}
            >
              {gateMessage}
            </div>
          )}
          {gateNameError && (
            <div
              style={{
                marginBottom: "0.5rem",
                fontSize: "0.8rem",
                color: "#fca5a5",
              }}
            >
              {gateNameError}
            </div>
          )}
          {file && transformedRange && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: "0.35rem" }}>
                  {[
                    { id: "rectangle", label: "Rect" },
                    { id: "polygon", label: "Poly" },
                    { id: "quadrant", label: "Quad" },
                  ].map((tool) => {
                    const active = gateTool === tool.id;
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => {
                          const next = active ? null : (tool.id as typeof gateTool);
                          setGateTool(next);
                          setDrawMode(next !== null);
                          setPendingGate(null);
                          setDrawingRect(null);
                          setDrawingPolygon(null);
                          setGateNameError(null);
                        }}
                        style={{
                          padding: "0.25rem 0.6rem",
                          borderRadius: "999px",
                          border: active ? "1px solid rgba(74,222,128,0.9)" : "1px solid rgba(148,163,184,0.7)",
                          fontSize: "0.78rem",
                          cursor: "pointer",
                          background: active ? "rgba(34,197,94,0.3)" : "transparent",
                          color: active ? "#4ade80" : "#e5e7eb",
                        }}
                      >
                        {tool.label}
                      </button>
                    );
                  })}
                </div>
                {gateTool === "rectangle" && pendingGate && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      value={pendingGate.gateName}
                      onChange={(e) => {
                        setGateNameError(null);
                        setPendingGate((p) => (p ? { ...p, gateName: e.target.value } : null));
                      }}
                      placeholder="Gate name"
                      style={{
                        padding: "0.25rem 0.5rem",
                        width: "120px",
                        borderRadius: "0.35rem",
                        border: "1px solid rgba(148,163,184,0.6)",
                        background: "rgba(15,23,42,0.8)",
                        color: "white",
                        fontSize: "0.8rem",
                      }}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        if (!file || !pendingGate || !transformedRange) return;
                        const r = transformedRange;
                        const xMin = r.xMin + (r.xMax - r.xMin) * Math.min(pendingGate.nxMin, pendingGate.nxMax);
                        const xMax = r.xMin + (r.xMax - r.xMin) * Math.max(pendingGate.nxMin, pendingGate.nxMax);
                        const yMin = r.yMin + (r.yMax - r.yMin) * Math.min(pendingGate.nyMin, pendingGate.nyMax);
                        const yMax = r.yMin + (r.yMax - r.yMin) * Math.max(pendingGate.nyMin, pendingGate.nyMax);
                        const name = pendingGate.gateName.trim() || "Gate";
                        setGateNameError(null);
                        try {
                          await postJson(`${API_BASE}/api/gates`, {
                            file_id: file.id,
                            name,
                            x_channel: xChannel,
                            y_channel: yChannel,
                            type: "rectangle",
                            parent_gate_id: activeGateId,
                            transform_x: transformX,
                            transform_y: transformY,
                            arcsinh_cofactor: 150,
                            params: { type: "rectangle", x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax },
                          });
                          await fetchGateTree(file.id);
                          setPendingGate(null);
                        } catch (e) {
                          if (e instanceof Error) {
                            if (e.message.startsWith("HTTP 409")) {
                              setGateNameError("Name already in use");
                              if (file) void fetchGateTree(file.id);
                              return;
                            }
                            setGateNameError(e.message);
                            return;
                          }
                          setGateNameError("Failed to create gate");
                        }
                      }}
                      style={{
                        padding: "0.25rem 0.5rem",
                        borderRadius: "0.35rem",
                        border: "none",
                        fontSize: "0.8rem",
                        cursor: "pointer",
                        background: "#22c55e",
                        color: "white",
                      }}
                    >
                      Create gate
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPendingGate(null);
                        setDrawMode(true);
                      }}
                      style={{
                        padding: "0.25rem 0.5rem",
                        borderRadius: "0.35rem",
                        border: "1px solid #6b7280",
                        fontSize: "0.8rem",
                        cursor: "pointer",
                        background: "transparent",
                        color: "#9ca3af",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {gateTool === "polygon" && drawingPolygon && drawingPolygon.points.length >= 3 && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      value={pendingGate?.gateName ?? ""}
                      onChange={(e) => {
                        setGateNameError(null);
                        setPendingGate((p) =>
                          p ? { ...p, gateName: e.target.value } : { nxMin: 0, nyMin: 0, nxMax: 0, nyMax: 0, gateName: e.target.value },
                        );
                      }}
                      placeholder="Poly gate name"
                      style={{
                        padding: "0.25rem 0.5rem",
                        width: "140px",
                        borderRadius: "0.35rem",
                        border: "1px solid rgba(148,163,184,0.6)",
                        background: "rgba(15,23,42,0.8)",
                        color: "white",
                        fontSize: "0.8rem",
                      }}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        if (!file || !transformedRange || !drawingPolygon) return;
                        const name = (pendingGate?.gateName ?? "").trim() || "Polygon gate";
                        const r = transformedRange;
                        const rawVerts = drawingPolygon.points.map((p) => [
                          r.xMin + (r.xMax - r.xMin) * p.x,
                          r.yMin + (r.yMax - r.yMin) * p.y,
                        ]);
                        setGateNameError(null);
                        try {
                          await postJson(`${API_BASE}/api/gates`, {
                            file_id: file.id,
                            name,
                            x_channel: xChannel,
                            y_channel: yChannel,
                            type: "polygon",
                            parent_gate_id: activeGateId,
                            transform_x: transformX,
                            transform_y: transformY,
                            arcsinh_cofactor: 150,
                            params: { type: "polygon", vertices: rawVerts },
                          });
                          await fetchGateTree(file.id);
                          setDrawingPolygon(null);
                          setPendingGate(null);
                          setDrawMode(false);
                          setGateTool(null);
                        } catch (e) {
                          if (e instanceof Error) {
                            if (e.message.startsWith("HTTP 409")) {
                              setGateNameError("Name already in use");
                              if (file) void fetchGateTree(file.id);
                              return;
                            }
                            setGateNameError(e.message);
                            return;
                          }
                          setGateNameError("Failed to create gate");
                        }
                      }}
                      style={{
                        padding: "0.25rem 0.5rem",
                        borderRadius: "0.35rem",
                        border: "none",
                        fontSize: "0.8rem",
                        cursor: "pointer",
                        background: "#22c55e",
                        color: "white",
                      }}
                    >
                      Create polygon gate
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDrawingPolygon(null);
                        setPendingGate(null);
                        setDrawMode(false);
                      }}
                      style={{
                        padding: "0.25rem 0.5rem",
                        borderRadius: "0.35rem",
                        border: "1px solid #6b7280",
                        fontSize: "0.8rem",
                        cursor: "pointer",
                        background: "transparent",
                        color: "#9ca3af",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          <div
            style={{
              display: "flex",
              flexDirection: "row",
              flexWrap: "wrap",
              gap: "1rem",
              alignItems: "flex-start",
              width: "100%",
            }}
          >
            <div
              style={{
                flex: "1 1 320px",
                minWidth: 0,
                maxWidth: "min(560px, 100%)",
                width: "100%",
              }}
            >
          <div
            style={{
              position: "relative",
              borderRadius: "0.9rem",
              background:
                "radial-gradient(circle at top, rgba(15,23,42,0.9), rgba(15,23,42,1))",
              border: "1px solid rgba(148,163,184,0.5)",
              padding: "0.5rem",
            }}
          >
            {file && (
              <div
                style={{
                  marginBottom: "0.5rem",
                  fontSize: "0.78rem",
                  color: "#9ca3af",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.45rem",
                  width: "100%",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    flexWrap: "wrap",
                    lineHeight: 1.4,
                  }}
                >
                  <span
                    style={{
                      cursor: "pointer",
                      color: activeGateId === null ? "#4ade80" : "#9ca3af",
                    }}
                    onClick={() => setActiveGateId(null)}
                  >
                    All Events ({file.event_count.toLocaleString()})
                  </span>
                  {breadcrumbPath(gateTree, activeGateId).map((node) => (
                    <React.Fragment key={node.id}>
                      <span style={{ color: "#4b5563" }}>›</span>
                      <span
                        style={{
                          cursor: "pointer",
                          color: activeGateId === node.id ? "#4ade80" : "#9ca3af",
                        }}
                        onClick={() => setActiveGateId(node.id)}
                      >
                        {node.name} ({node.count.toLocaleString()})
                      </span>
                    </React.Fragment>
                  ))}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: "0.25rem",
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setPlotMode("points")}
                    style={{
                      padding: "0.1rem 0.45rem",
                      borderRadius: "999px",
                      border: "1px solid rgba(148,163,184,0.6)",
                      backgroundColor:
                        plotMode === "points" ? "rgba(148,163,184,0.3)" : "transparent",
                      color: "#e5e7eb",
                      fontSize: "0.7rem",
                      cursor: "pointer",
                    }}
                  >
                    Scatter
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlotMode("density")}
                    style={{
                      padding: "0.1rem 0.45rem",
                      borderRadius: "999px",
                      border: "1px solid rgba(148,163,184,0.6)",
                      backgroundColor:
                        plotMode === "density" ? "rgba(148,163,184,0.3)" : "transparent",
                      color: "#e5e7eb",
                      fontSize: "0.7rem",
                      cursor: "pointer",
                    }}
                  >
                    Density
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlotBgMode((b) => (b === "dark" ? "white" : "dark"))}
                    style={{
                      padding: "0.1rem 0.45rem",
                      borderRadius: "999px",
                      border: "1px solid rgba(148,163,184,0.6)",
                      fontSize: "0.7rem",
                      cursor: "pointer",
                      backgroundColor: plotBgMode === "white" ? "rgba(248,250,252,0.25)" : "transparent",
                      color: "#e5e7eb",
                    }}
                  >
                    {plotBgMode === "white" ? "Plot: light" : "Plot: dark"}
                  </button>
                  {plotMode === "density" && (
                    <>
                      {(["jet", "viridis", "inferno"] as const).map((cm) => (
                        <button
                          key={cm}
                          type="button"
                          onClick={() => setDensityColormap(cm)}
                          style={{
                            padding: "0.1rem 0.4rem",
                            borderRadius: "999px",
                            border: "1px solid rgba(148,163,184,0.6)",
                            fontSize: "0.65rem",
                            cursor: "pointer",
                            textTransform: "capitalize",
                            backgroundColor:
                              densityColormap === cm ? "rgba(148,163,184,0.35)" : "transparent",
                            color: "#e5e7eb",
                          }}
                        >
                          {cm}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setDensityDisplayScale((s) => (s === "log" ? "linear" : "log"))}
                        style={{
                          padding: "0.1rem 0.4rem",
                          borderRadius: "999px",
                          border: "1px solid rgba(148,163,184,0.6)",
                          fontSize: "0.65rem",
                          cursor: "pointer",
                          backgroundColor: "transparent",
                          color: "#e5e7eb",
                        }}
                      >
                        {densityDisplayScale === "log" ? "Density: log" : "Density: linear"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            <div
              ref={plotContainerRef}
              style={{
                position: "relative",
                width: "100%",
                aspectRatio: "1 / 1",
              }}
            >
            {plotMode === "density" && density && (
              <div
                style={{
                  position: "absolute",
                  left: `${(ml / plotW) * 100}%`,
                  top: `${(mt / plotH) * 100}%`,
                  width: `${(plotAreaW / plotW) * 100}%`,
                  height: `${(plotAreaH / plotH) * 100}%`,
                  zIndex: 0,
                  overflow: "hidden",
                  borderRadius: 2,
                }}
              >
                <PseudocolorCanvas
                  counts={density.counts}
                  width={Math.max(120, Math.floor(plotAreaW * 2))}
                  height={Math.max(120, Math.floor(plotAreaH * 2))}
                  colormap={densityColormap}
                  scale={densityDisplayScale}
                />
              </div>
            )}
            {plotMode === "points" && points.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  left: `${(ml / plotW) * 100}%`,
                  top: `${(mt / plotH) * 100}%`,
                  width: `${(plotAreaW / plotW) * 100}%`,
                  height: `${(plotAreaH / plotH) * 100}%`,
                  zIndex: 0,
                  overflow: "hidden",
                  borderRadius: 2,
                }}
              >
                <ScatterCanvas points={points} plotAreaW={plotAreaW} plotAreaH={plotAreaH} />
              </div>
            )}
            {drawMode && (
              <div
                data-testid="gate-draw-overlay"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "auto",
                  cursor: "crosshair",
                  zIndex: 2,
                }}
                onMouseDown={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const localX = e.clientX - rect.left;
                  const localY = e.clientY - rect.top;
                  const m = plotScaledMargins(plotW, plotH);
                  const sx = rect.width / plotW;
                  const sy = rect.height / plotH;
                  const rLeft = m.ml * sx;
                  const rRight = m.mr * sx;
                  const rTop = m.mt * sy;
                  const rBottom = m.mb * sy;
                  const rPlotW = Math.max(1e-6, rect.width - rLeft - rRight);
                  const rPlotH = Math.max(1e-6, rect.height - rTop - rBottom);
                  const x = Math.max(0, Math.min(1, (localX - rLeft) / rPlotW));
                  const yDown = Math.max(0, Math.min(1, (localY - rTop) / rPlotH));
                  const y = 1 - yDown;
                  if (gateTool === "rectangle") {
                    setDrawingRect({ startX: x, startY: y, endX: x, endY: y });
                  } else if (gateTool === "polygon") {
                    setDrawingPolygon((prev) => ({
                      points: [...(prev?.points ?? []), { x, y }],
                    }));
                  } else if (gateTool === "quadrant") {
                    if (!file || !transformedRange) return;
                    const r = transformedRange;
                    const xRaw = r.xMin + (r.xMax - r.xMin) * x;
                    const yRaw = r.yMin + (r.yMax - r.yMin) * y;
                    const makeGate = async (name: string, xMin: number, xMax: number, yMin: number, yMax: number) => {
                      await postJson(`${API_BASE}/api/gates`, {
                        file_id: file.id,
                        name,
                        x_channel: xChannel,
                        y_channel: yChannel,
                        type: "rectangle",
                        parent_gate_id: activeGateId,
                        transform_x: transformX,
                        transform_y: transformY,
                        arcsinh_cofactor: 150,
                        params: { type: "rectangle", x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax },
                      });
                    };
                    void (async () => {
                      try {
                        const quad = (suffix: string) => [
                          () => makeGate(`Q1${suffix}`, xRaw, r.xMax, yRaw, r.yMax),
                          () => makeGate(`Q2${suffix}`, r.xMin, xRaw, yRaw, r.yMax),
                          () => makeGate(`Q3${suffix}`, r.xMin, xRaw, r.yMin, yRaw),
                          () => makeGate(`Q4${suffix}`, xRaw, r.xMax, r.yMin, yRaw),
                        ];
                        const namesInUse = new Set(gateList.map((g) => g.name));
                        let suffix = "";
                        let picked = false;
                        for (let a = 0; a < 100; a++) {
                          const suf = a === 0 ? "" : ` (${a})`;
                          const qn = [`Q1${suf}`, `Q2${suf}`, `Q3${suf}`, `Q4${suf}`];
                          if (!qn.some((n) => namesInUse.has(n))) {
                            suffix = suf;
                            picked = true;
                            break;
                          }
                        }
                        if (!picked) suffix = ` (${Date.now()})`;
                        for (const fn of quad(suffix)) await fn();
                        await fetchGateTree(file.id);
                      } catch (e) {
                        setGateNameError(e instanceof Error ? e.message : "Quadrant gate creation failed");
                      }
                    })();
                    setDrawMode(false);
                    setGateTool("quadrant");
                  }
                }}
                onMouseMove={(e) => {
                  if (!drawingRect) return;
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const localX = e.clientX - rect.left;
                  const localY = e.clientY - rect.top;
                  const m = plotScaledMargins(plotW, plotH);
                  const sx = rect.width / plotW;
                  const sy = rect.height / plotH;
                  const rLeft = m.ml * sx;
                  const rRight = m.mr * sx;
                  const rTop = m.mt * sy;
                  const rBottom = m.mb * sy;
                  const rPlotW = Math.max(1e-6, rect.width - rLeft - rRight);
                  const rPlotH = Math.max(1e-6, rect.height - rTop - rBottom);
                  const x = Math.max(0, Math.min(1, (localX - rLeft) / rPlotW));
                  const yDown = Math.max(0, Math.min(1, (localY - rTop) / rPlotH));
                  const y = 1 - yDown;
                  setDrawingRect((r) => (r ? { ...r, endX: x, endY: y } : null));
                }}
                onMouseUp={() => {
                  if (gateTool === "rectangle" && drawingRect) {
                    const nxMin = Math.min(drawingRect.startX, drawingRect.endX);
                    const nxMax = Math.max(drawingRect.startX, drawingRect.endX);
                    const nyMin = Math.min(drawingRect.startY, drawingRect.endY);
                    const nyMax = Math.max(drawingRect.startY, drawingRect.endY);
                    if (nxMax - nxMin > 0.01 && nyMax - nyMin > 0.01) {
                      setPendingGate({ nxMin, nyMin, nxMax, nyMax, gateName: "" });
                    }
                    setDrawingRect(null);
                    setDrawMode(false);
                  }
                }}
              />
            )}
            <svg
              viewBox={`0 0 ${plotW} ${plotH}`}
              style={{
                display: "block",
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                position: "relative",
                zIndex: 1,
              }}
              preserveAspectRatio="xMidYMid meet"
            >
              <rect
                x={ml}
                y={mt}
                width={plotAreaW}
                height={plotAreaH}
                fill={plotInnerFill}
                stroke={plotInnerStroke}
                strokeWidth={1}
              />
              {transformedRange && xChannel && yChannel && (
                <>
                  <AxisTicks
                    axis="x"
                    min={transformedRange.xMin}
                    max={transformedRange.xMax}
                    transform={transformX}
                    pixelStart={ml}
                    pixelEnd={ml + plotAreaW}
                    axisPixel={mt + plotAreaH}
                    fill={plotTickFill}
                  />
                  <AxisTicks
                    axis="y"
                    min={transformedRange.yMin}
                    max={transformedRange.yMax}
                    transform={transformY}
                    pixelStart={0}
                    pixelEnd={plotAreaH}
                    axisPixel={ml}
                    plotTop={mt}
                    fill={plotTickFill}
                  />
                </>
              )}
              {/* Axis labels */}
              {xChannel && (
                <text
                  x={plotW / 2}
                  y={plotH - mb / 3}
                  textAnchor="middle"
                  fill={plotTickFill}
                  fontSize="0.85rem"
                >
                  {channels.find((c) => c.name === xChannel)?.ui_label ??
                    channels.find((c) => c.name === xChannel)?.display_name ??
                    xChannel}
                </text>
              )}
              {yChannel && (
                <text
                  x={Math.max(10, ml - 8)}
                  y={plotH / 2}
                  textAnchor="end"
                  transform={`rotate(-90 ${Math.max(10, ml - 8)} ${plotH / 2})`}
                  fill={plotTickFill}
                  fontSize="0.85rem"
                >
                  {channels.find((c) => c.name === yChannel)?.ui_label ??
                    channels.find((c) => c.name === yChannel)?.display_name ??
                    yChannel}
                </text>
              )}
              {activeGateId && points.length === 0 && (
                <text
                  x={plotW / 2}
                  y={plotH / 2}
                  textAnchor="middle"
                  fill="#6b7280"
                  fontSize="0.85rem"
                >
                  0 events in this gate population
                </text>
              )}
              {transformedRange &&
                visibleGates
                  .filter(
                    (g) =>
                      g.type === "rectangle" &&
                      g.x_min != null &&
                      g.y_min != null &&
                      g.x_max != null &&
                      g.y_max != null,
                  )
                  .map((g) => {
                    const { xMin, xMax, yMin, yMax } = transformedRange;
                    const nx0 = Math.max(
                      0,
                      Math.min(1, (g.x_min! - xMin) / (xMax - xMin || 1)),
                    );
                    const nx1 = Math.max(
                      0,
                      Math.min(1, (g.x_max! - xMin) / (xMax - xMin || 1)),
                    );
                    const ny0 = Math.max(
                      0,
                      Math.min(1, (g.y_min! - yMin) / (yMax - yMin || 1)),
                    );
                    const ny1 = Math.max(
                      0,
                      Math.min(1, (g.y_max! - yMin) / (yMax - yMin || 1)),
                    );
                    const left = ml + plotAreaW * Math.min(nx0, nx1);
                    const top = mt + plotAreaH * Math.min(1 - ny0, 1 - ny1);
                    const rectWidth = plotAreaW * Math.abs(nx1 - nx0);
                    const rectHeight = plotAreaH * Math.abs(ny1 - ny0);
                    return (
                      <rect
                        key={g.id}
                        x={left}
                        y={top}
                        width={rectWidth}
                        height={rectHeight}
                        fill="transparent"
                        stroke="#22c55e"
                        strokeWidth={1.2}
                        strokeDasharray="4 2"
                      />
                    );
                  })}
              {transformedRange &&
                visibleGates
                  .filter((g) => g.type === "polygon" && g.vertices && g.vertices.length >= 3)
                  .map((g) => {
                    const { xMin, xMax, yMin, yMax } = transformedRange;
                    const pts = g.vertices!.map(([xRaw, yRaw]) => {
                      const nx = (xRaw - xMin) / (xMax - xMin || 1);
                      const ny = (yRaw - yMin) / (yMax - yMin || 1);
                      const px = ml + plotAreaW * Math.max(0, Math.min(1, nx));
                      const py = mt + plotAreaH * (1 - Math.max(0, Math.min(1, ny)));
                      return `${px},${py}`;
                    });
                    return (
                      <polygon
                        key={g.id}
                        points={pts.join(" ")}
                        fill="rgba(34,197,94,0.08)"
                        stroke="#22c55e"
                        strokeWidth={1.2}
                      />
                    );
                  })}
              {drawingPolygon && drawingPolygon.points.length > 1 && (
                <polyline
                  points={drawingPolygon.points
                    .map((p) => {
                      const px = ml + plotAreaW * p.x;
                      const py = mt + plotAreaH * (1 - p.y);
                      return `${px},${py}`;
                    })
                    .join(" ")}
                  fill="none"
                  stroke="#4ade80"
                  strokeWidth={1.2}
                />
              )}
              {drawingRect && (
                <rect
                  x={ml + plotAreaW * Math.min(drawingRect.startX, drawingRect.endX)}
                  y={mt + plotAreaH * (1 - Math.max(drawingRect.startY, drawingRect.endY))}
                  width={plotAreaW * Math.abs(drawingRect.endX - drawingRect.startX)}
                  height={plotAreaH * Math.abs(drawingRect.endY - drawingRect.startY)}
                  fill="rgba(74,222,128,0.15)"
                  stroke="#4ade80"
                  strokeWidth={1.5}
                />
              )}
              {plotMode === "points" && points.length === 0 && (
                <text
                  x={plotW / 2}
                  y={plotH / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#6b7280"
                  fontSize="0.9rem"
                >
                  {fcsStatus === "loading"
                    ? "Loading events…"
                    : fcsError
                    ? `Failed to load events: ${fcsError}`
                    : "Load an FCS file to see FSC vs SSC"}
                </text>

              )}
            </svg>
            </div>
          </div>
            </div>
            {file && (
              <div
                style={{
                  flex: "1 1 240px",
                  minWidth: "min(280px, 100%)",
                  maxWidth: "100%",
                  maxHeight: 560,
                  overflowY: "auto",
                  overflowX: "hidden",
                  boxSizing: "border-box",
                  padding: "0.75rem 0.85rem",
                  borderRadius: "0.65rem",
                  background: "rgba(15,23,42,0.55)",
                  border: "1px solid rgba(148,163,184,0.35)",
                  alignSelf: "stretch",
                }}
              >
                <div
                  style={{
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "#9ca3af",
                    marginBottom: "0.4rem",
                  }}
                >
                  Gate Hierarchy
                </div>
                <GateTreePanel
                  tree={gateTree}
                  totalEvents={file.event_count}
                  activeGateId={activeGateId}
                  loading={gateTreeLoading}
                  error={gateTreeError}
                  onSelectGate={(id) => {
                    setActiveGateId(id);
                    setDrawMode(false);
                    setPendingGate(null);
                    setDrawingPolygon(null);
                    setDrawingRect(null);
                  }}
                  onDeleteGate={async (id) => {
                    try {
                      const res = await fetch(`${API_BASE}/api/gates/${encodeURIComponent(id)}`, {
                        method: "DELETE",
                      });
                      if (!res.ok) {
                        const text = await res.text();
                        throw new Error(text || `HTTP ${res.status}`);
                      }
                      const deletedNode = findNode(gateTree, id);
                      if (deletedNode) {
                        const flat = flattenTree([deletedNode]);
                        if (flat.some((g) => g.id === activeGateId)) setActiveGateId(null);
                      }
                      if (file) await fetchGateTree(file.id);
                    } catch (err) {
                      const message = err instanceof Error ? err.message : String(err);
                      setGateMessage(`Failed to delete gate: ${message}`);
                    }
                  }}
                  onCreateChild={() => {
                    setDrawMode(true);
                    setGateTool("rectangle");
                    setPendingGate(null);
                    setDrawingPolygon(null);
                    setDrawingRect(null);
                  }}
                />
              </div>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

