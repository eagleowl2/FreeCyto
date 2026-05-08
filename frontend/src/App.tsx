import React from "react";
import { GateTreePanel } from "./components/GateTreePanel";
import { ExperimentTree } from "./components/ExperimentTree/ExperimentTree";
import { TablePanel } from "./components/Panels/TablePanel";
import { LayoutEditorPanel } from "./components/Panels/LayoutEditorPanel";
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

type BoundsSnapshot = { x_min: number; y_min: number; x_max: number; y_max: number };
type UndoAction =
  | { type: "create"; gateId: string }
  | { type: "create_batch"; gateIds: string[] }
  | { type: "update"; gateId: string; old: BoundsSnapshot; new: BoundsSnapshot };
type HistogramData = {
  binEdges: number[];
  counts: number[];
  xMin: number;
  xMax: number;
};
type DragState = {
  gateId: string;
  gateType: "rectangle" | "polygon";
  mode: "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se";
  startClientX: number; startClientY: number;
  origBounds: BoundsSnapshot;
  origVertices?: number[][];
  containerWidth: number;
  plotW: number; plotH: number; ml: number; mt: number; plotAreaW: number; plotAreaH: number;
  xMin: number; xMax: number; yMin: number; yMax: number;
};

const API_BASE = "http://127.0.0.1:8765";
const DEFAULT_X_TRANSFORM: "linear" | "log" | "arcsinh" | "logicle" = "log";
const DEFAULT_Y_TRANSFORM: "linear" | "log" | "arcsinh" | "logicle" = "linear";
const VALID_DENSITY_COLORMAPS: readonly DensityColormap[] = ["jet", "viridis", "inferno"];

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

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
  /** J-2: spillover table editor state — channel names (row/col headers) + matrix cells (strings for editing). */
  const [spillChNames, setSpillChNames] = React.useState<string[]>([]);
  const [spillMatrix, setSpillMatrix] = React.useState<string[][]>([]);
  const [compStatus, setCompStatus] = React.useState<"idle" | "applying" | "error" | "success">("idle");
  const [compError, setCompError] = React.useState<string | null>(null);
  /** Condition number of the most recently applied spillover matrix (null = raw / unknown). */
  const [compCond, setCompCond] = React.useState<number | null>(null);
  /** Whether the backend currently has compensation applied for the active file. */
  const [isCompensated, setIsCompensated] = React.useState(false);
  const [file, setFile] = React.useState<LoadedFile | null>(null);
  const [channels, setChannels] = React.useState<ChannelInfo[]>([]);
  const [xChannel, setXChannel] = React.useState("");
  const [yChannel, setYChannel] = React.useState("");
  const [plotMode, setPlotMode] = React.useState<"points" | "density" | "histogram">("density");
  const [densityColormap, setDensityColormap] = React.useState<DensityColormap>("jet");
  const [densityDisplayScale, setDensityDisplayScale] = React.useState<DensityScale>("log");
  const [plotBgMode, setPlotBgMode] = React.useState<"dark" | "white">(() => {
    try {
      return globalThis.localStorage?.getItem("freecyto_plot_bg") === "white" ? "white" : "dark";
    } catch {
      return "dark";
    }
  });
  const [transformX, setTransformX] = React.useState<"linear" | "log" | "arcsinh" | "logicle">(
    DEFAULT_X_TRANSFORM,
  );
  const [transformY, setTransformY] = React.useState<"linear" | "log" | "arcsinh" | "logicle">(
    DEFAULT_Y_TRANSFORM,
  );
  const [points, setPoints] = React.useState<ScatterPoint[]>([]);
  // R-3: Backgating - show parent population as faded background overlay
  const [showBackgate, setShowBackgate] = React.useState<boolean>(false);
  const [backgatePoints, setBackgatePoints] = React.useState<ScatterPoint[]>([]);
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

  // G: per-gate channel statistics
  type ChannelStat = { channel_name: string; display_name: string; mean: number; median: number; sd: number; cv: number | null };
  type GateStatsData = {
    gate_id: string; gate_name: string; count: number;
    pct_of_parent: number; pct_total: number;
    channel_stats: ChannelStat[];
  };
  const [gateStats, setGateStats] = React.useState<GateStatsData | null>(null);
  const [gateStatsLoading, setGateStatsLoading] = React.useState(false);
  const [statsExpanded, setStatsExpanded] = React.useState(false);
  // P-3: column sort for stats table
  type StatsSortCol = "channel" | "mean" | "median" | "sd" | "cv";
  const [statsSortCol, setStatsSortCol] = React.useState<StatsSortCol>("channel");
  const [statsSortDir, setStatsSortDir] = React.useState<"asc" | "desc">("asc");
  const gateList = React.useMemo(() => flattenTree(gateTree), [gateTree]);

  // Q-1: Batch gate copy
  type FileInfo = { id: string; sample_name: string; event_count: number };
  const [allFiles, setAllFiles] = React.useState<FileInfo[]>([]);
  const [applyGatesModalOpen, setApplyGatesModalOpen] = React.useState(false);
  const [applyGatesTargets, setApplyGatesTargets] = React.useState<Set<string>>(new Set());
  const [applyGatesLoading, setApplyGatesLoading] = React.useState(false);
  const [applyGatesMessage, setApplyGatesMessage] = React.useState<string>("");

  // Q-2: Population summary report
  type PopulationSortCol = "name" | "count" | "pct_parent" | "pct_total";
  const [popSortCol, setPopSortCol] = React.useState<PopulationSortCol>("name");
  const [popSortDir, setPopSortDir] = React.useState<"asc" | "desc">("asc");
  const [popExpanded, setPopExpanded] = React.useState(false);

  // Q-3: Gate layout save/restore
  type LayoutInfo = { id: string; name: string; gate_count: number; source_file_id: string };
  const [savedLayouts, setSavedLayouts] = React.useState<LayoutInfo[]>([]);
  const [saveLayoutModalOpen, setSaveLayoutModalOpen] = React.useState(false);
  const [saveLayoutName, setSaveLayoutName] = React.useState("");
  const [saveLayoutLoading, setSaveLayoutLoading] = React.useState(false);
  const [loadLayoutLoading, setLoadLayoutLoading] = React.useState(false);

  // Q-4: Compensation matrix UI
  type SpilloverData = { file_id: string; channel_names: string[]; matrix: number[][]; cond: number };
  const [spilloverData, setSpilloverData] = React.useState<SpilloverData | null>(null);
  const [spilloverLoading, setSpilloverLoading] = React.useState(false);
  const [compensationModalOpen, setCompensationModalOpen] = React.useState(false);
  const [compensationFullMatrixOpen, setCompensationFullMatrixOpen] = React.useState(false);
  // C-4: derive from gateList so flattenTree is called only once per gateTree change.
  const visibleGates = React.useMemo(
    () =>
      gateList.filter(
        (g) =>
          g.parent_gate_id === activeGateId &&
          g.x_channel === xChannel &&
          g.y_channel === yChannel,
      ),
    [gateList, activeGateId, xChannel, yChannel],
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
  const [gateTool, setGateTool] = React.useState<"rectangle" | "polygon" | "quadrant" | "ellipse" | "interval" | "boolean" | null>("rectangle");
  // N: pending ellipse gate (after drag, before name + submit)
  const [pendingEllipse, setPendingEllipse] = React.useState<{
    nCx: number; nCy: number; nRx: number; nRy: number; gateName: string;
  } | null>(null);
  const [drawMode, setDrawMode] = React.useState(false);
  const [drawingPolygon, setDrawingPolygon] = React.useState<{ points: { x: number; y: number }[] } | null>(null);
  const [fcsStatus, setFcsStatus] = React.useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [fcsError, setFcsError] = React.useState<string | null>(null);
  const [debugLogPath, setDebugLogPath] = React.useState<string>("");
  const [debugUiStatus, setDebugUiStatus] = React.useState<string>("");
  const [debugLastRuntimeError, setDebugLastRuntimeError] = React.useState<string>("");

  // H: undo/redo stacks (refs = no re-render on push/pop; only keyboard effects use them)
  const undoStackRef = React.useRef<UndoAction[]>([]);
  const redoStackRef = React.useRef<UndoAction[]>([]);
  // H: gate drag state (ref = no re-render during mousemove; previewGate is the visual state)
  const dragRef = React.useRef<DragState | null>(null);
  const [previewGate, setPreviewGate] = React.useState<
    | (BoundsSnapshot & { id: string; kind: "rect" })
    | { id: string; kind: "poly"; vertices: number[][] }
    | null
  >(null);
  // I: histogram + interval gate state
  const [histData, setHistData] = React.useState<HistogramData | null>(null);
  const [drawingInterval, setDrawingInterval] = React.useState<{ startX: number; endX: number } | null>(null);
  const [pendingInterval, setPendingInterval] = React.useState<{ xMin: number; xMax: number; gateName: string } | null>(null);

  // T: Experiment hierarchy + Table panel
  const [experimentPanelOpen, setExperimentPanelOpen] = React.useState(false);
  const [tablePanelOpen, setTablePanelOpen] = React.useState(false);
  const [layoutEditorOpen, setLayoutEditorOpen] = React.useState(false);

  // K: sample groups, gating templates, batch statistics
  type SampleInfo = { file_id: string; label: string };
  type GroupInfo = { id: string; name: string; samples: SampleInfo[]; template_id: string | null };
  type BatchStatRow = { file_id: string; label: string; gate_name: string; count: number; pct_of_parent: number; pct_of_total: number; parent_count: number };
  const [groups, setGroups] = React.useState<GroupInfo[]>([]);
  const [groupPanelOpen, setGroupPanelOpen] = React.useState(false);
  const [newGroupName, setNewGroupName] = React.useState("");
  const [newGroupFileIds, setNewGroupFileIds] = React.useState<string[]>([]);
  const [groupError, setGroupError] = React.useState<string | null>(null);
  const [expandedGroupId, setExpandedGroupId] = React.useState<string | null>(null);
  const [batchGateName, setBatchGateName] = React.useState("");
  const [batchStats, setBatchStats] = React.useState<{ groupId: string; rows: BatchStatRow[] } | null>(null);
  const [batchStatsLoading, setBatchStatsLoading] = React.useState(false);
  const [tplSourceFileId, setTplSourceFileId] = React.useState("");
  const [tplName, setTplName] = React.useState("");
  const [tplStatus, setTplStatus] = React.useState<"idle" | "working" | "done" | "error">("idle");
  const [tplError, setTplError] = React.useState<string | null>(null);

  // L: Boolean gates
  const [boolGateName, setBoolGateName] = React.useState("");
  const [boolExpression, setBoolExpression] = React.useState("");
  const [boolGateError, setBoolGateError] = React.useState<string | null>(null);
  // S-1: ref for cursor-aware gate name insertion into expression
  const boolExprInputRef = React.useRef<HTMLInputElement>(null);

  // L: Derived parameters
  type DerivedParamInfo = { id: string; file_id: string; name: string; expression: string };
  const [derivedParams, setDerivedParams] = React.useState<DerivedParamInfo[]>([]);
  const [dpPanelOpen, setDpPanelOpen] = React.useState(false);
  const [dpName, setDpName] = React.useState("");
  const [dpExpr, setDpExpr] = React.useState("");
  const [dpError, setDpError] = React.useState<string | null>(null);
  const [dpLoading, setDpLoading] = React.useState(false);

  // M: histogram overlay — gate IDs selected for overlay + cached histogram data per gate
  const [histOverlayIds, setHistOverlayIds] = React.useState<string[]>([]);
  const [histOverlayData, setHistOverlayData] = React.useState<Record<string, HistogramData>>({});

  // O: density contour lines toggle
  const [showContours, setShowContours] = React.useState(false);

  // P-1: Plate layout panel
  type PlateWellInfo = { well_id: string; row: number; col: number; file_id: string | null; label: string | null };
  type PlateInfo = { id: string; name: string; rows: number; cols: number; wells: PlateWellInfo[] };
  type PlateStatWell = { well_id: string; file_id: string | null; label: string | null; row: number; col: number; count: number; pct_of_parent: number; pct_of_total: number; total_events: number };
  type PlateStatsData = { plate_id: string; plate_name: string; gate_name: string; rows: number; cols: number; wells: PlateStatWell[] };
  const [plates, setPlates] = React.useState<PlateInfo[]>([]);
  const [platePanelOpen, setPlatePanelOpen] = React.useState(false);
  const [activePlateId, setActivePlateId] = React.useState<string | null>(null);
  const [plateGateName, setPlateGateName] = React.useState("");
  const [plateStats, setPlateStats] = React.useState<PlateStatsData | null>(null);
  const [plateStatsLoading, setPlateStatsLoading] = React.useState(false);
  const [plateCreateName, setPlateCreateName] = React.useState("");
  const [plateCreateFormat, setPlateCreateFormat] = React.useState("96");
  const [plateCreateOpen, setPlateCreateOpen] = React.useState(false);
  const [plateAssignMode, setPlateAssignMode] = React.useState(false);
  const [plateAssignWellId, setPlateAssignWellId] = React.useState<string | null>(null);

  // P-2: plot zoom/pan
  type ZoomState = { xMin: number; xMax: number; yMin: number; yMax: number };
  const [zoom, setZoom] = React.useState<ZoomState | null>(null);
  /** True while the user is pan-dragging (Space+drag) — used for cursor style only. */
  const [isPanning, setIsPanning] = React.useState(false);
  /** Ref so wheel/pan handlers always see the latest zoom without re-registering listeners. */
  const zoomRef = React.useRef<ZoomState | null>(null);
  zoomRef.current = zoom;
  /** Ref so global handlers see the latest transformedRange without stale closure. */
  const transformedRangeRef = React.useRef(transformedRange);
  transformedRangeRef.current = transformedRange;
  /** True while Space is held — checked synchronously in event handlers. */
  const spaceDownRef = React.useRef(false);
  /** Snapshot for pan: start cursor pos + zoom window at pan start. */
  const panStartRef = React.useRef<{ clientX: number; clientY: number; zoomSnap: ZoomState } | null>(null);

  /** Monotonic id for plot data fetches; stale responses must not overwrite React state (see FRONTEND_REVIEW #1). */
  const plotRequestGenerationRef = React.useRef(0);
  /** N: ref to the main plot SVG for PNG export. */
  const plotSvgRef = React.useRef<SVGSVGElement>(null);

  /** Remember X/Y channel + transforms per file when switching loaded files (FRONTEND_APP_REVIEW NEW-13). */
  const perFileAxesRef = React.useRef(
    new Map<string, { x: string; y: string; tx: typeof transformX; ty: typeof transformY }>(),
  );

  const sessionRestoreAttemptedRef = React.useRef(false);
  const debugLog = React.useCallback((msg: string) => {
    void window.opencyto?.appendDebugLog?.(msg);
  }, []);
  const runSafeUiAction = React.useCallback(
    (label: string, action: () => Promise<void>) => {
      void action().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        setFcsError(message);
        setDebugUiStatus(`${label} failed: ${message}`);
        debugLog(`[ui.action.error] ${label}: ${message}`);
      });
    },
    [debugLog],
  );
  const setDensityColormapSafe = React.useCallback((next: unknown) => {
    if (typeof next === "string" && (VALID_DENSITY_COLORMAPS as readonly string[]).includes(next)) {
      setDensityColormap(next as DensityColormap);
    }
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
    const norm = (v: number, min: number, max: number) => {
      if (min > max) throw new Error(`Invalid range: min (${min}) > max (${max})`);
      if (max === min) return 0.5;
      return (v - min) / (max - min);
    };
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

  // I: fetch 1-D histogram from backend; optionally restricted to a gate population
  const fetchHistogramAndPlot = React.useCallback(
    async (fileId: string, channel: string, transform: string, plotGeneration: number, gateId?: string | null) => {
      type HistResp = { bin_edges: number[]; counts: number[]; x_min: number; x_max: number };
      const params = new URLSearchParams({ channel, transform, bins: "256" });
      if (gateId) params.set("gate_id", gateId);
      const resp = await getJson<HistResp>(
        `${API_BASE}/api/files/${encodeURIComponent(fileId)}/histogram?${params}`,
      );
      if (plotGeneration !== plotRequestGenerationRef.current) return;
      const maxCount = resp.counts.length ? Math.max(...resp.counts) : 1;
      setHistData({ binEdges: resp.bin_edges, counts: resp.counts, xMin: resp.x_min, xMax: resp.x_max });
      setTransformedRange({ xMin: resp.x_min, xMax: resp.x_max, yMin: 0, yMax: maxCount });
      setDensity(null);
      setPoints([]);
    },
    [],
  );

  /** Always pass an explicit path from the browse dialog (`paths[0]`). */
  /** K: Fetch and sync group list from backend. */
  const fetchGroups = React.useCallback(async () => {
    try {
      type GroupResp = { id: string; name: string; samples: { file_id: string; label: string }[]; template_id: string | null };
      const data = await getJson<GroupResp[]>(`${API_BASE}/api/groups`);
      setGroups(data);
    } catch {
      // non-fatal
    }
  }, []);

  /** K: Create a new group. */
  const createGroup = React.useCallback(async (name: string, fileIds: string[]) => {
    type GroupResp = { id: string; name: string; samples: { file_id: string; label: string }[]; template_id: string | null };
    const grp = await postJson<GroupResp>(`${API_BASE}/api/groups`, { name, file_ids: fileIds });
    setGroups((prev) => [...prev, grp]);
    return grp;
  }, []);

  /** K: Delete a group. */
  const deleteGroup = React.useCallback(async (groupId: string) => {
    await fetch(`${API_BASE}/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
    if (expandedGroupId === groupId) setExpandedGroupId(null);
  }, [expandedGroupId]);

  /** L: Fetch and sync derived parameter list from backend. */
  const fetchDerivedParams = React.useCallback(async (fileId: string) => {
    try {
      const data = await getJson<DerivedParamInfo[]>(`${API_BASE}/api/derived-params/${encodeURIComponent(fileId)}`);
      setDerivedParams(data);
    } catch {
      setDerivedParams([]);
    }
  }, []);

  /** J-2: Fetch the parsed $SPILLOVER from the backend and populate the table editor. */
  const loadSpilloverFromFile = React.useCallback(async (fileId: string) => {
    try {
      type SpillResp = { file_id: string; channel_names: string[]; matrix: number[][]; cond?: number | null };
      const res = await fetch(`${API_BASE}/api/compensation/spillover/${encodeURIComponent(fileId)}`);
      if (!res.ok) {
        setSpillChNames([]);
        setSpillMatrix([]);
        return;
      }
      const data = (await res.json()) as SpillResp;
      setSpillChNames(data.channel_names);
      setSpillMatrix(data.matrix.map((row) => row.map((v) => String(v))));
    } catch {
      setSpillChNames([]);
      setSpillMatrix([]);
    }
  }, []);

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
      const pick = (prefs: string[]) => {
        if (!Array.isArray(prefs) || !Array.isArray(names) || prefs.length === 0) return null;
        return prefs.find((p) => names.includes(p)) || null;
      };
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
      setTransformX(DEFAULT_X_TRANSFORM);
      setTransformY(DEFAULT_Y_TRANSFORM);
      perFileAxesRef.current.set(loaded.id, {
        x: xName,
        y: yName,
        tx: DEFAULT_X_TRANSFORM,
        ty: DEFAULT_Y_TRANSFORM,
      });
      // J-2: auto-populate spillover table when the file embeds $SPILLOVER
      void loadSpilloverFromFile(loaded.id);
      // E-5: reset compensation badge — fresh file load always starts uncompensated
      setCompStatus("idle");
      setCompCond(null);
      setIsCompensated(false);
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
    setHistData(null);
    // M: clear overlay data on any plot parameter change to avoid stale data
    setHistOverlayData({});
    void (async () => {
      try {
        if (plotMode === "histogram") {
          // Histogram mode uses only x-channel
          await fetchHistogramAndPlot(file.id, xChannel, transformX, plotGeneration, activeGateId);
          if (plotGeneration === plotRequestGenerationRef.current) setFcsStatus("loaded");
        } else if (activeGateId) {
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
    fetchHistogramAndPlot,
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

  // O: rename a gate in-place (PATCH name only); re-fetches tree on success.
  const handleRenameGate = React.useCallback(
    async (gateId: string, newName: string) => {
      if (!file) return;
      await patchJson<unknown>(`${API_BASE}/api/gates/${encodeURIComponent(gateId)}`, { name: newName });
      await fetchGateTree(file.id);
    },
    [file, fetchGateTree],
  );

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
      const VALID_TRANSFORMS = ["linear", "log", "arcsinh", "logicle"] as const;
      type AxisTransformName = (typeof VALID_TRANSFORMS)[number];
      const coerceAxisTransform = (v: unknown): AxisTransformName => {
        if (
          typeof v === "string" &&
          (VALID_TRANSFORMS as readonly string[]).includes(v)
        ) {
          return v as AxisTransformName;
        }
        return "linear";
      };

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
      let nextTx: "linear" | "log" | "arcsinh" | "logicle" = DEFAULT_X_TRANSFORM;
      let nextTy: "linear" | "log" | "arcsinh" | "logicle" = DEFAULT_Y_TRANSFORM;
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

      // F-3: populate perFileAxesRef for ALL files from default_axes (not just the first).
      // This means switching files after load restores saved channel/transform selections.
      const allAxes = wsShape.default_axes ?? {};
      for (const lf of loaded) {
        const saved = allAxes[lf.id];
        if (!saved) continue;
        perFileAxesRef.current.set(lf.id, {
          x: typeof saved.x_channel === "string" ? saved.x_channel : (lf.channels[0] ?? ""),
          y: typeof saved.y_channel === "string" ? saved.y_channel : (lf.channels[1] ?? lf.channels[0] ?? ""),
          tx: coerceAxisTransform(saved.transform_x),
          ty: coerceAxisTransform(saved.transform_y),
        });
      }

      // F-4: sync compensation badge + spillover textarea for the first file
      const firstLoadedId = loaded[0]?.id;
      if (firstLoadedId) {
        try {
          type CompStatusResp = { is_compensated: boolean; cond?: number | null };
          const cs = await getJson<CompStatusResp>(
            `${API_BASE}/api/compensation/status/${encodeURIComponent(firstLoadedId)}`,
          );
          setIsCompensated(cs.is_compensated);
          setCompCond(cs.is_compensated ? (cs.cond ?? null) : null);
          setCompStatus(cs.is_compensated ? "success" : "idle");
        } catch {
          setIsCompensated(false);
          setCompCond(null);
          setCompStatus("idle");
        }
        setCompError(null);
        // J-2: populate spillover table from backend for first file
        void loadSpilloverFromFile(firstLoadedId);
      }

      if (loaded[0]?.id) {
        await fetchGateTree(loaded[0].id);
        const pg = ++plotRequestGenerationRef.current;
        if (plotMode === "density") {
          await fetchDensityAndPlot(loaded[0].id, xName, yName, nextTx, nextTy, pg);
        } else {
          await fetchEventsAndPlot(loaded[0].id, xName, yName, nextTx, nextTy, pg);
        }
      }
      // F-2: auto-save the loaded workspace (with axes) to the session file so
      // session restore will have the full state including default_axes.
      try {
        await fetch(`${API_BASE}/api/session/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        /* non-fatal: session save failure should not break workspace load */
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

  // G: fetch stats when active gate changes and stats panel is open
  React.useEffect(() => {
    if (!activeGateId || !statsExpanded) {
      if (!activeGateId) setGateStats(null);
      return;
    }
    setGateStatsLoading(true);
    void getJson<GateStatsData>(`${API_BASE}/api/gates/${encodeURIComponent(activeGateId)}/stats`)
      .then((data) => { setGateStats(data); setGateStatsLoading(false); })
      .catch(() => { setGateStats(null); setGateStatsLoading(false); });
  }, [activeGateId, statsExpanded]);

  // Q-1: Fetch all loaded files for batch operations
  React.useEffect(() => {
    void getJson<FileInfo[]>(`${API_BASE}/api/files/list`)
      .then((data) => { setAllFiles(data); })
      .catch(() => { setAllFiles([]); });
  }, [file]); // Refresh when file changes

  // Q-3: Fetch saved layouts
  React.useEffect(() => {
    void getJson<LayoutInfo[]>(`${API_BASE}/api/layouts`)
      .then((data) => { setSavedLayouts(data); })
      .catch(() => { setSavedLayouts([]); });
  }, []);

  // P-1: Fetch plate list on mount and when platePanelOpen
  React.useEffect(() => {
    if (!platePanelOpen) return;
    void getJson<PlateInfo[]>(`${API_BASE}/api/plates`)
      .then((data) => { setPlates(data); })
      .catch(() => { setPlates([]); });
  }, [platePanelOpen]);

  // Q-4: Fetch compensation matrix when modal opens
  React.useEffect(() => {
    if (!file || !compensationModalOpen) return;
    setSpilloverLoading(true);
    void getJson<SpilloverData>(`${API_BASE}/api/compensation/spillover/${encodeURIComponent(file.id)}`)
      .then((data) => { setSpilloverData(data); setSpilloverLoading(false); })
      .catch(() => { setSpilloverData(null); setSpilloverLoading(false); });
  }, [file, compensationModalOpen]);

  // Polishment 4: Keyboard shortcuts - Esc to close modals
  React.useEffect(() => {
    const handleEscKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (compensationFullMatrixOpen) setCompensationFullMatrixOpen(false);
        else if (compensationModalOpen) setCompensationModalOpen(false);
        else if (saveLayoutModalOpen) setSaveLayoutModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleEscKey);
    return () => window.removeEventListener("keydown", handleEscKey);
  }, [compensationModalOpen, compensationFullMatrixOpen, saveLayoutModalOpen]);

  React.useEffect(() => {
    if (file?.id) {
      void fetchGateTree(file.id);
      void fetchDerivedParams(file.id);
    } else {
      setGateTree([]);
      setDerivedParams([]);
    }
    setGateMessage(null);
    setActiveGateId(null);
  }, [file?.id, fetchGateTree, fetchDerivedParams]);

  // R-3: Fetch parent population events for backgating overlay
  React.useEffect(() => {
    if (!showBackgate || !file?.id || !activeGateId || plotMode === "histogram" || !transformedRange) {
      setBackgatePoints([]);
      return;
    }
    const activeGate = gateList.find((g) => g.id === activeGateId);
    const tr = transformedRange;
    const norm = (raw: { events: number[][] }) => {
      // Normalize using the SAME range as main points for proper alignment
      const xSpan = tr.xMax - tr.xMin || 1;
      const ySpan = tr.yMax - tr.yMin || 1;
      return raw.events.map((row) => ({
        x: ((row[0] ?? 0) - tr.xMin) / xSpan,
        y: ((row[1] ?? 0) - tr.yMin) / ySpan,
      }));
    };
    const params = new URLSearchParams({
      x_channel: xChannel,
      y_channel: yChannel,
      transform_x: transformX,
      transform_y: transformY,
      max_events: "8000",
    });
    const url = activeGate?.parent_gate_id
      ? `${API_BASE}/api/gates/${encodeURIComponent(activeGate.parent_gate_id)}/events?${params}`
      : `${API_BASE}/api/files/${encodeURIComponent(file.id)}/events?${params}`;
    void getJson<{ events: number[][] }>(url)
      .then((resp) => setBackgatePoints(norm(resp)))
      .catch(() => setBackgatePoints([]));
  }, [showBackgate, file?.id, activeGateId, xChannel, yChannel, transformX, transformY, plotMode, gateList, transformedRange]);

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

  // H: global keyboard shortcuts — Ctrl+Z (undo), Ctrl+Y (redo), Delete (delete active gate)
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        const entry = undoStackRef.current.at(-1);
        if (!entry || !file) return;
        undoStackRef.current = undoStackRef.current.slice(0, -1);
        void (async () => {
          try {
            if (entry.type === "create") {
              await fetch(`${API_BASE}/api/gates/${encodeURIComponent(entry.gateId)}`, { method: "DELETE" });
              if (activeGateId === entry.gateId) setActiveGateId(null);
              redoStackRef.current = [...redoStackRef.current, entry];
            } else if (entry.type === "create_batch") {
              for (const gid of [...entry.gateIds].reverse()) {
                await fetch(`${API_BASE}/api/gates/${encodeURIComponent(gid)}`, { method: "DELETE" });
              }
              if (entry.gateIds.includes(activeGateId ?? "")) setActiveGateId(null);
              redoStackRef.current = [...redoStackRef.current, entry];
            } else if (entry.type === "update") {
              await patchJson(`${API_BASE}/api/gates/${encodeURIComponent(entry.gateId)}`, entry.old);
              redoStackRef.current = [...redoStackRef.current, { ...entry, old: entry.new, new: entry.old }];
            }
            await fetchGateTree(file.id);
          } catch {
            undoStackRef.current = [...undoStackRef.current, entry];
          }
        })();
      } else if (ctrl && (e.key === "y" || (e.shiftKey && e.key === "Z"))) {
        e.preventDefault();
        const entry = redoStackRef.current.at(-1);
        if (!entry || !file) return;
        redoStackRef.current = redoStackRef.current.slice(0, -1);
        void (async () => {
          try {
            if (entry.type === "update") {
              await patchJson(`${API_BASE}/api/gates/${encodeURIComponent(entry.gateId)}`, entry.old);
              undoStackRef.current = [...undoStackRef.current, { ...entry, old: entry.new, new: entry.old }];
            }
            await fetchGateTree(file.id);
          } catch {
            redoStackRef.current = [...redoStackRef.current, entry];
          }
        })();
      } else if (e.key === "Delete" && !drawMode && !pendingGate && activeGateId && file) {
        e.preventDefault();
        void (async () => {
          try {
            await fetch(`${API_BASE}/api/gates/${encodeURIComponent(activeGateId)}`, { method: "DELETE" });
            setActiveGateId(null);
            await fetchGateTree(file.id);
          } catch { /* ignore */ }
        })();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [file, activeGateId, drawMode, pendingGate, fetchGateTree]);

  // H/I/P-2: window-level mousemove/mouseup for gate dragging + pan
  React.useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      // P-2: Pan drag — translate zoom window.
      const ps = panStartRef.current;
      if (ps) {
        const orig = transformedRangeRef.current;
        if (!orig) return;
        const { plotW: pW, plotH: pH, ml: mL, mt: mT, plotAreaW: paW, plotAreaH: paH } =
          plotDimsRef.current;
        const el = plotContainerRef.current;
        const rect = el?.getBoundingClientRect();
        if (!rect) return;
        // Pixel delta in CSS pixels → viewBox pixels.
        const dxVB = (e.clientX - ps.clientX) / rect.width  * pW;
        const dyVB = (e.clientY - ps.clientY) / rect.height * pH;
        // Convert viewBox pixel delta to data delta.
        const dxData = -(dxVB / paW) * (ps.zoomSnap.xMax - ps.zoomSnap.xMin);
        const dyData =  (dyVB / paH) * (ps.zoomSnap.yMax - ps.zoomSnap.yMin);
        let nxMin = ps.zoomSnap.xMin + dxData;
        let nxMax = ps.zoomSnap.xMax + dxData;
        let nyMin = ps.zoomSnap.yMin + dyData;
        let nyMax = ps.zoomSnap.yMax + dyData;
        // Clamp so the window doesn't slide outside the original data range.
        if (nxMin < orig.xMin) { nxMax += orig.xMin - nxMin; nxMin = orig.xMin; }
        if (nxMax > orig.xMax) { nxMin -= nxMax - orig.xMax; nxMax = orig.xMax; }
        if (nyMin < orig.yMin) { nyMax += orig.yMin - nyMin; nyMin = orig.yMin; }
        if (nyMax > orig.yMax) { nyMin -= nyMax - orig.yMax; nyMax = orig.yMax; }
        setZoom({ xMin: nxMin, xMax: nxMax, yMin: nyMin, yMax: nyMax });
        return;
      }

      const ds = dragRef.current;
      if (!ds) return;
      const clientDX = e.clientX - ds.startClientX;
      const clientDY = e.clientY - ds.startClientY;
      const dataDX = (clientDX / ds.containerWidth) * ds.plotW / ds.plotAreaW * (ds.xMax - ds.xMin);
      const dataDY = -(clientDY / ds.containerWidth) * ds.plotH / ds.plotAreaH * (ds.yMax - ds.yMin);

      if (ds.gateType === "polygon" && ds.origVertices) {
        // Polygon: translate all vertices by the delta (move only)
        const newVerts = ds.origVertices.map(([vx, vy]) => [vx + dataDX, vy + dataDY]);
        setPreviewGate({ id: ds.gateId, kind: "poly", vertices: newVerts });
        return;
      }

      // Rectangle: apply resize or move to bounds
      const o = ds.origBounds;
      let b: BoundsSnapshot;
      if (ds.mode === "move") {
        b = { x_min: o.x_min + dataDX, y_min: o.y_min + dataDY, x_max: o.x_max + dataDX, y_max: o.y_max + dataDY };
      } else if (ds.mode === "resize-nw") {
        b = { ...o, x_min: o.x_min + dataDX, y_max: o.y_max + dataDY };
      } else if (ds.mode === "resize-ne") {
        b = { ...o, x_max: o.x_max + dataDX, y_max: o.y_max + dataDY };
      } else if (ds.mode === "resize-sw") {
        b = { ...o, x_min: o.x_min + dataDX, y_min: o.y_min + dataDY };
      } else {
        b = { ...o, x_max: o.x_max + dataDX, y_min: o.y_min + dataDY };
      }
      setPreviewGate({ id: ds.gateId, kind: "rect", ...b });
    };

    const onMouseUp = (e: MouseEvent) => {
      // P-2: End pan drag.
      if (panStartRef.current) {
        panStartRef.current = null;
        setIsPanning(false);
        return;
      }

      const ds = dragRef.current;
      if (!ds) return;
      dragRef.current = null;
      const clientDX = e.clientX - ds.startClientX;
      const clientDY = e.clientY - ds.startClientY;
      if (Math.abs(clientDX) < 3 && Math.abs(clientDY) < 3) {
        setPreviewGate(null);
        return;
      }
      const dataDX = (clientDX / ds.containerWidth) * ds.plotW / ds.plotAreaW * (ds.xMax - ds.xMin);
      const dataDY = -(clientDY / ds.containerWidth) * ds.plotH / ds.plotAreaH * (ds.yMax - ds.yMin);
      setPreviewGate(null);

      if (ds.gateType === "polygon" && ds.origVertices) {
        // PATCH polygon with translated vertices
        const newVerts = ds.origVertices.map(([vx, vy]) => [vx + dataDX, vy + dataDY]);
        void (async () => {
          try {
            await patchJson(`${API_BASE}/api/gates/${encodeURIComponent(ds.gateId)}`, { vertices: newVerts });
            undoStackRef.current = [...undoStackRef.current.slice(-49), {
              type: "update", gateId: ds.gateId,
              old: ds.origBounds, new: ds.origBounds, // bounds-undo not supported for poly; treated as no-op
            }];
            redoStackRef.current = [];
            if (file) await fetchGateTree(file.id);
          } catch (err) {
            setGateMessage(`Failed to move gate: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
        return;
      }

      // Rectangle: compute final normalised bounds and PATCH
      const o = ds.origBounds;
      let nb: BoundsSnapshot;
      if (ds.mode === "move") {
        nb = { x_min: o.x_min + dataDX, y_min: o.y_min + dataDY, x_max: o.x_max + dataDX, y_max: o.y_max + dataDY };
      } else if (ds.mode === "resize-nw") {
        nb = { ...o, x_min: o.x_min + dataDX, y_max: o.y_max + dataDY };
      } else if (ds.mode === "resize-ne") {
        nb = { ...o, x_max: o.x_max + dataDX, y_max: o.y_max + dataDY };
      } else if (ds.mode === "resize-sw") {
        nb = { ...o, x_min: o.x_min + dataDX, y_min: o.y_min + dataDY };
      } else {
        nb = { ...o, x_max: o.x_max + dataDX, y_min: o.y_min + dataDY };
      }
      const finalBounds: BoundsSnapshot = {
        x_min: Math.min(nb.x_min, nb.x_max),
        y_min: Math.min(nb.y_min, nb.y_max),
        x_max: Math.max(nb.x_min, nb.x_max),
        y_max: Math.max(nb.y_min, nb.y_max),
      };
      void (async () => {
        try {
          await patchJson(`${API_BASE}/api/gates/${encodeURIComponent(ds.gateId)}`, finalBounds);
          undoStackRef.current = [...undoStackRef.current.slice(-49), { type: "update", gateId: ds.gateId, old: ds.origBounds, new: finalBounds }];
          redoStackRef.current = [];
          if (file) await fetchGateTree(file.id);
        } catch (err) {
          setGateMessage(`Failed to move gate: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [file, fetchGateTree]);

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

  // P-2: Clear zoom whenever the underlying data range changes (new file, gate, channel).
  React.useEffect(() => {
    setZoom(null);
  }, [transformedRange]);

  // P-2: Wheel zoom — scale the view window around the cursor, clamped to the data range.
  React.useEffect(() => {
    const el = plotContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const orig = transformedRangeRef.current;
      if (!orig) return;
      // Suppress browser scroll/page-zoom while hovering the plot.
      e.preventDefault();
      if (plotMode === "histogram") return;
      const cur = zoomRef.current ?? orig;
      const { plotW: pW, plotH: pH, ml: mL, mt: mT, plotAreaW: paW, plotAreaH: paH } =
        plotDimsRef.current;
      const rect = el.getBoundingClientRect();
      // Convert cursor to fractional plot-area position [0,1].
      const localX = ((e.clientX - rect.left) / rect.width) * pW;
      const localY = ((e.clientY - rect.top)  / rect.height) * pH;
      const fracX = Math.max(0, Math.min(1, (localX - mL) / paW));
      const fracY = Math.max(0, Math.min(1, (localY - mT) / paH));
      // Cursor in data space.
      const dataX = cur.xMin + fracX * (cur.xMax - cur.xMin);
      const dataY = cur.yMax - fracY * (cur.yMax - cur.yMin); // SVG y is inverted
      // Zoom factor: scroll-up → zoom in (0.88×), scroll-down → zoom out (1.14×).
      const factor = e.deltaY > 0 ? 1.14 : 1 / 1.14;
      const newSpanX = (cur.xMax - cur.xMin) * factor;
      const newSpanY = (cur.yMax - cur.yMin) * factor;
      let nxMin = dataX - fracX * newSpanX;
      let nxMax = nxMin + newSpanX;
      let nyMax = dataY + fracY * newSpanY;
      let nyMin = nyMax - newSpanY;
      // Clamp to original data range.
      if (nxMin < orig.xMin) { nxMax += orig.xMin - nxMin; nxMin = orig.xMin; }
      if (nxMax > orig.xMax) { nxMin -= nxMax - orig.xMax; nxMax = orig.xMax; }
      if (nyMin < orig.yMin) { nyMax += orig.yMin - nyMin; nyMin = orig.yMin; }
      if (nyMax > orig.yMax) { nyMin -= nyMax - orig.yMax; nyMax = orig.yMax; }
      // Prevent zooming below 1% of original span.
      if (nxMax - nxMin < (orig.xMax - orig.xMin) * 0.01) return;
      if (nyMax - nyMin < (orig.yMax - orig.yMin) * 0.01) return;
      // If zoom returns to (essentially) the full range, clear it.
      const eps = 1e-9;
      if (nxMin <= orig.xMin + eps && nxMax >= orig.xMax - eps &&
          nyMin <= orig.yMin + eps && nyMax >= orig.yMax - eps) {
        setZoom(null);
      } else {
        setZoom({ xMin: nxMin, xMax: nxMax, yMin: nyMin, yMax: nyMax });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotMode]); // zoomRef/transformedRangeRef/plotDimsRef updated via refs → no extra deps needed

  // P-2: Space key → pan mode. Global mousedown on the plot container starts a pan drag.
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" &&
          !(e.target instanceof HTMLInputElement) &&
          !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault(); // prevent page scroll while hovering plot
        spaceDownRef.current = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDownRef.current = false;
        panStartRef.current = null;
        setIsPanning(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // P-2: Register mousedown on the plot container for pan initiation.
  React.useEffect(() => {
    const el = plotContainerRef.current;
    if (!el) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!spaceDownRef.current) return;
      if (plotMode === "histogram") return;
      const orig = transformedRangeRef.current;
      if (!orig) return;
      const snap = zoomRef.current ?? orig;
      panStartRef.current = { clientX: e.clientX, clientY: e.clientY, zoomSnap: snap };
      setIsPanning(true);
      e.preventDefault(); // prevent text selection during drag
    };
    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotMode]);

  const plotW = plotSize.w;
  const plotH = plotSize.h;
  const { ml, mr, mt, mb } = plotScaledMargins(plotW, plotH);
  const plotAreaW = plotW - ml - mr;
  const plotAreaH = plotH - mt - mb;

  // P-2: viewRange = zoomed window in 2D modes; full data range in histogram or when not zoomed.
  const viewRange = zoom != null && plotMode !== "histogram" ? zoom : transformedRange;
  /** Keep a ref to plot dims so pan/wheel handlers don't need stale-closure re-registration. */
  const plotDimsRef = React.useRef({ plotW, plotH, ml, mt, plotAreaW, plotAreaH });
  plotDimsRef.current = { plotW, plotH, ml, mt, plotAreaW, plotAreaH };

  // P-2: Canvas inner-div positioning for zoom (percentage of clip div).
  // The clip div covers the plot area [ml,mt,plotAreaW,plotAreaH].
  // The data canvas covers transformedRange; viewRange is the visible sub-window.
  const czStyle: React.CSSProperties = (() => {
    if (!zoom || !transformedRange || plotMode === "histogram") {
      return { position: "absolute", left: 0, top: 0, width: "100%", height: "100%" };
    }
    const tr = transformedRange;
    const vr = zoom;
    const left = (tr.xMin - vr.xMin) / (vr.xMax - vr.xMin) * 100;
    const top  = (vr.yMax - tr.yMax) / (vr.yMax - vr.yMin) * 100;
    const w    = (tr.xMax - tr.xMin) / (vr.xMax - vr.xMin) * 100;
    const h    = (tr.yMax - tr.yMin) / (vr.yMax - vr.yMin) * 100;
    return { position: "absolute", left: `${left}%`, top: `${top}%`, width: `${w}%`, height: `${h}%` };
  })();

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
        justifyContent: "flex-start",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        background:
          "radial-gradient(circle at top, #0f172a 0, #020617 45%, #020617 100%)",
        color: "white",
        padding: "clamp(1rem, 3vw, 2.5rem)",
        boxSizing: "border-box",
      }}
    >
      {/* Top toolbar — FreeCyto-style editor buttons */}
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          marginBottom: "1.5rem",
          padding: "0.75rem 1rem",
          borderRadius: "0.75rem",
          background: "rgba(15,23,42,0.8)",
          border: "1px solid rgba(148,163,184,0.3)",
          width: "100%",
          maxWidth: "min(1320px, 100%)",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => setTablePanelOpen(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.5rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid rgba(148,163,184,0.4)",
            background: tablePanelOpen ? "rgba(251,191,36,0.2)" : "transparent",
            color: "#fbbf24",
            fontSize: "0.9rem",
            fontWeight: 500,
            cursor: "pointer",
            transition: "all 0.2s",
          }}
        >
          <span>📊</span>
          <span>Table Editor</span>
        </button>

        <button
          type="button"
          onClick={() => setLayoutEditorOpen(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.5rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid rgba(148,163,184,0.4)",
            background: layoutEditorOpen ? "rgba(167,139,250,0.2)" : "transparent",
            color: "#a78bfa",
            fontSize: "0.9rem",
            fontWeight: 500,
            cursor: "pointer",
            transition: "all 0.2s",
          }}
        >
          <span>🗂</span>
          <span>Layout Editor</span>
        </button>

        <button
          type="button"
          onClick={() => setPlatePanelOpen(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.5rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid rgba(148,163,184,0.4)",
            background: platePanelOpen ? "rgba(96,165,250,0.2)" : "transparent",
            color: "#60a5fa",
            fontSize: "0.9rem",
            fontWeight: 500,
            cursor: "pointer",
            transition: "all 0.2s",
          }}
        >
          <span>📋</span>
          <span>Plate Editor</span>
        </button>
      </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(240px, 280px) minmax(0, 1fr)",
              gap: "clamp(0.75rem, 2vw, 2rem)",
              alignItems: "start",
              width: "100%",
              maxWidth: "min(1320px, 100%)",
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
            FreeCyto Studio
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
                  const wsStr = JSON.stringify(wsOut, null, 2);
                  // F-2: persist to session file (non-blocking, ignore errors)
                  fetch(`${API_BASE}/api/session/save`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: wsStr,
                  }).catch(() => { /* session save is best-effort */ });
                  const result =
                    (await window.opencyto?.saveWorkspaceFile?.(wsStr)) ?? { canceled: true };
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
              onClick={() =>
                runSafeUiAction("clear-debug-log", async () => {
                  const r = await window.opencyto?.clearDebugLog?.();
                  if (r?.ok) {
                    setDebugUiStatus(`Cleared log at ${r.path ?? debugLogPath}`);
                    debugLog("[ui.debug] cleared log");
                  } else {
                    setDebugUiStatus(`Failed to clear log: ${r?.error ?? "unknown"}`);
                  }
                })}
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
                          setTransformX(saved.tx ?? DEFAULT_X_TRANSFORM);
                          setTransformY(saved.ty ?? DEFAULT_Y_TRANSFORM);
                        } else {
                          setTransformX(DEFAULT_X_TRANSFORM);
                          setTransformY(DEFAULT_Y_TRANSFORM);
                        }
                        setLoadedFiles((prev) =>
                          prev.map((f) => (f.id === lf.id ? updated : f)),
                        );
                        // J-2: auto-populate spillover table on file switch
                        void loadSpilloverFromFile(lf.id);
                        // E-5: sync compensation badge with backend state for this file
                        try {
                          type CompStatusResp = { is_compensated: boolean; cond?: number | null };
                          const cs = await getJson<CompStatusResp>(
                            `${API_BASE}/api/compensation/status/${encodeURIComponent(lf.id)}`,
                          );
                          setIsCompensated(cs.is_compensated);
                          setCompCond(cs.is_compensated ? (cs.cond ?? null) : null);
                          setCompStatus(cs.is_compensated ? "success" : "idle");
                        } catch {
                          setIsCompensated(false);
                          setCompCond(null);
                          setCompStatus("idle");
                        }
                        setCompError(null);
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
                          setTransformX(saved.tx ?? DEFAULT_X_TRANSFORM);
                          setTransformY(saved.ty ?? DEFAULT_Y_TRANSFORM);
                        } else {
                          setTransformX(DEFAULT_X_TRANSFORM);
                          setTransformY(DEFAULT_Y_TRANSFORM);
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

          {/* T: Experiments (Phase T) */}
          <div style={{ marginBottom: "0.8rem" }}>
            <button
              type="button"
              onClick={() => setExperimentPanelOpen((o) => !o)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                width: "100%",
                textAlign: "left",
                padding: "0.3rem 0.5rem",
                borderRadius: "0.55rem",
                border: "1px solid rgba(148,163,184,0.35)",
                background: experimentPanelOpen ? "rgba(77,166,255,0.12)" : "transparent",
                color: "#90c8ff",
                fontSize: "0.78rem",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              <span>{experimentPanelOpen ? "▾" : "▸"}</span>
              <span>Experiments</span>
            </button>
            {experimentPanelOpen && (
              <div
                style={{
                  marginTop: "0.4rem",
                  borderRadius: "0.65rem",
                  background: "rgba(12,18,36,0.9)",
                  border: "1px solid rgba(77,166,255,0.2)",
                  overflow: "hidden",
                  maxHeight: 360,
                  overflowY: "auto",
                }}
              >
                <ExperimentTree />
              </div>
            )}
          </div>

          {/* Plate Editor button (in sidebar) */}
          <div style={{ marginBottom: "0.8rem" }}>
            <button
              type="button"
              onClick={() => setPlatePanelOpen(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                width: "100%",
                textAlign: "left",
                padding: "0.3rem 0.5rem",
                borderRadius: "0.55rem",
                border: "1px solid rgba(148,163,184,0.35)",
                background: "transparent",
                color: "#60a5fa",
                fontSize: "0.78rem",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              <span>📋</span>
              <span>Plate Editor</span>
            </button>
          </div>

          {/* K: Sample groups panel */}
          {loadedFiles.length > 0 && (
            <div style={{ marginBottom: "0.8rem" }}>
              <button
                type="button"
                onClick={() => { setGroupPanelOpen((o) => !o); if (!groupPanelOpen) void fetchGroups(); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  width: "100%",
                  textAlign: "left",
                  padding: "0.3rem 0.5rem",
                  borderRadius: "0.55rem",
                  border: "1px solid rgba(148,163,184,0.35)",
                  background: groupPanelOpen ? "rgba(99,102,241,0.12)" : "transparent",
                  color: "#c7d2fe",
                  fontSize: "0.78rem",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                <span>{groupPanelOpen ? "▾" : "▸"}</span>
                <span>Sample Groups</span>
                {groups.length > 0 && (
                  <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "#6b7280" }}>
                    {groups.length}
                  </span>
                )}
              </button>

              {groupPanelOpen && (
                <div
                  style={{
                    marginTop: "0.4rem",
                    padding: "0.5rem",
                    borderRadius: "0.65rem",
                    background: "rgba(15,23,42,0.85)",
                    border: "1px solid rgba(99,102,241,0.3)",
                    fontSize: "0.78rem",
                    color: "#9ca3af",
                  }}
                >
                  {/* Create group form */}
                  <div style={{ marginBottom: "0.5rem" }}>
                    <div style={{ fontWeight: 600, color: "#c7d2fe", marginBottom: "0.3rem" }}>Create group</div>
                    <input
                      placeholder="Group name"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      style={{
                        width: "100%",
                        marginBottom: "0.3rem",
                        borderRadius: "0.4rem",
                        border: "1px solid rgba(148,163,184,0.4)",
                        background: "rgba(15,23,42,0.7)",
                        color: "white",
                        fontSize: "0.78rem",
                        padding: "0.2rem 0.4rem",
                      }}
                    />
                    <div style={{ marginBottom: "0.3rem", fontSize: "0.72rem", color: "#6b7280" }}>Select files:</div>
                    {loadedFiles.map((lf) => {
                      const label = lf.sample_name || lf.path.split(/[/\\]/).pop() || lf.id;
                      const checked = newGroupFileIds.includes(lf.id);
                      return (
                        <label
                          key={lf.id}
                          style={{ display: "flex", alignItems: "center", gap: "0.3rem", marginBottom: "0.15rem", cursor: "pointer" }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setNewGroupFileIds((prev) =>
                                e.target.checked ? [...prev, lf.id] : prev.filter((id) => id !== lf.id),
                              )
                            }
                          />
                          <span style={{ fontSize: "0.72rem", color: "#e5e7eb" }}>{label}</span>
                        </label>
                      );
                    })}
                    <button
                      type="button"
                      disabled={!newGroupName.trim() || newGroupFileIds.length === 0}
                      onClick={async () => {
                        setGroupError(null);
                        try {
                          await createGroup(newGroupName.trim(), newGroupFileIds);
                          setNewGroupName("");
                          setNewGroupFileIds([]);
                        } catch (err) {
                          setGroupError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                      style={{
                        marginTop: "0.3rem",
                        padding: "0.25rem 0.7rem",
                        borderRadius: "999px",
                        border: "none",
                        background: "linear-gradient(135deg, #6366f1, #4f46e5)",
                        color: "white",
                        fontSize: "0.75rem",
                        cursor: "pointer",
                        opacity: !newGroupName.trim() || newGroupFileIds.length === 0 ? 0.5 : 1,
                      }}
                    >
                      Create
                    </button>
                    {groupError && <div style={{ color: "#fca5a5", fontSize: "0.72rem", marginTop: "0.2rem" }}>{groupError}</div>}
                  </div>

                  {/* Group list */}
                  {groups.length === 0 && (
                    <div style={{ color: "#4b5563", fontStyle: "italic", fontSize: "0.72rem" }}>No groups yet.</div>
                  )}
                  {groups.map((grp) => {
                    const isExpanded = expandedGroupId === grp.id;
                    return (
                      <div
                        key={grp.id}
                        style={{
                          marginBottom: "0.4rem",
                          borderRadius: "0.5rem",
                          border: "1px solid rgba(99,102,241,0.25)",
                          overflow: "hidden",
                        }}
                      >
                        {/* Group header row */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            padding: "0.25rem 0.4rem",
                            background: isExpanded ? "rgba(99,102,241,0.15)" : "rgba(99,102,241,0.06)",
                            gap: "0.4rem",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => setExpandedGroupId(isExpanded ? null : grp.id)}
                            style={{ background: "none", border: "none", color: "#c7d2fe", cursor: "pointer", fontSize: "0.78rem", padding: 0, flex: 1, textAlign: "left" }}
                          >
                            {isExpanded ? "▾" : "▸"} {grp.name}
                            <span style={{ marginLeft: "0.4rem", color: "#6b7280", fontSize: "0.7rem" }}>
                              ({grp.samples.length} {grp.samples.length === 1 ? "sample" : "samples"})
                            </span>
                          </button>
                          <button
                            type="button"
                            title="Delete group"
                            onClick={() => void deleteGroup(grp.id)}
                            style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "0.8rem", padding: "0 0.2rem" }}
                          >
                            ✕
                          </button>
                        </div>

                        {/* Expanded group details */}
                        {isExpanded && (
                          <div style={{ padding: "0.4rem 0.5rem", background: "rgba(15,23,42,0.6)" }}>
                            {/* Sample list */}
                            <div style={{ marginBottom: "0.4rem" }}>
                              {grp.samples.map((s) => (
                                <div key={s.file_id} style={{ fontSize: "0.72rem", color: "#9ca3af", padding: "0.1rem 0" }}>
                                  {s.label}
                                </div>
                              ))}
                            </div>

                            {/* Template section */}
                            <div style={{ borderTop: "1px solid rgba(148,163,184,0.15)", paddingTop: "0.4rem", marginBottom: "0.4rem" }}>
                              <div style={{ fontWeight: 600, color: "#c7d2fe", marginBottom: "0.25rem", fontSize: "0.72rem" }}>
                                Gating Template {grp.template_id && <span style={{ color: "#4ade80" }}>✓ extracted</span>}
                              </div>
                              <select
                                value={tplSourceFileId}
                                onChange={(e) => setTplSourceFileId(e.target.value)}
                                style={{
                                  width: "100%",
                                  marginBottom: "0.25rem",
                                  borderRadius: "0.35rem",
                                  border: "1px solid rgba(148,163,184,0.4)",
                                  background: "rgba(15,23,42,0.7)",
                                  color: "white",
                                  fontSize: "0.72rem",
                                  padding: "0.18rem 0.3rem",
                                }}
                              >
                                <option value="">— source file —</option>
                                {grp.samples.map((s) => (
                                  <option key={s.file_id} value={s.file_id}>{s.label}</option>
                                ))}
                              </select>
                              <input
                                placeholder="Template name"
                                value={tplName}
                                onChange={(e) => setTplName(e.target.value)}
                                style={{
                                  width: "100%",
                                  marginBottom: "0.25rem",
                                  borderRadius: "0.35rem",
                                  border: "1px solid rgba(148,163,184,0.4)",
                                  background: "rgba(15,23,42,0.7)",
                                  color: "white",
                                  fontSize: "0.72rem",
                                  padding: "0.18rem 0.3rem",
                                }}
                              />
                              <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  disabled={!tplSourceFileId || !tplName.trim() || tplStatus === "working"}
                                  onClick={async () => {
                                    setTplStatus("working");
                                    setTplError(null);
                                    try {
                                      type TplResp = { id: string; name: string; source_file_id: string; gate_count: number };
                                      await postJson<TplResp>(`${API_BASE}/api/groups/${encodeURIComponent(grp.id)}/template`, {
                                        source_file_id: tplSourceFileId,
                                        template_name: tplName.trim(),
                                      });
                                      await fetchGroups();
                                      setTplName("");
                                      setTplSourceFileId("");
                                      setTplStatus("done");
                                    } catch (err) {
                                      setTplError(err instanceof Error ? err.message : String(err));
                                      setTplStatus("error");
                                    }
                                  }}
                                  style={{
                                    padding: "0.2rem 0.5rem",
                                    borderRadius: "999px",
                                    border: "none",
                                    background: "rgba(99,102,241,0.5)",
                                    color: "white",
                                    fontSize: "0.72rem",
                                    cursor: "pointer",
                                  }}
                                >
                                  Extract
                                </button>
                                {grp.template_id && (
                                  <button
                                    type="button"
                                    disabled={tplStatus === "working"}
                                    onClick={async () => {
                                      setTplStatus("working");
                                      setTplError(null);
                                      try {
                                        await postJson(`${API_BASE}/api/groups/${encodeURIComponent(grp.id)}/apply-template`, {
                                          template_id: grp.template_id,
                                        });
                                        setTplStatus("done");
                                        // Refresh gate tree if current file is in this group
                                        if (file && grp.samples.some((s) => s.file_id === file.id)) {
                                          await fetchGateTree(file.id);
                                        }
                                      } catch (err) {
                                        setTplError(err instanceof Error ? err.message : String(err));
                                        setTplStatus("error");
                                      }
                                    }}
                                    style={{
                                      padding: "0.2rem 0.5rem",
                                      borderRadius: "999px",
                                      border: "none",
                                      background: "rgba(34,197,94,0.4)",
                                      color: "white",
                                      fontSize: "0.72rem",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Apply to all
                                  </button>
                                )}
                              </div>
                              {tplStatus === "done" && <div style={{ color: "#4ade80", fontSize: "0.7rem", marginTop: "0.2rem" }}>Done</div>}
                              {tplStatus === "error" && tplError && <div style={{ color: "#fca5a5", fontSize: "0.7rem", marginTop: "0.2rem" }}>{tplError}</div>}
                            </div>

                            {/* Batch statistics section */}
                            <div style={{ borderTop: "1px solid rgba(148,163,184,0.15)", paddingTop: "0.4rem" }}>
                              <div style={{ fontWeight: 600, color: "#c7d2fe", marginBottom: "0.25rem", fontSize: "0.72rem" }}>Batch Statistics</div>
                              <div style={{ display: "flex", gap: "0.3rem", marginBottom: "0.3rem" }}>
                                <input
                                  placeholder="Gate name"
                                  value={batchGateName}
                                  onChange={(e) => setBatchGateName(e.target.value)}
                                  style={{
                                    flex: 1,
                                    borderRadius: "0.35rem",
                                    border: "1px solid rgba(148,163,184,0.4)",
                                    background: "rgba(15,23,42,0.7)",
                                    color: "white",
                                    fontSize: "0.72rem",
                                    padding: "0.18rem 0.3rem",
                                  }}
                                />
                                <button
                                  type="button"
                                  disabled={!batchGateName.trim() || batchStatsLoading}
                                  onClick={async () => {
                                    setBatchStatsLoading(true);
                                    try {
                                      type StatsResp = { group_id: string; gate_name: string; rows: BatchStatRow[] };
                                      const data = await getJson<StatsResp>(
                                        `${API_BASE}/api/groups/${encodeURIComponent(grp.id)}/batch-stats?gate_name=${encodeURIComponent(batchGateName.trim())}`,
                                      );
                                      setBatchStats({ groupId: grp.id, rows: data.rows });
                                    } finally {
                                      setBatchStatsLoading(false);
                                    }
                                  }}
                                  style={{
                                    padding: "0.2rem 0.5rem",
                                    borderRadius: "999px",
                                    border: "none",
                                    background: "rgba(99,102,241,0.5)",
                                    color: "white",
                                    fontSize: "0.72rem",
                                    cursor: "pointer",
                                  }}
                                >
                                  {batchStatsLoading ? "…" : "Run"}
                                </button>
                              </div>

                              {batchStats && batchStats.groupId === grp.id && (
                                <>
                                  <div style={{ overflowX: "auto", marginBottom: "0.3rem" }}>
                                    <table style={{ borderCollapse: "collapse", fontSize: "0.7rem", width: "100%" }}>
                                      <thead>
                                        <tr style={{ color: "#6b7280", borderBottom: "1px solid rgba(148,163,184,0.2)" }}>
                                          <th style={{ textAlign: "left", padding: "0.15rem 0.25rem" }}>Sample</th>
                                          <th style={{ textAlign: "right", padding: "0.15rem 0.25rem" }}>Count</th>
                                          <th style={{ textAlign: "right", padding: "0.15rem 0.25rem" }}>% Parent</th>
                                          <th style={{ textAlign: "right", padding: "0.15rem 0.25rem" }}>% Total</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {batchStats.rows.map((row) => (
                                          <tr key={row.file_id} style={{ borderBottom: "1px solid rgba(148,163,184,0.1)" }}>
                                            <td style={{ padding: "0.15rem 0.25rem", color: "#e5e7eb", maxWidth: "100px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                              {row.label}
                                            </td>
                                            <td style={{ padding: "0.15rem 0.25rem", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#e5e7eb" }}>
                                              {row.count.toLocaleString()}
                                            </td>
                                            <td style={{ padding: "0.15rem 0.25rem", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#93c5fd" }}>
                                              {row.pct_of_parent.toFixed(1)}%
                                            </td>
                                            <td style={{ padding: "0.15rem 0.25rem", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#6b7280" }}>
                                              {row.pct_of_total.toFixed(1)}%
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                  <a
                                    href={`${API_BASE}/api/groups/${encodeURIComponent(grp.id)}/export.csv?gate_name=${encodeURIComponent(batchGateName.trim())}`}
                                    download
                                    style={{
                                      fontSize: "0.7rem",
                                      color: "#a5b4fc",
                                      textDecoration: "none",
                                      borderBottom: "1px solid rgba(165,180,252,0.4)",
                                    }}
                                  >
                                    ↓ Export CSV
                                  </a>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
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
                <div data-testid="file-event-count" style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <span><strong>Events:</strong> {file.event_count.toLocaleString()}</span>
                  {/* M: Download all (compensated) events as FCS */}
                  <a
                    href={`${API_BASE}/api/files/${encodeURIComponent(file.id)}/export-fcs`}
                    download
                    title="Download all events as FCS 3.1 file"
                    style={{
                      fontSize: "0.72rem",
                      color: "#94a3b8",
                      textDecoration: "none",
                      border: "1px solid rgba(148,163,184,0.35)",
                      borderRadius: "0.3rem",
                      padding: "0 0.35rem",
                    }}
                  >
                    ↓ FCS
                  </a>
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
                    onChange={(e) =>
                      runSafeUiAction("transform-x-change", async () => {
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
                      })}
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
                    onChange={(e) =>
                      runSafeUiAction("transform-y-change", async () => {
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
                      })}
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

              {/* J-2: Compact compensation status bar — full editor lives in the modal */}
              <div
                style={{
                  marginTop: "0.4rem",
                  marginBottom: "0.7rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: "0.78rem", color: "#9ca3af", fontWeight: 500 }}>Compensation:</span>
                {isCompensated ? (
                  <span style={{ fontSize: "0.78rem", color: "#4ade80" }}>
                    ✓ Applied{compCond != null && ` — κ=${compCond.toFixed(1)}`}
                  </span>
                ) : (
                  <span style={{ fontSize: "0.78rem", color: "#64748b", fontStyle: "italic" }}>not applied</span>
                )}
                <button
                  type="button"
                  onClick={() => setCompensationFullMatrixOpen(true)}
                  style={{
                    padding: "0.2rem 0.55rem",
                    borderRadius: "0.35rem",
                    border: "1px solid rgba(168,85,247,0.45)",
                    background: "rgba(168,85,247,0.12)",
                    color: "#d8b4fe",
                    fontSize: "0.73rem",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  🔬 {spillMatrix.length > 0 ? "Edit matrix" : "Load & apply"}
                </button>
              </div>
            </>
          )}

          {/* L: Derived Parameters panel */}
          {file && (
            <div style={{ marginBottom: "0.8rem" }}>
              <button
                type="button"
                onClick={() => {
                  setDpPanelOpen((o) => !o);
                  if (!dpPanelOpen && file) void fetchDerivedParams(file.id);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  width: "100%",
                  textAlign: "left",
                  padding: "0.3rem 0.5rem",
                  borderRadius: "0.55rem",
                  border: "1px solid rgba(167,139,250,0.35)",
                  background: dpPanelOpen ? "rgba(139,92,246,0.12)" : "transparent",
                  color: "#c4b5fd",
                  fontSize: "0.78rem",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                <span>{dpPanelOpen ? "▾" : "▸"}</span>
                <span>Derived Parameters</span>
                {derivedParams.length > 0 && (
                  <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "#6b7280" }}>
                    {derivedParams.length}
                  </span>
                )}
              </button>

              {dpPanelOpen && (
                <div
                  style={{
                    marginTop: "0.4rem",
                    padding: "0.5rem",
                    borderRadius: "0.65rem",
                    background: "rgba(15,23,42,0.85)",
                    border: "1px solid rgba(139,92,246,0.3)",
                    fontSize: "0.78rem",
                    color: "#9ca3af",
                  }}
                >
                  {/* Create form */}
                  <div style={{ marginBottom: "0.5rem" }}>
                    <div style={{ fontWeight: 600, color: "#c4b5fd", marginBottom: "0.3rem" }}>New virtual channel</div>
                    <input
                      placeholder="Name (e.g. FSC_ratio)"
                      value={dpName}
                      onChange={(e) => { setDpName(e.target.value); setDpError(null); }}
                      style={{
                        width: "100%",
                        marginBottom: "0.25rem",
                        borderRadius: "0.4rem",
                        border: "1px solid rgba(148,163,184,0.4)",
                        background: "rgba(15,23,42,0.7)",
                        color: "white",
                        fontSize: "0.78rem",
                        padding: "0.2rem 0.4rem",
                      }}
                    />
                    <input
                      placeholder="Expression (e.g. FSC-A / SSC-A)"
                      value={dpExpr}
                      onChange={(e) => { setDpExpr(e.target.value); setDpError(null); }}
                      title="Use channel names directly. Supported: +  −  *  /  **  log10(…)  sqrt(…)"
                      style={{
                        width: "100%",
                        marginBottom: "0.25rem",
                        borderRadius: "0.4rem",
                        border: "1px solid rgba(139,92,246,0.4)",
                        background: "rgba(15,23,42,0.7)",
                        color: "#c4b5fd",
                        fontSize: "0.78rem",
                        padding: "0.2rem 0.4rem",
                      }}
                    />
                    <button
                      type="button"
                      disabled={!dpName.trim() || !dpExpr.trim() || dpLoading}
                      onClick={async () => {
                        if (!file || !dpName.trim() || !dpExpr.trim()) return;
                        setDpLoading(true);
                        setDpError(null);
                        try {
                          await postJson<DerivedParamInfo>(`${API_BASE}/api/derived-params/${encodeURIComponent(file.id)}`, {
                            file_id: file.id,
                            name: dpName.trim(),
                            expression: dpExpr.trim(),
                          });
                          setDpName("");
                          setDpExpr("");
                          await fetchDerivedParams(file.id);
                        } catch (err) {
                          setDpError(err instanceof Error ? err.message : String(err));
                        } finally {
                          setDpLoading(false);
                        }
                      }}
                      style={{
                        padding: "0.25rem 0.7rem",
                        borderRadius: "999px",
                        border: "none",
                        background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
                        color: "white",
                        fontSize: "0.75rem",
                        cursor: "pointer",
                        opacity: !dpName.trim() || !dpExpr.trim() || dpLoading ? 0.5 : 1,
                      }}
                    >
                      {dpLoading ? "Creating…" : "Create"}
                    </button>
                    {dpError && <div style={{ color: "#fca5a5", fontSize: "0.72rem", marginTop: "0.2rem" }}>{dpError}</div>}
                  </div>

                  {/* Derived param list */}
                  {derivedParams.length === 0 ? (
                    <div style={{ color: "#4b5563", fontStyle: "italic", fontSize: "0.72rem" }}>No derived parameters yet.</div>
                  ) : (
                    <div>
                      {derivedParams.map((dp) => (
                        <div
                          key={dp.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.3rem",
                            padding: "0.2rem 0.1rem",
                            borderBottom: "1px solid rgba(148,163,184,0.08)",
                          }}
                        >
                          <span style={{ flex: 1, fontSize: "0.72rem", color: "#c4b5fd", fontWeight: 500 }}>{dp.name}</span>
                          <span style={{ fontSize: "0.68rem", color: "#6b7280", flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            = {dp.expression}
                          </span>
                          <button
                            type="button"
                            title="Delete"
                            onClick={async () => {
                              if (!file) return;
                              try {
                                await fetch(
                                  `${API_BASE}/api/derived-params/${encodeURIComponent(file.id)}/${encodeURIComponent(dp.id)}`,
                                  { method: "DELETE" },
                                );
                                await fetchDerivedParams(file.id);
                              } catch {
                                /* ignore */
                              }
                            }}
                            style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: "0.75rem", padding: "0 0.15rem", flexShrink: 0 }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
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
                  {(plotMode !== "histogram"
                    ? [
                        { id: "rectangle", label: "Rect" },
                        { id: "polygon", label: "Poly" },
                        { id: "quadrant", label: "Quad" },
                        { id: "ellipse", label: "Ellipse" },
                      ]
                    : [{ id: "interval", label: "Interval" }]
                  ).map((tool) => {
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
                          setPendingInterval(null);
                          setPendingEllipse(null);
                          setDrawingRect(null);
                          setDrawingPolygon(null);
                          setDrawingInterval(null);
                          setGateNameError(null);
                          setBoolGateError(null);
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
                  {/* L: Boolean gate tool — no canvas interaction needed */}
                  {plotMode !== "histogram" && (() => {
                    const active = gateTool === "boolean";
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          const next: typeof gateTool = active ? null : "boolean";
                          setGateTool(next);
                          setDrawMode(false);
                          setPendingGate(null);
                          setPendingInterval(null);
                          setPendingEllipse(null);
                          setDrawingRect(null);
                          setDrawingPolygon(null);
                          setDrawingInterval(null);
                          setGateNameError(null);
                          setBoolGateName("");
                          setBoolExpression("");
                          setBoolGateError(null);
                        }}
                        style={{
                          padding: "0.25rem 0.6rem",
                          borderRadius: "999px",
                          border: active ? "1px solid rgba(167,139,250,0.9)" : "1px solid rgba(148,163,184,0.7)",
                          fontSize: "0.78rem",
                          cursor: "pointer",
                          background: active ? "rgba(139,92,246,0.25)" : "transparent",
                          color: active ? "#c4b5fd" : "#e5e7eb",
                        }}
                      >
                        Bool
                      </button>
                    );
                  })()}
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
                        // P-2: draw in viewRange space so gates placed while zoomed are correct.
                        const r = viewRange ?? transformedRange;
                        const xMin = r.xMin + (r.xMax - r.xMin) * Math.min(pendingGate.nxMin, pendingGate.nxMax);
                        const xMax = r.xMin + (r.xMax - r.xMin) * Math.max(pendingGate.nxMin, pendingGate.nxMax);
                        const yMin = r.yMin + (r.yMax - r.yMin) * Math.min(pendingGate.nyMin, pendingGate.nyMax);
                        const yMax = r.yMin + (r.yMax - r.yMin) * Math.max(pendingGate.nyMin, pendingGate.nyMax);
                        const name = pendingGate.gateName.trim() || "Gate";
                        setGateNameError(null);
                        try {
                          const created = await postJson<{ id: string }>(`${API_BASE}/api/gates`, {
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
                          undoStackRef.current = [...undoStackRef.current.slice(-49), { type: "create", gateId: created.id }];
                          redoStackRef.current = [];
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
                {gateTool === "interval" && pendingInterval && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      value={pendingInterval.gateName}
                      onChange={(e) => {
                        setGateNameError(null);
                        setPendingInterval((p) => (p ? { ...p, gateName: e.target.value } : null));
                      }}
                      placeholder="Interval gate name"
                      autoFocus
                      style={{
                        padding: "0.25rem 0.5rem",
                        width: "150px",
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
                        if (!file || !pendingInterval) return;
                        const name = pendingInterval.gateName.trim() || "Interval gate";
                        setGateNameError(null);
                        try {
                          const created = await postJson<{ id: string }>(`${API_BASE}/api/gates`, {
                            file_id: file.id,
                            name,
                            x_channel: xChannel,
                            y_channel: "",
                            parent_gate_id: activeGateId,
                            transform_x: transformX,
                            transform_y: "linear",
                            arcsinh_cofactor: 150,
                            params: { type: "interval", x_min: pendingInterval.xMin, x_max: pendingInterval.xMax },
                          });
                          undoStackRef.current = [...undoStackRef.current.slice(-49), { type: "create", gateId: created.id }];
                          redoStackRef.current = [];
                          await fetchGateTree(file.id);
                          setPendingInterval(null);
                          setDrawMode(false);
                          setGateTool(null);
                        } catch (e) {
                          if (e instanceof Error && e.message.startsWith("HTTP 409")) {
                            setGateNameError("Name already in use");
                          } else {
                            setGateNameError(e instanceof Error ? e.message : "Failed to create gate");
                          }
                        }
                      }}
                      style={{ padding: "0.25rem 0.5rem", borderRadius: "0.35rem", border: "none", fontSize: "0.8rem", cursor: "pointer", background: "#22c55e", color: "white" }}
                    >
                      Create interval gate
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPendingInterval(null); setDrawMode(true); }}
                      style={{ padding: "0.25rem 0.5rem", borderRadius: "0.35rem", border: "1px solid #6b7280", fontSize: "0.8rem", cursor: "pointer", background: "transparent", color: "#9ca3af" }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {/* N: Ellipse gate name form */}
                {gateTool === "ellipse" && pendingEllipse && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      value={pendingEllipse.gateName}
                      onChange={(e) => {
                        setGateNameError(null);
                        setPendingEllipse((p) => (p ? { ...p, gateName: e.target.value } : null));
                      }}
                      placeholder="Ellipse gate name"
                      autoFocus
                      style={{
                        padding: "0.25rem 0.5rem",
                        width: "150px",
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
                        if (!file || !pendingEllipse || !transformedRange) return;
                        // P-2: use viewRange for correct data coords when placing in a zoomed view.
                        const r = viewRange ?? transformedRange;
                        const cx = r.xMin + (r.xMax - r.xMin) * pendingEllipse.nCx;
                        const cy = r.yMin + (r.yMax - r.yMin) * pendingEllipse.nCy;
                        const rx = (r.xMax - r.xMin) * pendingEllipse.nRx;
                        const ry = (r.yMax - r.yMin) * pendingEllipse.nRy;
                        const name = pendingEllipse.gateName.trim() || "Ellipse gate";
                        setGateNameError(null);
                        try {
                          const created = await postJson<{ id: string }>(`${API_BASE}/api/gates`, {
                            file_id: file.id,
                            name,
                            x_channel: xChannel,
                            y_channel: yChannel,
                            parent_gate_id: activeGateId,
                            transform_x: transformX,
                            transform_y: transformY,
                            arcsinh_cofactor: 150,
                            params: { type: "ellipse", center_x: cx, center_y: cy, radius_x: rx, radius_y: ry, angle: 0 },
                          });
                          undoStackRef.current = [...undoStackRef.current.slice(-49), { type: "create", gateId: created.id }];
                          redoStackRef.current = [];
                          await fetchGateTree(file.id);
                          setPendingEllipse(null);
                          setDrawMode(false);
                          setGateTool(null);
                        } catch (e) {
                          if (e instanceof Error && e.message.startsWith("HTTP 409")) {
                            setGateNameError("Name already in use");
                          } else {
                            setGateNameError(e instanceof Error ? e.message : "Failed to create ellipse gate");
                          }
                        }
                      }}
                      style={{ padding: "0.25rem 0.5rem", borderRadius: "0.35rem", border: "none", fontSize: "0.8rem", cursor: "pointer", background: "#22c55e", color: "white" }}
                    >
                      Create ellipse gate
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPendingEllipse(null); setDrawMode(true); }}
                      style={{ padding: "0.25rem 0.5rem", borderRadius: "0.35rem", border: "1px solid #6b7280", fontSize: "0.8rem", cursor: "pointer", background: "transparent", color: "#9ca3af" }}
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
                        // P-2: use viewRange so polygon vertices are in the correct data space.
                        const r = viewRange ?? transformedRange;
                        const rawVerts = drawingPolygon.points.map((p) => [
                          r.xMin + (r.xMax - r.xMin) * p.x,
                          r.yMin + (r.yMax - r.yMin) * p.y,
                        ]);
                        setGateNameError(null);
                        try {
                          const created = await postJson<{ id: string }>(`${API_BASE}/api/gates`, {
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
                          undoStackRef.current = [...undoStackRef.current.slice(-49), { type: "create", gateId: created.id }];
                          redoStackRef.current = [];
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
                {/* S-1: Boolean gate creation form — expression builder with gate-name chips */}
                {gateTool === "boolean" && (() => {
                  /** Insert text at the current cursor position in the expression input. */
                  const insertAtCursor = (token: string) => {
                    const input = boolExprInputRef.current;
                    if (!input) {
                      setBoolExpression((p) => p ? `${p} ${token}` : token);
                      return;
                    }
                    const start = input.selectionStart ?? boolExpression.length;
                    const end = input.selectionEnd ?? boolExpression.length;
                    const before = boolExpression.slice(0, start);
                    const after = boolExpression.slice(end);
                    const sep = before && !before.endsWith(" ") ? " " : "";
                    const sepAfter = after && !after.startsWith(" ") ? " " : "";
                    const next = before + sep + token + sepAfter + after;
                    setBoolExpression(next);
                    setBoolGateError(null);
                    // Restore focus and move cursor after inserted token
                    requestAnimationFrame(() => {
                      input.focus();
                      const pos = start + sep.length + token.length + sepAfter.length;
                      input.setSelectionRange(pos, pos);
                    });
                  };

                  // Gate names available in this file (not boolean type itself to avoid self-reference)
                  const availableGateNames = gateList
                    .filter((g) => g.type !== "boolean")
                    .map((g) => g.name);

                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", width: "100%" }}>
                      {/* Row 1: name + expression + action buttons */}
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                        <input
                          type="text"
                          value={boolGateName}
                          onChange={(e) => { setBoolGateName(e.target.value); setBoolGateError(null); }}
                          placeholder="Gate name"
                          style={{
                            padding: "0.25rem 0.5rem",
                            width: "110px",
                            borderRadius: "0.35rem",
                            border: "1px solid rgba(148,163,184,0.6)",
                            background: "rgba(15,23,42,0.8)",
                            color: "white",
                            fontSize: "0.8rem",
                          }}
                        />
                        <input
                          ref={boolExprInputRef}
                          type="text"
                          value={boolExpression}
                          onChange={(e) => { setBoolExpression(e.target.value); setBoolGateError(null); }}
                          placeholder="e.g. Lymphocytes AND NOT Dead"
                          title="AND / OR / NOT operators. Click gate chips below to insert. Backtick-quote names with spaces: `CD4+ cells`"
                          style={{
                            padding: "0.25rem 0.5rem",
                            flex: "1 1 180px",
                            minWidth: "140px",
                            borderRadius: "0.35rem",
                            border: `1px solid ${boolGateError ? "rgba(248,113,113,0.7)" : "rgba(167,139,250,0.5)"}`,
                            background: "rgba(15,23,42,0.8)",
                            color: "#c4b5fd",
                            fontSize: "0.8rem",
                          }}
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            if (!file || !boolExpression.trim()) return;
                            const name = boolGateName.trim() || "Bool gate";
                            setBoolGateError(null);
                            try {
                              const created = await postJson<{ id: string }>(`${API_BASE}/api/gates`, {
                                file_id: file.id,
                                name,
                                x_channel: "",
                                y_channel: "",
                                parent_gate_id: activeGateId,
                                params: { type: "boolean", expression: boolExpression.trim() },
                              });
                              undoStackRef.current = [...undoStackRef.current.slice(-49), { type: "create", gateId: created.id }];
                              redoStackRef.current = [];
                              await fetchGateTree(file.id);
                              setBoolGateName("");
                              setBoolExpression("");
                              setGateTool(null);
                            } catch (e) {
                              if (e instanceof Error && e.message.startsWith("HTTP 409")) {
                                setBoolGateError("Name already in use");
                              } else {
                                setBoolGateError(e instanceof Error ? e.message : "Failed to create gate");
                              }
                            }
                          }}
                          disabled={!boolExpression.trim()}
                          style={{
                            padding: "0.25rem 0.5rem",
                            borderRadius: "0.35rem",
                            border: "none",
                            fontSize: "0.8rem",
                            cursor: !boolExpression.trim() ? "not-allowed" : "pointer",
                            background: "#8b5cf6",
                            color: "white",
                            opacity: !boolExpression.trim() ? 0.6 : 1,
                          }}
                        >
                          Create
                        </button>
                        <button
                          type="button"
                          onClick={() => { setGateTool(null); setBoolGateName(""); setBoolExpression(""); setBoolGateError(null); }}
                          style={{ padding: "0.25rem 0.5rem", borderRadius: "0.35rem", border: "1px solid #6b7280", fontSize: "0.8rem", cursor: "pointer", background: "transparent", color: "#9ca3af" }}
                        >
                          Cancel
                        </button>
                        {boolGateError && <span style={{ color: "#fca5a5", fontSize: "0.75rem" }}>{boolGateError}</span>}
                      </div>
                      {/* Row 2: operator chips + gate name chips */}
                      <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", flexWrap: "wrap", paddingLeft: "0.1rem" }}>
                        <span style={{ fontSize: "0.7rem", color: "#64748b", marginRight: "0.1rem" }}>Insert:</span>
                        {(["AND", "OR", "NOT"] as const).map((op) => (
                          <button
                            key={op}
                            type="button"
                            onClick={() => insertAtCursor(op)}
                            style={{
                              padding: "0.1rem 0.4rem",
                              borderRadius: "0.25rem",
                              border: "1px solid rgba(167,139,250,0.5)",
                              background: "rgba(139,92,246,0.15)",
                              color: "#a78bfa",
                              fontSize: "0.7rem",
                              cursor: "pointer",
                              fontWeight: 600,
                              fontFamily: "monospace",
                            }}
                          >
                            {op}
                          </button>
                        ))}
                        {availableGateNames.length > 0 && (
                          <span style={{ fontSize: "0.7rem", color: "#475569", margin: "0 0.15rem" }}>|</span>
                        )}
                        {availableGateNames.map((gateName) => {
                          const needsQuote = /[^a-zA-Z0-9_\-]/.test(gateName);
                          const token = needsQuote ? `\`${gateName}\`` : gateName;
                          return (
                            <button
                              key={gateName}
                              type="button"
                              onClick={() => insertAtCursor(token)}
                              title={needsQuote ? `Inserts: \`${gateName}\`` : `Inserts: ${gateName}`}
                              style={{
                                padding: "0.1rem 0.4rem",
                                borderRadius: "0.25rem",
                                border: "1px solid rgba(148,163,184,0.35)",
                                background: "rgba(30,41,59,0.7)",
                                color: "#93c5fd",
                                fontSize: "0.7rem",
                                cursor: "pointer",
                                maxWidth: "120px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {gateName}
                            </button>
                          );
                        })}
                        {availableGateNames.length === 0 && (
                          <span style={{ fontSize: "0.7rem", color: "#475569", fontStyle: "italic" }}>
                            No gates yet — create rectangle/polygon gates first
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}
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
                    onClick={() => { setPlotMode("histogram"); setDrawMode(false); setGateTool(null); }}
                    style={{
                      padding: "0.1rem 0.45rem",
                      borderRadius: "999px",
                      border: "1px solid rgba(148,163,184,0.6)",
                      backgroundColor:
                        plotMode === "histogram" ? "rgba(148,163,184,0.3)" : "transparent",
                      color: "#e5e7eb",
                      fontSize: "0.7rem",
                      cursor: "pointer",
                    }}
                  >
                    Histogram
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
                  {/* R-3: Backgating toggle (only available in points mode with active gate) */}
                  {plotMode === "points" && activeGateId && (
                    <button
                      type="button"
                      onClick={() => setShowBackgate((b) => !b)}
                      title="Toggle backgating: show parent population as faded background overlay"
                      style={{
                        padding: "0.1rem 0.45rem",
                        borderRadius: "999px",
                        border: showBackgate ? "1px solid rgba(168,85,247,0.9)" : "1px solid rgba(148,163,184,0.6)",
                        fontSize: "0.7rem",
                        cursor: "pointer",
                        backgroundColor: showBackgate ? "rgba(168,85,247,0.2)" : "transparent",
                        color: showBackgate ? "#d8b4fe" : "#e5e7eb",
                      }}
                    >
                      {showBackgate ? "✓ Backgate" : "Backgate"}
                    </button>
                  )}
                  {/* E-4: compensation status badge in plot header */}
                  {file && (
                    <span
                      title={
                        isCompensated
                          ? compCond != null
                            ? `Compensated · κ=${compCond.toFixed(1)}`
                            : "Compensated"
                          : "Raw (uncompensated)"
                      }
                      style={{
                        padding: "0.1rem 0.45rem",
                        borderRadius: "999px",
                        fontSize: "0.65rem",
                        fontWeight: 600,
                        letterSpacing: "0.03em",
                        userSelect: "none",
                        background: isCompensated
                          ? "rgba(34,197,94,0.18)"
                          : "rgba(148,163,184,0.12)",
                        color: isCompensated ? "#4ade80" : "#64748b",
                        border: `1px solid ${isCompensated ? "rgba(34,197,94,0.4)" : "rgba(148,163,184,0.3)"}`,
                      }}
                    >
                      {isCompensated ? "Comp" : "Raw"}
                    </span>
                  )}
                  {/* J-3: time channel auto-detection badge */}
                  {file && channels.some((ch) => ch.name.toLowerCase() === "time") && (
                    <span
                      title="This file includes a Time channel. Select it as the X axis to view time-domain data."
                      style={{
                        padding: "0.1rem 0.45rem",
                        borderRadius: "999px",
                        fontSize: "0.65rem",
                        fontWeight: 600,
                        letterSpacing: "0.03em",
                        userSelect: "none",
                        background: "rgba(99,102,241,0.18)",
                        color: "#a5b4fc",
                        border: "1px solid rgba(99,102,241,0.4)",
                      }}
                    >
                      Time
                    </span>
                  )}
                  {plotMode === "density" && (
                    <>
                      {(["jet", "viridis", "inferno"] as const).map((cm) => (
                        <button
                          key={cm}
                          type="button"
                          onClick={() => setDensityColormapSafe(cm)}
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
                      {/* O: density contour lines toggle */}
                      <button
                        type="button"
                        onClick={() => setShowContours((v) => !v)}
                        style={{
                          padding: "0.1rem 0.4rem",
                          borderRadius: "999px",
                          border: "1px solid rgba(148,163,184,0.6)",
                          fontSize: "0.65rem",
                          cursor: "pointer",
                          backgroundColor: showContours ? "rgba(148,163,184,0.35)" : "transparent",
                          color: "#e5e7eb",
                        }}
                      >
                        Contours
                      </button>
                    </>
                  )}
                  {/* P-2: Reset zoom button — visible whenever a zoom is active in any 2D mode */}
                  {zoom && plotMode !== "histogram" && (
                    <button
                      type="button"
                      onClick={() => setZoom(null)}
                      style={{
                        padding: "0.1rem 0.45rem",
                        borderRadius: "999px",
                        border: "1px solid rgba(251,191,36,0.7)",
                        fontSize: "0.65rem",
                        cursor: "pointer",
                        backgroundColor: "rgba(251,191,36,0.18)",
                        color: "#fbbf24",
                        fontWeight: 600,
                      }}
                    >
                      ↺ Reset zoom
                    </button>
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
                cursor: isPanning ? "grabbing" : undefined,
              }}
              onDoubleClick={() => {
                if (zoom !== null && plotMode !== "histogram") setZoom(null);
              }}
            >
            {plotMode === "density" && density && (
              // Outer clip div: fixed to the plot area, hides overflow when zoomed.
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
                {/* P-2: inner div repositioned by czStyle to implement CSS zoom */}
                <div style={czStyle}>
                  <PseudocolorCanvas
                    counts={density.counts}
                    width={Math.max(120, Math.floor(plotAreaW * 2))}
                    height={Math.max(120, Math.floor(plotAreaH * 2))}
                    colormap={densityColormap}
                    scale={densityDisplayScale}
                  />
                </div>
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
                {/* P-2: inner div repositioned by czStyle to implement CSS zoom */}
                <div style={czStyle}>
                  {/* R-3: Backgating layer (parent population) - rendered behind main scatter */}
                  {showBackgate && backgatePoints.length > 0 && (
                    <div style={{ position: "absolute", inset: 0 }}>
                      <ScatterCanvas
                        points={backgatePoints}
                        plotAreaW={plotAreaW}
                        plotAreaH={plotAreaH}
                        bgMode={plotBgMode}
                        pointColor={plotBgMode === "white" ? "rgba(120,120,120,0.35)" : "rgba(180,180,180,0.25)"}
                      />
                    </div>
                  )}
                  <ScatterCanvas points={points} plotAreaW={plotAreaW} plotAreaH={plotAreaH} bgMode={plotBgMode} />
                </div>
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
                  if (gateTool === "interval") {
                    setDrawingInterval({ startX: x, endX: x });
                  } else if (gateTool === "rectangle" || gateTool === "ellipse") {
                    setDrawingRect({ startX: x, startY: y, endX: x, endY: y });
                  } else if (gateTool === "polygon") {
                    setDrawingPolygon((prev) => ({
                      points: [...(prev?.points ?? []), { x, y }],
                    }));
                  } else if (gateTool === "quadrant") {
                    if (!file || !transformedRange) return;
                    // P-2: cursor position uses viewRange (zoomed view); extents use transformedRange (full data).
                    const vr = viewRange ?? transformedRange;
                    const tr = transformedRange;
                    const xRaw = vr.xMin + (vr.xMax - vr.xMin) * x;
                    const yRaw = vr.yMin + (vr.yMax - vr.yMin) * y;
                    void (async () => {
                      try {
                        // Find an unused name prefix (Quad, Quad_2, Quad_3, ...)
                        const namesInUse = new Set(gateList.map((g) => g.name));
                        let prefix = "Quad";
                        for (let a = 1; a < 100; a++) {
                          const candidates = [`${prefix}_Q1`, `${prefix}_Q2`, `${prefix}_Q3`, `${prefix}_Q4`];
                          if (!candidates.some((n) => namesInUse.has(n))) break;
                          prefix = `Quad_${a + 1}`;
                        }

                        // R-1: Use atomic quadrant endpoint (auto rollback on failure)
                        const result = await postJson<{ q1: { id: string }; q2: { id: string }; q3: { id: string }; q4: { id: string } }>(
                          `${API_BASE}/api/gates/quadrant`,
                          {
                            file_id: file.id,
                            x_channel: xChannel,
                            y_channel: yChannel,
                            x_split: xRaw,
                            y_split: yRaw,
                            name_prefix: prefix,
                            parent_gate_id: activeGateId,
                            transform_x: transformX,
                            transform_y: transformY,
                            arcsinh_cofactor: 150,
                            x_min: tr.xMin,
                            x_max: tr.xMax,
                            y_min: tr.yMin,
                            y_max: tr.yMax,
                          }
                        );
                        const createdIds = [result.q1.id, result.q2.id, result.q3.id, result.q4.id];
                        undoStackRef.current = [...undoStackRef.current.slice(-49), { type: "create_batch", gateIds: createdIds }];
                        redoStackRef.current = [];
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
                  if (gateTool === "interval" && drawingInterval) {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const localX = e.clientX - rect.left;
                    const m = plotScaledMargins(plotW, plotH);
                    const sx = rect.width / plotW;
                    const rLeft = m.ml * sx;
                    const rRight = m.mr * sx;
                    const rPlotW = Math.max(1e-6, rect.width - rLeft - rRight);
                    const x = Math.max(0, Math.min(1, (localX - rLeft) / rPlotW));
                    setDrawingInterval((d) => (d ? { ...d, endX: x } : null));
                    return;
                  }
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
                  if (gateTool === "interval" && drawingInterval && transformedRange) {
                    const nxMin = Math.min(drawingInterval.startX, drawingInterval.endX);
                    const nxMax = Math.max(drawingInterval.startX, drawingInterval.endX);
                    if (nxMax - nxMin > 0.01) {
                      // P-2: use viewRange so interval drawn while zoomed maps to correct data coords.
                      const r = viewRange ?? transformedRange;
                      const xMin_ = r.xMin + (r.xMax - r.xMin) * nxMin;
                      const xMax_ = r.xMin + (r.xMax - r.xMin) * nxMax;
                      setPendingInterval({ xMin: xMin_, xMax: xMax_, gateName: "" });
                    }
                    setDrawingInterval(null);
                    setDrawMode(false);
                    return;
                  }
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
                  if (gateTool === "ellipse" && drawingRect) {
                    const nxMin = Math.min(drawingRect.startX, drawingRect.endX);
                    const nxMax = Math.max(drawingRect.startX, drawingRect.endX);
                    const nyMin = Math.min(drawingRect.startY, drawingRect.endY);
                    const nyMax = Math.max(drawingRect.startY, drawingRect.endY);
                    if (nxMax - nxMin > 0.01 && nyMax - nyMin > 0.01) {
                      setPendingEllipse({
                        nCx: (nxMin + nxMax) / 2,
                        nCy: (nyMin + nyMax) / 2,
                        nRx: (nxMax - nxMin) / 2,
                        nRy: (nyMax - nyMin) / 2,
                        gateName: "",
                      });
                    }
                    setDrawingRect(null);
                    setDrawMode(false);
                  }
                }}
              />
            )}
            <svg
              ref={plotSvgRef}
              viewBox={`0 0 ${plotW} ${plotH}`}
              style={{
                display: "block",
                width: "100%",
                height: "100%",
                pointerEvents: drawMode ? "none" : "auto",
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
                style={{ pointerEvents: "none" }}
              />
              {transformedRange && xChannel && (
                <>
                  {/* P-2: use viewRange for 2D axes so ticks reflect the zoomed window. */}
                  <AxisTicks
                    axis="x"
                    min={(plotMode !== "histogram" ? viewRange?.xMin : undefined) ?? transformedRange.xMin}
                    max={(plotMode !== "histogram" ? viewRange?.xMax : undefined) ?? transformedRange.xMax}
                    transform={transformX}
                    pixelStart={ml}
                    pixelEnd={ml + plotAreaW}
                    axisPixel={mt + plotAreaH}
                    fill={plotTickFill}
                  />
                  {plotMode !== "histogram" && yChannel && (
                    <AxisTicks
                      axis="y"
                      min={viewRange?.yMin ?? transformedRange.yMin}
                      max={viewRange?.yMax ?? transformedRange.yMax}
                      transform={transformY}
                      pixelStart={0}
                      pixelEnd={plotAreaH}
                      axisPixel={ml}
                      plotTop={mt}
                      fill={plotTickFill}
                    />
                  )}
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
              {plotMode === "histogram" ? (
                <text
                  x={Math.max(10, ml - 8)}
                  y={plotH / 2}
                  textAnchor="end"
                  transform={`rotate(-90 ${Math.max(10, ml - 8)} ${plotH / 2})`}
                  fill={plotTickFill}
                  fontSize="0.85rem"
                >
                  Count
                </text>
              ) : yChannel ? (
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
              ) : null}
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
              {/* ── Gate overlays: rect + polygon shapes (scatter/density mode only).
                   Interval gates are rendered separately in histogram mode above. ── */}
              {plotMode !== "histogram" && (viewRange ?? transformedRange) && (() => {
                const GATE_COLORS = ["#22c55e","#3b82f6","#f59e0b","#ec4899","#8b5cf6","#06b6d4","#f97316","#a3e635"];
                // P-2: use viewRange (zoomed window) so gate shapes scale correctly when zoomed.
                const { xMin, xMax, yMin, yMax } = viewRange ?? transformedRange!;
                const spanX = xMax - xMin || 1;
                const spanY = yMax - yMin || 1;
                const nx = (v: number) => Math.max(0, Math.min(1, (v - xMin) / spanX));
                const ny = (v: number) => Math.max(0, Math.min(1, (v - yMin) / spanY));
                const toSvgX = (v: number) => ml + plotAreaW * nx(v);
                const toSvgY = (v: number) => mt + plotAreaH * (1 - ny(v));

                const startRectDrag = (e: React.MouseEvent, gateId: string, mode: DragState["mode"], origBounds: BoundsSnapshot) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const container = plotContainerRef.current;
                  if (!container) return;
                  const cRect = container.getBoundingClientRect();
                  dragRef.current = {
                    gateId, gateType: "rectangle", mode,
                    startClientX: e.clientX, startClientY: e.clientY,
                    origBounds,
                    containerWidth: cRect.width,
                    plotW, plotH, ml, mt, plotAreaW, plotAreaH,
                    xMin, xMax, yMin, yMax,
                  };
                };

                const startPolyDrag = (e: React.MouseEvent, gateId: string, origVertices: number[][], origBounds: BoundsSnapshot) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const container = plotContainerRef.current;
                  if (!container) return;
                  const cRect = container.getBoundingClientRect();
                  dragRef.current = {
                    gateId, gateType: "polygon", mode: "move",
                    startClientX: e.clientX, startClientY: e.clientY,
                    origBounds, origVertices,
                    containerWidth: cRect.width,
                    plotW, plotH, ml, mt, plotAreaW, plotAreaH,
                    xMin, xMax, yMin, yMax,
                  };
                };

                // ── O: density contour lines (marching squares) ──────────────────
                const contourPaths: React.ReactNode[] = [];
                if (showContours && density && plotMode === "density") {
                  // Smooth the grid with a box blur (3×3, 3 passes ≈ Gaussian)
                  const smoothGrid = (g: number[][], passes: number): number[][] => {
                    let src = g;
                    for (let p = 0; p < passes; p++) {
                      const nR = src.length;
                      const nC = src[0]?.length ?? 0;
                      const dst: number[][] = Array.from({ length: nR }, () => new Array(nC).fill(0) as number[]);
                      for (let r = 0; r < nR; r++) {
                        for (let c = 0; c < nC; c++) {
                          let sum = 0, cnt = 0;
                          for (let dr = -1; dr <= 1; dr++) {
                            for (let dc = -1; dc <= 1; dc++) {
                              const rr = r + dr, cc = c + dc;
                              if (rr >= 0 && rr < nR && cc >= 0 && cc < nC) {
                                sum += (src[rr]?.[cc] ?? 0); cnt++;
                              }
                            }
                          }
                          dst[r]![c] = sum / cnt;
                        }
                      }
                      src = dst;
                    }
                    return src;
                  };

                  // Marching squares lookup: edges 0=top,1=right,2=bottom,3=left
                  // Case bits: bit3=TL,bit2=TR,bit1=BR,bit0=BL (1=above level)
                  const MS_TABLE: [number, number][][] = [
                    [],               // 0
                    [[3, 2]],         // 1
                    [[2, 1]],         // 2
                    [[3, 1]],         // 3
                    [[0, 1]],         // 4
                    [[3, 0], [2, 1]], // 5 saddle
                    [[0, 2]],         // 6
                    [[0, 3]],         // 7
                    [[0, 3]],         // 8
                    [[0, 2]],         // 9
                    [[0, 1], [3, 2]], // 10 saddle
                    [[0, 1]],         // 11
                    [[3, 1]],         // 12
                    [[2, 1]],         // 13
                    [[3, 2]],         // 14
                    [],               // 15
                  ];

                  const contoursForLevel = (
                    grid: number[][], level: number,
                    gxMin: number, gxMax: number, gyMin: number, gyMax: number,
                  ): string => {
                    const nR = grid.length;
                    const nC = grid[0]?.length ?? 0;
                    if (nR < 2 || nC < 2) return "";
                    const dx = (gxMax - gxMin) / nC;
                    const dy = (gyMax - gyMin) / nR;
                    // grid[r][c]: r=0=yMin (bottom), r=nR-1=yMax (top)
                    // colX(c) = gxMin + c*dx, rowY(r) = gyMin + r*dy
                    const colX = (c: number) => gxMin + c * dx;
                    const rowY = (r: number) => gyMin + r * dy;
                    const edgePt = (edge: number, r: number, c: number,
                      tl: number, tr: number, br: number, bl: number): [number, number] => {
                      const interp = (a: number, b: number) =>
                        b === a ? 0.5 : Math.max(0, Math.min(1, (level - a) / (b - a)));
                      if (edge === 0) { // top: TL→TR, y=rowY(r+1)
                        const t = interp(tl, tr);
                        return [toSvgX(colX(c) + t * dx), toSvgY(rowY(r + 1))];
                      } else if (edge === 1) { // right: TR→BR, x=colX(c+1)
                        const t = interp(tr, br);
                        return [toSvgX(colX(c + 1)), toSvgY(rowY(r + 1) - t * dy)];
                      } else if (edge === 2) { // bottom: BL→BR, y=rowY(r)
                        const t = interp(bl, br);
                        return [toSvgX(colX(c) + t * dx), toSvgY(rowY(r))];
                      } else { // left: TL→BL, x=colX(c)
                        const t = interp(tl, bl);
                        return [toSvgX(colX(c)), toSvgY(rowY(r + 1) - t * dy)];
                      }
                    };
                    const segs: string[] = [];
                    for (let r = 0; r < nR - 1; r++) {
                      for (let c = 0; c < nC - 1; c++) {
                        // BL=grid[r][c], BR=grid[r][c+1], TL=grid[r+1][c], TR=grid[r+1][c+1]
                        const bl = grid[r]?.[c] ?? 0;
                        const br = grid[r]?.[c + 1] ?? 0;
                        const tl = grid[r + 1]?.[c] ?? 0;
                        const tr = grid[r + 1]?.[c + 1] ?? 0;
                        const caseIdx =
                          ((tl >= level ? 1 : 0) << 3) |
                          ((tr >= level ? 1 : 0) << 2) |
                          ((br >= level ? 1 : 0) << 1) |
                          ((bl >= level ? 1 : 0) << 0);
                        const msSegs = MS_TABLE[caseIdx];
                        if (!msSegs) continue;
                        for (const [e0, e1] of msSegs) {
                          const [x0, y0] = edgePt(e0, r, c, tl, tr, br, bl);
                          const [x1, y1] = edgePt(e1, r, c, tl, tr, br, bl);
                          segs.push(`M${x0.toFixed(1)},${y0.toFixed(1)}L${x1.toFixed(1)},${y1.toFixed(1)}`);
                        }
                      }
                    }
                    return segs.join(" ");
                  };

                  const smoothed = smoothGrid(density.counts, 3);
                  // Find max for level computation
                  let maxCount = 0;
                  for (const row of smoothed) for (const v of row) if (v > maxCount) maxCount = v;
                  if (maxCount > 0) {
                    const CONTOUR_LEVELS = [0.15, 0.30, 0.50, 0.70, 0.87];
                    const CONTOUR_OPACITIES = [0.35, 0.45, 0.55, 0.65, 0.75];
                    CONTOUR_LEVELS.forEach((frac, i) => {
                      const level = frac * maxCount;
                      const d = contoursForLevel(
                        smoothed, level,
                        density.xMin, density.xMax, density.yMin, density.yMax,
                      );
                      if (d) {
                        contourPaths.push(
                          <path
                            key={`contour-${i}`}
                            d={d}
                            fill="none"
                            stroke="white"
                            strokeWidth={0.9}
                            strokeOpacity={CONTOUR_OPACITIES[i]}
                            style={{ pointerEvents: "none" }}
                          />,
                        );
                      }
                    });
                  }
                }

                const gateSvgElements = visibleGates.map((g, idx) => {
                  const color = GATE_COLORS[idx % GATE_COLORS.length]!;
                  const fillAlpha = color + "18";
                  // Narrow previewGate to the correct variant for this gate
                  const pvRaw = previewGate?.id === g.id ? previewGate : null;
                  const pvRect = pvRaw?.kind === "rect" ? pvRaw : null;
                  const pvPoly = pvRaw?.kind === "poly" ? pvRaw : null;
                  // R-2: FlowJo-style dual percentage label (% parent / % total) when both differ
                  const pctParent = g.pct_of_parent ?? 0;
                  const pctTotal = g.pct_of_total ?? g.pct_total ?? 0;
                  const label = (g.parent_gate_id && Math.abs(pctParent - pctTotal) > 0.05)
                    ? `${g.name}  ${g.count.toLocaleString()} (${pctParent.toFixed(1)}%P / ${pctTotal.toFixed(1)}%T)`
                    : `${g.name}  ${g.count.toLocaleString()} (${pctParent.toFixed(1)}%)`;
                  const canDrag = !drawMode;

                  if (g.type === "rectangle" &&
                      g.x_min != null && g.y_min != null &&
                      g.x_max != null && g.y_max != null) {
                    const xMin_ = pvRect?.x_min ?? g.x_min;
                    const yMin_ = pvRect?.y_min ?? g.y_min;
                    const xMax_ = pvRect?.x_max ?? g.x_max;
                    const yMax_ = pvRect?.y_max ?? g.y_max;
                    const left = ml + plotAreaW * Math.min(nx(xMin_), nx(xMax_));
                    const top  = mt + plotAreaH * Math.min(1 - ny(yMin_), 1 - ny(yMax_));
                    const rW   = plotAreaW * Math.abs(nx(xMax_) - nx(xMin_));
                    const rH   = plotAreaH * Math.abs(ny(yMax_) - ny(yMin_));
                    const labelX = Math.max(ml + 2, Math.min(ml + plotAreaW - 4, left + 3));
                    const labelY = Math.max(mt + 10, top - 4);
                    const origBounds: BoundsSnapshot = { x_min: g.x_min, y_min: g.y_min, x_max: g.x_max, y_max: g.y_max };
                    const handles: Array<{ sx: number; sy: number; mode: DragState["mode"]; cursor: string }> = [
                      { sx: left,      sy: top,      mode: "resize-nw", cursor: "nw-resize" },
                      { sx: left + rW, sy: top,      mode: "resize-ne", cursor: "ne-resize" },
                      { sx: left,      sy: top + rH, mode: "resize-sw", cursor: "sw-resize" },
                      { sx: left + rW, sy: top + rH, mode: "resize-se", cursor: "se-resize" },
                    ];
                    return (
                      <g key={g.id}>
                        <rect x={left} y={top} width={rW} height={rH}
                          fill={fillAlpha} stroke={color} strokeWidth={1.4} strokeDasharray="5 2"
                          style={{ cursor: canDrag ? (pvRect ? "grabbing" : "grab") : "default", pointerEvents: canDrag ? "all" : "none" }}
                          onMouseDown={canDrag ? (e) => startRectDrag(e, g.id, "move", origBounds) : undefined}
                        />
                        <rect x={labelX - 2} y={labelY - 9} width={label.length * 5.6 + 6} height={12}
                          rx={3} fill="rgba(15,23,42,0.72)" style={{ pointerEvents: "none" }} />
                        <text x={labelX} y={labelY} fill={color} fontSize={9.5} fontWeight={600}
                          dominantBaseline="auto" style={{ userSelect: "none", pointerEvents: "none" }}>
                          {label}
                        </text>
                        {canDrag && handles.map((h) => (
                          <rect key={h.mode}
                            x={h.sx - 4} y={h.sy - 4} width={8} height={8}
                            rx={2} fill={color} stroke="white" strokeWidth={1}
                            style={{ cursor: h.cursor, pointerEvents: "all" }}
                            onMouseDown={(e) => startRectDrag(e, g.id, h.mode, origBounds)}
                          />
                        ))}
                      </g>
                    );
                  }

                  if (g.type === "ellipse" &&
                      g.center_x != null && g.center_y != null &&
                      g.radius_x != null && g.radius_y != null) {
                    const cxS = toSvgX(g.center_x);
                    const cyS = toSvgY(g.center_y);
                    const rxS = Math.abs(plotAreaW * (g.radius_x / spanX));
                    const ryS = Math.abs(plotAreaH * (g.radius_y / spanY));
                    const ang = g.angle ?? 0;
                    // Label above the ellipse top
                    const labelX = Math.max(ml + 2, Math.min(ml + plotAreaW - 4, cxS - label.length * 2.8));
                    const labelY = Math.max(mt + 10, cyS - ryS - 4);
                    return (
                      <g key={g.id}>
                        <ellipse
                          cx={cxS} cy={cyS} rx={rxS} ry={ryS}
                          transform={ang !== 0 ? `rotate(${ang}, ${cxS}, ${cyS})` : undefined}
                          fill={fillAlpha} stroke={color} strokeWidth={1.4} strokeDasharray="5 2"
                          style={{ cursor: "default", pointerEvents: "none" }}
                        />
                        <rect x={labelX - 2} y={labelY - 9} width={label.length * 5.6 + 6} height={12}
                          rx={3} fill="rgba(15,23,42,0.72)" style={{ pointerEvents: "none" }} />
                        <text x={labelX} y={labelY} fill={color} fontSize={9.5} fontWeight={600}
                          dominantBaseline="auto" style={{ userSelect: "none", pointerEvents: "none" }}>
                          {label}
                        </text>
                      </g>
                    );
                  }

                  if (g.type === "polygon" && g.vertices && g.vertices.length >= 3) {
                    // Use preview vertices if a drag is in progress, otherwise use stored vertices
                    const displayVerts = pvPoly?.vertices ?? g.vertices;
                    const svgPts = displayVerts.map(([xRaw, yRaw]) => `${toSvgX(xRaw ?? 0)},${toSvgY(yRaw ?? 0)}`);
                    const cx = displayVerts.reduce((s, v) => s + (v[0] ?? 0), 0) / displayVerts.length;
                    const cy = displayVerts.reduce((s, v) => s + (v[1] ?? 0), 0) / displayVerts.length;
                    const lx = Math.max(ml + 2, Math.min(ml + plotAreaW - 4, toSvgX(cx) - label.length * 2.8));
                    const ly = Math.max(mt + 10, toSvgY(cy));
                    // origBounds for poly: bounding box of vertices (used by undo, not for resize)
                    const vxs = g.vertices.map((v) => v[0] ?? 0);
                    const vys = g.vertices.map((v) => v[1] ?? 0);
                    const polyOrigBounds: BoundsSnapshot = {
                      x_min: Math.min(...vxs), y_min: Math.min(...vys),
                      x_max: Math.max(...vxs), y_max: Math.max(...vys),
                    };
                    return (
                      <g key={g.id}
                        style={{ cursor: canDrag ? (pvPoly ? "grabbing" : "grab") : "default", pointerEvents: canDrag ? "all" : "none" }}
                        onMouseDown={canDrag ? (e) => startPolyDrag(e, g.id, g.vertices!, polyOrigBounds) : undefined}
                      >
                        <polygon points={svgPts.join(" ")} fill={fillAlpha} stroke={color} strokeWidth={1.4} />
                        <rect x={lx - 2} y={ly - 9} width={label.length * 5.6 + 6} height={12}
                          rx={3} fill="rgba(15,23,42,0.72)" style={{ pointerEvents: "none" }} />
                        <text x={lx} y={ly} fill={color} fontSize={9.5} fontWeight={600}
                          dominantBaseline="auto" style={{ userSelect: "none", pointerEvents: "none" }}>
                          {label}
                        </text>
                      </g>
                    );
                  }

                  return null;
                });
                return <React.Fragment key="overlay">{contourPaths}{gateSvgElements}</React.Fragment>;
              })()}
              {/* ── Histogram bars (histogram mode only) ── */}
              {plotMode === "histogram" && histData && transformedRange && (() => {
                const { binEdges, counts } = histData;
                const maxCount = transformedRange.yMax || 1;
                const { xMin: rXMin, xMax: rXMax } = transformedRange;
                const spanX = rXMax - rXMin || 1;
                const barFill = plotBgMode === "white" ? "rgba(59,130,246,0.75)" : "rgba(96,165,250,0.8)";
                const barStroke = plotBgMode === "white" ? "#2563eb" : "#3b82f6";
                return counts.map((count, i) => {
                  const edge0 = binEdges[i] ?? rXMin;
                  const edge1 = binEdges[i + 1] ?? rXMax;
                  const x0 = ml + plotAreaW * Math.max(0, Math.min(1, (edge0 - rXMin) / spanX));
                  const x1 = ml + plotAreaW * Math.max(0, Math.min(1, (edge1 - rXMin) / spanX));
                  const barH = plotAreaH * (count / maxCount);
                  if (x1 <= x0 || barH <= 0) return null;
                  return (
                    <rect
                      key={i}
                      x={x0}
                      y={mt + plotAreaH - barH}
                      width={Math.max(0.5, x1 - x0 - 0.5)}
                      height={barH}
                      fill={barFill}
                      stroke={barStroke}
                      strokeWidth={0.3}
                      style={{ pointerEvents: "none" }}
                    />
                  );
                });
              })()}
              {/* ── M: Overlay histogram fills (per checked gate) ── */}
              {plotMode === "histogram" && transformedRange && histOverlayIds.length > 0 && (() => {
                const OVERLAY_COLORS = ["#f59e0b","#ec4899","#22c55e","#8b5cf6","#06b6d4","#f97316","#a3e635","#e879f9"];
                const { xMin: rXMin, xMax: rXMax, yMax: maxCount } = transformedRange;
                const spanX = rXMax - rXMin || 1;
                const effectiveMax = maxCount || 1;
                return histOverlayIds.map((gid, colorIdx) => {
                  const od = histOverlayData[gid];
                  if (!od) return null;
                  const color = OVERLAY_COLORS[colorIdx % OVERLAY_COLORS.length]!;
                  const overlayGate = gateList.find((g) => g.id === gid);
                  // Build a filled area polygon for the overlay histogram
                  const pts: string[] = [];
                  pts.push(`${ml + plotAreaW * Math.max(0, Math.min(1, ((od.binEdges[0] ?? rXMin) - rXMin) / spanX))},${mt + plotAreaH}`);
                  od.counts.forEach((cnt, i) => {
                    const e0 = od.binEdges[i] ?? rXMin;
                    const e1 = od.binEdges[i + 1] ?? rXMax;
                    const x0 = ml + plotAreaW * Math.max(0, Math.min(1, (e0 - rXMin) / spanX));
                    const x1 = ml + plotAreaW * Math.max(0, Math.min(1, (e1 - rXMin) / spanX));
                    const y0 = mt + plotAreaH - plotAreaH * (cnt / effectiveMax);
                    pts.push(`${x0},${y0}`);
                    pts.push(`${x1},${y0}`);
                  });
                  const lastEdge = od.binEdges[od.counts.length] ?? rXMax;
                  pts.push(`${ml + plotAreaW * Math.max(0, Math.min(1, (lastEdge - rXMin) / spanX))},${mt + plotAreaH}`);
                  const labelText = overlayGate ? `${overlayGate.name} (${overlayGate.count.toLocaleString()})` : gid;
                  const labelX = ml + 6 + colorIdx * 90;
                  return (
                    <g key={gid} style={{ pointerEvents: "none" }}>
                      <polyline
                        points={pts.join(" ")}
                        fill={color + "30"}
                        stroke={color}
                        strokeWidth={1.2}
                        style={{ pointerEvents: "none" }}
                      />
                      {/* Tiny legend chip at top of plot area */}
                      <rect x={labelX} y={mt + 3} width={labelText.length * 5.2 + 6} height={11} rx={3}
                        fill="rgba(15,23,42,0.75)" style={{ pointerEvents: "none" }} />
                      <circle cx={labelX + 5} cy={mt + 8.5} r={3} fill={color} style={{ pointerEvents: "none" }} />
                      <text x={labelX + 11} y={mt + 11.5} fill={color} fontSize={8.5} fontWeight={600}
                        dominantBaseline="auto" style={{ userSelect: "none", pointerEvents: "none" }}>
                        {labelText}
                      </text>
                    </g>
                  );
                });
              })()}
              {/* ── Interval gate overlays (histogram mode) ── */}
              {plotMode === "histogram" && transformedRange && (() => {
                const GATE_COLORS = ["#22c55e","#3b82f6","#f59e0b","#ec4899","#8b5cf6","#06b6d4","#f97316","#a3e635"];
                const { xMin: rXMin, xMax: rXMax } = transformedRange;
                const spanX = rXMax - rXMin || 1;
                const toX = (v: number) => ml + plotAreaW * Math.max(0, Math.min(1, (v - rXMin) / spanX));
                // Show interval gates matching x_channel and parent
                const intervalGates = gateList.filter(
                  (g) => g.type === "interval" && g.x_channel === xChannel && g.parent_gate_id === activeGateId,
                );
                return intervalGates.map((g, idx) => {
                  if (g.x_min == null || g.x_max == null) return null;
                  const color = GATE_COLORS[idx % GATE_COLORS.length]!;
                  const svgX0 = toX(g.x_min);
                  const svgX1 = toX(g.x_max);
                  const bw = Math.max(1, svgX1 - svgX0);
                  const pct = g.pct_of_parent ?? g.pct_of_total ?? 0;
                  const label = `${g.name} ${g.count.toLocaleString()} (${pct.toFixed(1)}%)`;
                  return (
                    <g key={g.id} style={{ pointerEvents: "none" }}>
                      <rect x={svgX0} y={mt} width={bw} height={plotAreaH}
                        fill={color + "28"} stroke={color} strokeWidth={1.4} strokeDasharray="5 2" />
                      <rect x={svgX0 + 2} y={mt + 4} width={label.length * 5.4 + 6} height={12} rx={3}
                        fill="rgba(15,23,42,0.75)" />
                      <text x={svgX0 + 5} y={mt + 13} fill={color} fontSize={9.5} fontWeight={600}
                        dominantBaseline="auto" style={{ userSelect: "none" }}>
                        {label}
                      </text>
                    </g>
                  );
                });
              })()}
              {/* ── Interval drawing preview ── */}
              {drawingInterval && transformedRange && (
                <rect
                  x={ml + plotAreaW * Math.min(drawingInterval.startX, drawingInterval.endX)}
                  y={mt}
                  width={plotAreaW * Math.abs(drawingInterval.endX - drawingInterval.startX)}
                  height={plotAreaH}
                  fill="rgba(74,222,128,0.15)"
                  stroke="#4ade80"
                  strokeWidth={1.5}
                  style={{ pointerEvents: "none" }}
                />
              )}
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
              {drawingRect && (() => {
                const dLeft = ml + plotAreaW * Math.min(drawingRect.startX, drawingRect.endX);
                const dTop  = mt + plotAreaH * (1 - Math.max(drawingRect.startY, drawingRect.endY));
                const dW    = plotAreaW * Math.abs(drawingRect.endX - drawingRect.startX);
                const dH    = plotAreaH * Math.abs(drawingRect.endY - drawingRect.startY);
                if (gateTool === "ellipse") {
                  return (
                    <ellipse
                      cx={dLeft + dW / 2} cy={dTop + dH / 2}
                      rx={Math.max(0, dW / 2)} ry={Math.max(0, dH / 2)}
                      fill="rgba(74,222,128,0.15)" stroke="#4ade80" strokeWidth={1.5}
                    />
                  );
                }
                return (
                  <rect x={dLeft} y={dTop} width={dW} height={dH}
                    fill="rgba(74,222,128,0.15)" stroke="#4ade80" strokeWidth={1.5} />
                );
              })()}
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
          {/* N: Plot PNG export button */}
          {file && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.3rem" }}>
              <button
                type="button"
                title="Export plot as PNG"
                onClick={async () => {
                  const svgEl = plotSvgRef.current;
                  if (!svgEl) return;
                  const container = svgEl.parentElement?.parentElement;
                  const w = svgEl.clientWidth || 800;
                  const h = svgEl.clientHeight || 600;
                  const offscreen = document.createElement("canvas");
                  offscreen.width = w * 2;
                  offscreen.height = h * 2;
                  const ctx = offscreen.getContext("2d");
                  if (!ctx) return;
                  ctx.scale(2, 2);
                  // Background
                  ctx.fillStyle = plotBgMode === "white" ? "#ffffff" : "#0f172a";
                  ctx.fillRect(0, 0, w, h);
                  // Composite canvas layers (density / scatter)
                  if (container) {
                    const svgRect = svgEl.getBoundingClientRect();
                    container.querySelectorAll("canvas").forEach((c) => {
                      const cr = c.getBoundingClientRect();
                      ctx.drawImage(c, cr.left - svgRect.left, cr.top - svgRect.top, cr.width, cr.height);
                    });
                  }
                  // Draw SVG on top
                  const svgStr = new XMLSerializer().serializeToString(svgEl);
                  const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
                  const svgUrl = URL.createObjectURL(blob);
                  await new Promise<void>((resolve) => {
                    const img = new Image();
                    img.onload = () => { ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(svgUrl); resolve(); };
                    img.onerror = () => { URL.revokeObjectURL(svgUrl); resolve(); };
                    img.src = svgUrl;
                  });
                  offscreen.toBlob((b) => {
                    if (!b) return;
                    const url = URL.createObjectURL(b);
                    const a = document.createElement("a");
                    a.href = url;
                    const fname = file?.sample_name ?? "plot";
                    a.download = `freecyto_${fname.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }, "image/png");
                }}
                style={{
                  padding: "0.2rem 0.55rem",
                  borderRadius: "0.35rem",
                  border: "1px solid rgba(148,163,184,0.4)",
                  background: "transparent",
                  color: "#94a3b8",
                  fontSize: "0.72rem",
                  cursor: "pointer",
                }}
              >
                📷 PNG
              </button>
            </div>
          )}

          {/* M: Histogram overlay panel — visible only in histogram mode */}
          {file && plotMode === "histogram" && (
            <div
              style={{
                marginTop: "0.5rem",
                padding: "0.45rem 0.6rem",
                borderRadius: "0.65rem",
                background: "rgba(15,23,42,0.55)",
                border: "1px solid rgba(245,158,11,0.3)",
                fontSize: "0.75rem",
                color: "#9ca3af",
              }}
            >
              <div style={{ fontWeight: 600, color: "#fcd34d", marginBottom: "0.3rem", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Overlay populations
              </div>
              {gateList.length === 0 ? (
                <span style={{ color: "#4b5563", fontStyle: "italic" }}>No gates yet — draw gates to compare their distributions.</span>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                  {gateList.map((g) => {
                    const checked = histOverlayIds.includes(g.id);
                    return (
                      <label
                        key={g.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.25rem",
                          cursor: "pointer",
                          padding: "0.15rem 0.4rem",
                          borderRadius: "999px",
                          border: checked ? "1px solid rgba(245,158,11,0.8)" : "1px solid rgba(148,163,184,0.3)",
                          background: checked ? "rgba(245,158,11,0.12)" : "transparent",
                          fontSize: "0.72rem",
                          color: checked ? "#fcd34d" : "#9ca3af",
                          transition: "all 0.1s",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={async (e) => {
                            if (e.target.checked) {
                              setHistOverlayIds((prev) => [...prev, g.id]);
                              // Fetch histogram for this gate population
                              if (!file) return;
                              try {
                                type HistResp = { bin_edges: number[]; counts: number[]; x_min: number; x_max: number };
                                const params = new URLSearchParams({
                                  channel: xChannel,
                                  transform: transformX,
                                  bins: "256",
                                  gate_id: g.id,
                                });
                                const resp = await getJson<HistResp>(
                                  `${API_BASE}/api/files/${encodeURIComponent(file.id)}/histogram?${params}`,
                                );
                                setHistOverlayData((prev) => ({
                                  ...prev,
                                  [g.id]: {
                                    binEdges: resp.bin_edges,
                                    counts: resp.counts,
                                    xMin: resp.x_min,
                                    xMax: resp.x_max,
                                  },
                                }));
                              } catch { /* non-fatal */ }
                            } else {
                              setHistOverlayIds((prev) => prev.filter((id) => id !== g.id));
                              setHistOverlayData((prev) => {
                                const next = { ...prev };
                                delete next[g.id];
                                return next;
                              });
                            }
                          }}
                          style={{ accentColor: "#f59e0b", width: 11, height: 11 }}
                        />
                        <span>{g.name}</span>
                        {checked && (
                          <span style={{ color: "#6b7280", fontSize: "0.65rem" }}>
                            {g.count.toLocaleString()}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
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
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.4rem",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.75rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "#9ca3af",
                    }}
                  >
                    Gate Hierarchy
                  </div>
                  {/* Q-1: Apply gates to other samples button */}
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    {/* Q-4: Compensation button */}
                    {file && (
                      <button
                        type="button"
                        onClick={() => setCompensationModalOpen(true)}
                        title="View compensation matrix"
                        style={{
                          padding: "0.2rem 0.5rem",
                          borderRadius: "0.3rem",
                          border: "1px solid rgba(168,85,247,0.4)",
                          fontSize: "0.68rem",
                          cursor: "pointer",
                          background: "rgba(168,85,247,0.1)",
                          color: "#d8b4fe",
                          whiteSpace: "nowrap",
                        }}
                      >
                        🔬 Comp
                      </button>
                    )}
                    {/* Q-3: Save layout button */}
                    {gateTree.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setSaveLayoutName("");
                          setSaveLayoutModalOpen(true);
                        }}
                        title="Save current gate layout as template"
                        style={{
                          padding: "0.2rem 0.5rem",
                          borderRadius: "0.3rem",
                          border: "1px solid rgba(34,197,94,0.4)",
                          fontSize: "0.68rem",
                          cursor: "pointer",
                          background: "rgba(34,197,94,0.1)",
                          color: "#86efac",
                          whiteSpace: "nowrap",
                        }}
                      >
                        💾 Save
                      </button>
                    )}
                    {/* Q-3: Load layout dropdown */}
                    {savedLayouts.length > 0 && (
                      <select
                        disabled={loadLayoutLoading}
                        onChange={async (e) => {
                          if (!e.target.value || !file) return;
                          setLoadLayoutLoading(true);
                          try {
                            const res = await fetch(
                              `${API_BASE}/api/layouts/${encodeURIComponent(e.target.value)}/apply?target_file_id=${encodeURIComponent(file.id)}`,
                              { method: "POST" },
                            );
                            if (!res.ok) throw new Error(`HTTP ${res.status}`);
                            const result = await res.json();
                            setGateMessage(`✓ Applied ${result.gates_applied} gates from "${result.layout_name}"`);
                            await fetchGateTree(file.id);
                          } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            setGateMessage(`Error applying layout: ${msg}`);
                          } finally {
                            setLoadLayoutLoading(false);
                            e.target.value = "";
                          }
                        }}
                        style={{
                          padding: "0.2rem 0.4rem",
                          borderRadius: "0.3rem",
                          border: "1px solid rgba(96,165,250,0.4)",
                          fontSize: "0.68rem",
                          cursor: "pointer",
                          background: "rgba(96,165,250,0.1)",
                          color: "#60a5fa",
                          opacity: loadLayoutLoading ? 0.6 : 1,
                        }}
                      >
                        <option value="">📥 Load layout...</option>
                        {savedLayouts.map((layout) => (
                          <option key={layout.id} value={layout.id}>
                            {layout.name} ({layout.gate_count} gates)
                          </option>
                        ))}
                      </select>
                    )}
                    {/* S-4: Delete layout button */}
                    {savedLayouts.length > 0 && (
                      <select
                        onChange={async (e) => {
                          if (!e.target.value) return;
                          const layoutId = e.target.value;
                          const layout = savedLayouts.find((l) => l.id === layoutId);
                          if (!layout) return;
                          if (!window.confirm(`Delete layout "${layout.name}"?`)) { e.target.value = ""; return; }
                          try {
                            const res = await fetch(`${API_BASE}/api/layouts/${encodeURIComponent(layoutId)}`, { method: "DELETE" });
                            if (!res.ok) throw new Error(`HTTP ${res.status}`);
                            const updated = await fetch(`${API_BASE}/api/layouts`).then((r) => r.json());
                            setSavedLayouts(updated);
                            setGateMessage("✓ Layout deleted");
                          } catch (err) {
                            setGateMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
                          }
                          e.target.value = "";
                        }}
                        style={{
                          padding: "0.2rem 0.4rem",
                          borderRadius: "0.3rem",
                          border: "1px solid rgba(239,68,68,0.35)",
                          fontSize: "0.68rem",
                          cursor: "pointer",
                          background: "rgba(239,68,68,0.08)",
                          color: "#fca5a5",
                        }}
                      >
                        <option value="">🗑 Delete...</option>
                        {savedLayouts.map((layout) => (
                          <option key={layout.id} value={layout.id}>
                            {layout.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {gateTree.length > 0 && allFiles.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          setApplyGatesTargets(new Set());
                          setApplyGatesModalOpen(true);
                          setApplyGatesMessage("");
                        }}
                        title="Apply current gate layout to other samples"
                        style={{
                          padding: "0.2rem 0.5rem",
                          borderRadius: "0.3rem",
                          border: "1px solid rgba(147,51,234,0.4)",
                          fontSize: "0.68rem",
                          cursor: "pointer",
                          background: "rgba(147,51,234,0.1)",
                          color: "#c084fc",
                          whiteSpace: "nowrap",
                        }}
                      >
                        ⤵ Apply
                      </button>
                    )}
                  </div>
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
                  onRenameGate={handleRenameGate}
                />

                {/* Q-1: Apply gates modal */}
                {applyGatesModalOpen && (
                  <div
                    style={{
                      position: "fixed",
                      inset: 0,
                      background: "rgba(0,0,0,0.5)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      zIndex: 9999,
                      backdropFilter: "blur(2px)",
                    }}
                    onClick={() => !applyGatesLoading && setApplyGatesModalOpen(false)}
                  >
                    <div
                      style={{
                        background: "#0f172a",
                        border: "1px solid rgba(148,163,184,0.3)",
                        borderRadius: "0.5rem",
                        padding: "clamp(1rem, 3vw, 1.5rem)",
                        maxWidth: "clamp(260px, 90vw, 450px)",
                        maxHeight: "min(90vh, 700px)",
                        overflowY: "auto",
                        boxShadow: "0 20px 25px rgba(0,0,0,0.5)",
                        width: "100%",
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div
                        style={{
                          fontSize: "0.9rem",
                          fontWeight: 600,
                          color: "#e5e7eb",
                          marginBottom: "1rem",
                        }}
                      >
                        Apply gates to other samples
                      </div>

                      <div style={{ marginBottom: "1rem", fontSize: "0.8rem", color: "#9ca3af" }}>
                        Select samples to receive the current gate layout ({gateTree.length} gates):
                      </div>

                      <div style={{ marginBottom: "1rem", maxHeight: "300px", overflowY: "auto" }}>
                        {allFiles.filter((f) => f.id !== file?.id).map((f) => (
                          <label
                            key={f.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                              padding: "0.5rem 0.4rem",
                              cursor: "pointer",
                              fontSize: "0.8rem",
                              color: "#cbd5e1",
                              borderRadius: "0.3rem",
                              background: applyGatesTargets.has(f.id) ? "rgba(147,51,234,0.15)" : "transparent",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={applyGatesTargets.has(f.id)}
                              onChange={(e) => {
                                const newTargets = new Set(applyGatesTargets);
                                if (e.target.checked) {
                                  newTargets.add(f.id);
                                } else {
                                  newTargets.delete(f.id);
                                }
                                setApplyGatesTargets(newTargets);
                              }}
                              style={{ cursor: "pointer" }}
                            />
                            <div>
                              <div style={{ fontWeight: 500 }}>{f.sample_name}</div>
                              <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>
                                {f.event_count.toLocaleString()} events
                              </div>
                            </div>
                          </label>
                        ))}
                      </div>

                      {applyGatesMessage && (
                        <div
                          style={{
                            marginBottom: "1rem",
                            padding: "0.5rem 0.4rem",
                            borderRadius: "0.3rem",
                            fontSize: "0.75rem",
                            backgroundColor: applyGatesMessage.includes("Error") ? "rgba(239,68,68,0.1)" : "rgba(34,197,94,0.1)",
                            color: applyGatesMessage.includes("Error") ? "#fca5a5" : "#86efac",
                          }}
                        >
                          {applyGatesMessage}
                        </div>
                      )}

                      <div
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          justifyContent: "flex-end",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setApplyGatesModalOpen(false)}
                          disabled={applyGatesLoading}
                          style={{
                            padding: "0.4rem 0.8rem",
                            borderRadius: "0.3rem",
                            border: "1px solid rgba(148,163,184,0.3)",
                            background: "transparent",
                            color: "#94a3b8",
                            fontSize: "0.8rem",
                            cursor: "pointer",
                            opacity: applyGatesLoading ? 0.5 : 1,
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (applyGatesTargets.size === 0) {
                              setApplyGatesMessage("Select at least one sample");
                              return;
                            }
                            setApplyGatesLoading(true);
                            setApplyGatesMessage("");
                            try {
                              const targetIds = Array.from(applyGatesTargets);
                              const params = new URLSearchParams({
                                source_file_id: file!.id,
                              });
                              targetIds.forEach((id) => params.append("target_file_ids", id));
                              const res = await fetch(`${API_BASE}/api/gates/copy?${params}`, {
                                method: "POST",
                              });
                              if (!res.ok) {
                                const text = await res.text();
                                throw new Error(text || `HTTP ${res.status}`);
                              }
                              const result = await res.json();
                              setApplyGatesMessage(
                                `✓ Applied ${result.total_gates_copied} gates to ${targetIds.length} sample${targetIds.length === 1 ? "" : "s"}`,
                              );
                              setTimeout(() => setApplyGatesModalOpen(false), 2000);
                            } catch (err) {
                              const message = err instanceof Error ? err.message : String(err);
                              setApplyGatesMessage(`Error: ${message}`);
                            } finally {
                              setApplyGatesLoading(false);
                            }
                          }}
                          disabled={applyGatesTargets.size === 0 || applyGatesLoading}
                          style={{
                            padding: "0.4rem 0.8rem",
                            borderRadius: "0.3rem",
                            border: "1px solid rgba(147,51,234,0.5)",
                            background: "rgba(147,51,234,0.2)",
                            color: "#c084fc",
                            fontSize: "0.8rem",
                            cursor: applyGatesTargets.size === 0 || applyGatesLoading ? "not-allowed" : "pointer",
                            opacity: applyGatesTargets.size === 0 || applyGatesLoading ? 0.5 : 1,
                          }}
                        >
                          {applyGatesLoading ? "Applying..." : "Apply"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Q-3: Save layout modal */}
                {saveLayoutModalOpen && (
                  <div
                    style={{
                      position: "fixed",
                      inset: 0,
                      background: "rgba(0,0,0,0.5)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      zIndex: 9999,
                      backdropFilter: "blur(2px)",
                    }}
                    onClick={() => !saveLayoutLoading && setSaveLayoutModalOpen(false)}
                  >
                    <div
                      style={{
                        background: "#0f172a",
                        border: "1px solid rgba(148,163,184,0.3)",
                        borderRadius: "0.5rem",
                        padding: "clamp(1rem, 3vw, 1.5rem)",
                        maxWidth: "clamp(250px, 90vw, 420px)",
                        boxShadow: "0 20px 25px rgba(0,0,0,0.5)",
                        width: "100%",
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div
                        style={{
                          fontSize: "0.9rem",
                          fontWeight: 600,
                          color: "#e5e7eb",
                          marginBottom: "1rem",
                        }}
                      >
                        Save gate layout as template
                      </div>

                      <input
                        type="text"
                        placeholder="Layout name (e.g., 'Lymphocyte gating')"
                        value={saveLayoutName}
                        onChange={(e) => setSaveLayoutName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && saveLayoutName.trim()) {
                            void (async () => {
                              setSaveLayoutLoading(true);
                              try {
                                const res = await fetch(`${API_BASE}/api/layouts`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    name: saveLayoutName,
                                    source_file_id: file!.id,
                                  }),
                                });
                                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                                const layout = await res.json();
                                // Refresh layouts list
                                const list = await fetch(`${API_BASE}/api/layouts`).then((r) => r.json());
                                setSavedLayouts(list);
                                setSaveLayoutModalOpen(false);
                                setGateMessage(`✓ Saved layout "${layout.name}"`);
                              } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                setGateMessage(`Error saving layout: ${msg}`);
                              } finally {
                                setSaveLayoutLoading(false);
                              }
                            })();
                          }
                        }}
                        style={{
                          width: "100%",
                          padding: "0.5rem 0.6rem",
                          borderRadius: "0.3rem",
                          border: "1px solid rgba(148,163,184,0.3)",
                          background: "rgba(30,41,59,0.8)",
                          color: "#e5e7eb",
                          fontSize: "0.85rem",
                          marginBottom: "1rem",
                          boxSizing: "border-box",
                        }}
                        disabled={saveLayoutLoading}
                        autoFocus
                      />

                      <div
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          justifyContent: "flex-end",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setSaveLayoutModalOpen(false)}
                          disabled={saveLayoutLoading}
                          style={{
                            padding: "0.4rem 0.8rem",
                            borderRadius: "0.3rem",
                            border: "1px solid rgba(148,163,184,0.3)",
                            background: "transparent",
                            color: "#94a3b8",
                            fontSize: "0.8rem",
                            cursor: "pointer",
                            opacity: saveLayoutLoading ? 0.5 : 1,
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!saveLayoutName.trim()) return;
                            setSaveLayoutLoading(true);
                            try {
                              const res = await fetch(`${API_BASE}/api/layouts`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  name: saveLayoutName,
                                  source_file_id: file!.id,
                                }),
                              });
                              if (!res.ok) throw new Error(`HTTP ${res.status}`);
                              const layout = await res.json();
                              // Refresh layouts list
                              const list = await fetch(`${API_BASE}/api/layouts`).then((r) => r.json());
                              setSavedLayouts(list);
                              setSaveLayoutModalOpen(false);
                              setGateMessage(`✓ Saved layout "${layout.name}"`);
                            } catch (err) {
                              const msg = err instanceof Error ? err.message : String(err);
                              setGateMessage(`Error saving layout: ${msg}`);
                            } finally {
                              setSaveLayoutLoading(false);
                            }
                          }}
                          disabled={!saveLayoutName.trim() || saveLayoutLoading}
                          style={{
                            padding: "0.4rem 0.8rem",
                            borderRadius: "0.3rem",
                            border: "1px solid rgba(34,197,94,0.5)",
                            background: "rgba(34,197,94,0.2)",
                            color: "#86efac",
                            fontSize: "0.8rem",
                            cursor: !saveLayoutName.trim() || saveLayoutLoading ? "not-allowed" : "pointer",
                            opacity: !saveLayoutName.trim() || saveLayoutLoading ? 0.5 : 1,
                          }}
                        >
                          {saveLayoutLoading ? "Saving..." : "Save"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* G: Statistics Panel */}
          {file && (
            <div
              style={{
                marginTop: "1rem",
                borderRadius: "0.75rem",
                border: "1px solid rgba(148,163,184,0.3)",
                background: "rgba(15,23,42,0.5)",
                overflow: "hidden",
              }}
            >
              {/* Panel header / toggle */}
              <button
                type="button"
                onClick={() => {
                  const next = !statsExpanded;
                  setStatsExpanded(next);
                  // Eagerly fetch if opening with a gate selected
                  if (next && activeGateId && !gateStats) {
                    setGateStatsLoading(true);
                    void getJson<GateStatsData>(`${API_BASE}/api/gates/${encodeURIComponent(activeGateId)}/stats`)
                      .then((d) => { setGateStats(d); setGateStatsLoading(false); })
                      .catch(() => { setGateStats(null); setGateStatsLoading(false); });
                  }
                }}
                style={{
                  display: "flex",
                  width: "100%",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.5rem 0.85rem",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "#e5e7eb",
                  fontSize: "0.78rem",
                  textAlign: "left",
                }}
              >
                <span style={{ textTransform: "uppercase", letterSpacing: "0.08em", color: "#9ca3af", fontWeight: 600 }}>
                  Statistics
                  {activeGateId && gateStats && (
                    <span style={{ marginLeft: "0.5rem", color: "#64748b", fontWeight: 400, textTransform: "none" }}>
                      — {gateStats.gate_name} ({gateStats.count.toLocaleString()} events, {gateStats.pct_of_parent.toFixed(1)}% of parent)
                    </span>
                  )}
                </span>
                <span style={{ color: "#64748b", fontSize: "0.8rem" }}>{statsExpanded ? "▲" : "▼"}</span>
              </button>

              {statsExpanded && (
                <div style={{ padding: "0 0.85rem 0.75rem" }}>
                  {!activeGateId && (
                    <div style={{ fontSize: "0.8rem", color: "#64748b", paddingBottom: "0.5rem" }}>
                      Select a gate to view per-channel statistics.
                    </div>
                  )}
                  {activeGateId && gateStatsLoading && (
                    <div style={{ fontSize: "0.8rem", color: "#64748b" }}>Loading statistics…</div>
                  )}
                  {activeGateId && !gateStatsLoading && gateStats && (
                    <>
                      {/* CSV export */}
                      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.4rem" }}>
                        <button
                          type="button"
                          onClick={() => {
                            const rows = [
                              ["Gate", gateStats.gate_name],
                              ["Count", String(gateStats.count)],
                              ["% of Parent", gateStats.pct_of_parent.toFixed(2)],
                              ["% of Total", gateStats.pct_total.toFixed(2)],
                              [],
                              ["Channel", "MFI (mean)", "Median", "SD", "CV%"],
                              ...gateStats.channel_stats.map((cs) => [
                                cs.display_name || cs.channel_name,
                                cs.mean.toFixed(2),
                                cs.median.toFixed(2),
                                cs.sd.toFixed(2),
                                cs.cv != null ? cs.cv.toFixed(2) : "",
                              ]),
                            ];
                            const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
                            const blob = new Blob([csv], { type: "text/csv" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${gateStats.gate_name.replace(/[^a-z0-9_-]/gi, "_")}_stats.csv`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                          style={{
                            padding: "0.2rem 0.55rem",
                            borderRadius: "0.4rem",
                            border: "1px solid rgba(148,163,184,0.5)",
                            fontSize: "0.75rem",
                            cursor: "pointer",
                            background: "rgba(30,41,59,0.6)",
                            color: "#94a3b8",
                          }}
                        >
                          Export CSV
                        </button>
                        {/* P-1: Export gated events as CSV */}
                        {activeGateId && (
                          <a
                            href={`${API_BASE}/api/gates/${encodeURIComponent(activeGateId)}/export-csv`}
                            download
                            title={gateStats ? `Download ${gateStats.count.toLocaleString()} events as CSV` : "Download events as CSV"}
                            style={{
                              padding: "0.2rem 0.55rem",
                              borderRadius: "0.4rem",
                              border: "1px solid rgba(96,165,250,0.45)",
                              fontSize: "0.75rem",
                              cursor: "pointer",
                              background: "rgba(96,165,250,0.1)",
                              color: "#60a5fa",
                              textDecoration: "none",
                              whiteSpace: "nowrap",
                            }}
                          >
                            ↓ Events CSV{gateStats ? ` (${gateStats.count.toLocaleString()})` : ""}
                          </a>
                        )}
                        {/* M: Export gated events as FCS */}
                        {activeGateId && (
                          <a
                            href={`${API_BASE}/api/gates/${encodeURIComponent(activeGateId)}/export-fcs`}
                            download
                            style={{
                              padding: "0.2rem 0.55rem",
                              borderRadius: "0.4rem",
                              border: "1px solid rgba(34,197,94,0.45)",
                              fontSize: "0.75rem",
                              cursor: "pointer",
                              background: "rgba(34,197,94,0.1)",
                              color: "#4ade80",
                              textDecoration: "none",
                              whiteSpace: "nowrap",
                            }}
                          >
                            ↓ Export FCS
                          </a>
                        )}
                      </div>
                      {/* P-3: Stats table — sortable columns + clipboard copy */}
                      {(() => {
                        // Sort channel_stats by the active column
                        const colKey: StatsSortCol = statsSortCol;
                        const sorted = [...gateStats.channel_stats].sort((a, b) => {
                          let va: number | string;
                          let vb: number | string;
                          if (colKey === "channel") {
                            va = (a.display_name || a.channel_name).toLowerCase();
                            vb = (b.display_name || b.channel_name).toLowerCase();
                          } else if (colKey === "mean") { va = a.mean; vb = b.mean; }
                          else if (colKey === "median") { va = a.median; vb = b.median; }
                          else if (colKey === "sd") { va = a.sd; vb = b.sd; }
                          else { va = a.cv ?? -Infinity; vb = b.cv ?? -Infinity; }
                          const cmp = va < vb ? -1 : va > vb ? 1 : 0;
                          return statsSortDir === "asc" ? cmp : -cmp;
                        });

                        const handleHeaderClick = (col: StatsSortCol) => {
                          if (statsSortCol === col) {
                            setStatsSortDir((d) => (d === "asc" ? "desc" : "asc"));
                          } else {
                            setStatsSortCol(col);
                            setStatsSortDir(col === "channel" ? "asc" : "desc");
                          }
                        };

                        const sortIcon = (col: StatsSortCol) =>
                          statsSortCol === col ? (statsSortDir === "asc" ? " ▲" : " ▼") : "";

                        const headers: { label: string; col: StatsSortCol; align: "left" | "right" }[] = [
                          { label: "Channel", col: "channel", align: "left" },
                          { label: "MFI", col: "mean", align: "right" },
                          { label: "Median", col: "median", align: "right" },
                          { label: "SD", col: "sd", align: "right" },
                          { label: "CV%", col: "cv", align: "right" },
                        ];

                        const handleCopy = () => {
                          const headerRow = headers.map((h) => h.label).join("\t");
                          const dataRows = sorted.map((cs) =>
                            [
                              cs.display_name || cs.channel_name,
                              cs.mean.toFixed(2),
                              cs.median.toFixed(2),
                              cs.sd.toFixed(2),
                              cs.cv != null ? cs.cv.toFixed(2) : "",
                            ].join("\t"),
                          );
                          void navigator.clipboard.writeText([headerRow, ...dataRows].join("\n"));
                        };

                        return (
                          <>
                            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.25rem" }}>
                              <button
                                type="button"
                                onClick={handleCopy}
                                title="Copy table to clipboard (tab-separated)"
                                style={{
                                  padding: "0.15rem 0.45rem",
                                  borderRadius: "0.35rem",
                                  border: "1px solid rgba(148,163,184,0.35)",
                                  background: "transparent",
                                  color: "#94a3b8",
                                  fontSize: "0.72rem",
                                  cursor: "pointer",
                                }}
                              >
                                📋 Copy
                              </button>
                            </div>
                            <div style={{ overflowX: "auto" }}>
                              <table
                                style={{
                                  width: "100%",
                                  borderCollapse: "collapse",
                                  fontSize: "0.75rem",
                                  color: "#e5e7eb",
                                }}
                              >
                                <thead>
                                  <tr style={{ borderBottom: "1px solid rgba(148,163,184,0.3)" }}>
                                    {headers.map(({ label, col, align }) => (
                                      <th
                                        key={col}
                                        onClick={() => handleHeaderClick(col)}
                                        style={{
                                          padding: "0.25rem 0.4rem",
                                          textAlign: align,
                                          color: statsSortCol === col ? "#c4b5fd" : "#9ca3af",
                                          fontWeight: statsSortCol === col ? 600 : 500,
                                          whiteSpace: "nowrap",
                                          cursor: "pointer",
                                          userSelect: "none",
                                        }}
                                      >
                                        {label}{sortIcon(col)}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {sorted.map((cs, i) => (
                                    <tr
                                      key={cs.channel_name}
                                      style={{
                                        background: i % 2 === 0 ? "transparent" : "rgba(148,163,184,0.04)",
                                      }}
                                    >
                                      <td
                                        style={{
                                          padding: "0.2rem 0.4rem",
                                          color: "#cbd5e1",
                                          maxWidth: "12rem",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                        }}
                                        title={cs.display_name || cs.channel_name}
                                      >
                                        {cs.display_name || cs.channel_name}
                                      </td>
                                      <td style={{ padding: "0.2rem 0.4rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                        {cs.mean.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                                      </td>
                                      <td style={{ padding: "0.2rem 0.4rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                        {cs.median.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                                      </td>
                                      <td style={{ padding: "0.2rem 0.4rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                        {cs.sd.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                                      </td>
                                      <td style={{ padding: "0.2rem 0.4rem", textAlign: "right", fontVariantNumeric: "tabular-nums", color: cs.cv != null && cs.cv > 100 ? "#fbbf24" : "#e5e7eb" }}>
                                        {cs.cv != null ? cs.cv.toFixed(1) : "—"}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </>
                        );
                      })()}
                    </>
                  )}
                </div>
              )}

          {/* Q-2: Populations summary report */}
          {file && (
            <div
              style={{
                marginTop: "1rem",
                borderRadius: "0.75rem",
                overflow: "hidden",
                border: "1px solid rgba(100,116,139,0.35)",
                background: "rgba(15,23,42,0.5)",
              }}
            >
              {/* Panel header / toggle */}
              <button
                type="button"
                onClick={() => setPopExpanded((x) => !x)}
                style={{
                  display: "flex",
                  width: "100%",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.5rem 0.85rem",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "#e5e7eb",
                  fontSize: "0.78rem",
                  textAlign: "left",
                }}
              >
                <span style={{ textTransform: "uppercase", letterSpacing: "0.08em", color: "#9ca3af", fontWeight: 600 }}>
                  Populations ({gateList.length})
                </span>
                <span style={{ color: "#64748b", fontSize: "0.8rem" }}>{popExpanded ? "▲" : "▼"}</span>
              </button>

              {popExpanded && (
                <div style={{ padding: "0 0.85rem 0.75rem" }}>
                  {gateList.length === 0 ? (
                    <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                      No gates yet — draw gates to see population summary.
                    </div>
                  ) : (
                    (() => {
                      // Sort gates by active column
                      const sorted = [...gateList].sort((a, b) => {
                        let va: number | string;
                        let vb: number | string;
                        if (popSortCol === "name") {
                          va = a.name.toLowerCase();
                          vb = b.name.toLowerCase();
                        } else if (popSortCol === "count") {
                          va = a.count;
                          vb = b.count;
                        } else if (popSortCol === "pct_parent") {
                          va = a.pct_of_parent ?? 0;
                          vb = b.pct_of_parent ?? 0;
                        } else {
                          va = a.pct_of_total ?? 0;
                          vb = b.pct_of_total ?? 0;
                        }
                        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
                        return popSortDir === "asc" ? cmp : -cmp;
                      });

                      const handleHeaderClick = (col: PopulationSortCol) => {
                        if (popSortCol === col) {
                          setPopSortDir((d) => (d === "asc" ? "desc" : "asc"));
                        } else {
                          setPopSortCol(col);
                          setPopSortDir("desc");
                        }
                      };

                      const sortIcon = (col: PopulationSortCol) =>
                        popSortCol === col ? (popSortDir === "asc" ? " ▲" : " ▼") : "";

                      const handleExport = () => {
                        const header = ["Gate", "Count", "% Parent", "% Total"].join("\t");
                        const rows = sorted.map((g) =>
                          [g.name, g.count, (g.pct_of_parent ?? 0).toFixed(1), (g.pct_of_total ?? 0).toFixed(1)].join("\t"),
                        );
                        void navigator.clipboard.writeText([header, ...rows].join("\n"));
                      };

                      return (
                        <>
                          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.25rem", gap: "0.5rem" }}>
                            <button
                              type="button"
                              onClick={handleExport}
                              title="Copy to clipboard (tab-separated)"
                              style={{
                                padding: "0.15rem 0.45rem",
                                borderRadius: "0.35rem",
                                border: "1px solid rgba(148,163,184,0.35)",
                                background: "transparent",
                                color: "#94a3b8",
                                fontSize: "0.72rem",
                                cursor: "pointer",
                              }}
                            >
                              📋 Copy
                            </button>
                          </div>
                          <div style={{ overflowX: "auto", fontSize: "0.75rem" }}>
                            <table
                              style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                color: "#e5e7eb",
                              }}
                            >
                              <thead>
                                <tr style={{ borderBottom: "1px solid rgba(148,163,184,0.3)" }}>
                                  {(["Gate", "Count", "% Parent", "% Total"] as const).map((label, idx) => {
                                    const col: PopulationSortCol = ["name", "count", "pct_parent", "pct_total"][idx] as PopulationSortCol;
                                    return (
                                      <th
                                        key={label}
                                        onClick={() => handleHeaderClick(col)}
                                        style={{
                                          padding: "0.25rem 0.4rem",
                                          textAlign: label === "Gate" ? "left" : "right",
                                          color: popSortCol === col ? "#c4b5fd" : "#9ca3af",
                                          fontWeight: popSortCol === col ? 600 : 500,
                                          whiteSpace: "nowrap",
                                          cursor: "pointer",
                                          userSelect: "none",
                                        }}
                                      >
                                        {label}{sortIcon(col)}
                                      </th>
                                    );
                                  })}
                                </tr>
                              </thead>
                              <tbody>
                                {sorted.map((g, i) => (
                                  <tr
                                    key={g.id}
                                    onClick={() => {
                                      setActiveGateId(g.id);
                                      setDrawMode(false);
                                      setPendingGate(null);
                                      setDrawingPolygon(null);
                                      setDrawingRect(null);
                                    }}
                                    style={{
                                      background: i % 2 === 0 ? "transparent" : "rgba(148,163,184,0.04)",
                                      cursor: "pointer",
                                      opacity: activeGateId === g.id ? 1 : 0.7,
                                    }}
                                  >
                                    <td
                                      style={{
                                        padding: "0.2rem 0.4rem",
                                        color: activeGateId === g.id ? "#c4b5fd" : "#cbd5e1",
                                        maxWidth: "10rem",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                        fontWeight: activeGateId === g.id ? 500 : 400,
                                      }}
                                      title={g.name}
                                    >
                                      {g.name}
                                    </td>
                                    <td
                                      style={{
                                        padding: "0.2rem 0.4rem",
                                        textAlign: "right",
                                        fontVariantNumeric: "tabular-nums",
                                      }}
                                    >
                                      {g.count.toLocaleString()}
                                    </td>
                                    <td style={{ padding: "0.2rem 0.4rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                      {(g.pct_of_parent ?? 0).toFixed(1)}%
                                    </td>
                                    <td style={{ padding: "0.2rem 0.4rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                      {(g.pct_of_total ?? 0).toFixed(1)}%
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      );
                    })()
                  )}
                </div>
              )}
            </div>
          )}
            </div>
          )}

          {/* P-1: Plate layout panel */}
          <div
            style={{
              marginTop: "1rem",
              borderRadius: "0.75rem",
              overflow: "hidden",
              border: "1px solid rgba(251,191,36,0.3)",
              background: "rgba(15,23,42,0.5)",
            }}
          >
            <button
              type="button"
              onClick={() => setPlatePanelOpen((x) => !x)}
              style={{
                display: "flex",
                width: "100%",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.5rem 0.85rem",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "#e5e7eb",
                fontSize: "0.78rem",
                textAlign: "left",
              }}
            >
              <span style={{ textTransform: "uppercase", letterSpacing: "0.08em", color: "#fbbf24", fontWeight: 600 }}>
                🧫 Plate View {plates.length > 0 && <span style={{ color: "#6b7280", fontWeight: 400, textTransform: "none" }}>({plates.length})</span>}
              </span>
              <span style={{ color: "#64748b", fontSize: "0.8rem" }}>{platePanelOpen ? "▲" : "▼"}</span>
            </button>

            {platePanelOpen && (
              <div style={{ padding: "0 0.85rem 0.85rem" }}>
                {/* Create plate row */}
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.6rem", flexWrap: "wrap" }}>
                  {!plateCreateOpen ? (
                    <button
                      type="button"
                      onClick={() => setPlateCreateOpen(true)}
                      style={{
                        padding: "0.2rem 0.5rem",
                        borderRadius: "0.3rem",
                        border: "1px solid rgba(251,191,36,0.4)",
                        background: "rgba(251,191,36,0.1)",
                        color: "#fbbf24",
                        fontSize: "0.75rem",
                        cursor: "pointer",
                      }}
                    >
                      + New plate
                    </button>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={plateCreateName}
                        onChange={(e) => setPlateCreateName(e.target.value)}
                        placeholder="Plate name"
                        autoFocus
                        style={{
                          padding: "0.2rem 0.4rem",
                          borderRadius: "0.3rem",
                          border: "1px solid rgba(251,191,36,0.4)",
                          background: "rgba(15,23,42,0.8)",
                          color: "white",
                          fontSize: "0.75rem",
                          width: "110px",
                        }}
                      />
                      <select
                        value={plateCreateFormat}
                        onChange={(e) => setPlateCreateFormat(e.target.value)}
                        style={{
                          padding: "0.2rem 0.3rem",
                          borderRadius: "0.3rem",
                          border: "1px solid rgba(251,191,36,0.3)",
                          background: "rgba(15,23,42,0.8)",
                          color: "#fbbf24",
                          fontSize: "0.75rem",
                        }}
                      >
                        {["6","12","24","48","96"].map((f) => (
                          <option key={f} value={f}>{f}-well</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!plateCreateName.trim()}
                        onClick={async () => {
                          if (!plateCreateName.trim()) return;
                          try {
                            const created = await postJson<PlateInfo>(`${API_BASE}/api/plates`, {
                              name: plateCreateName.trim(),
                              format: plateCreateFormat,
                            });
                            setPlates((prev) => [...prev, created]);
                            setActivePlateId(created.id);
                            setPlateCreateName("");
                            setPlateCreateOpen(false);
                          } catch (e) {
                            setGateMessage(`Error creating plate: ${e instanceof Error ? e.message : String(e)}`);
                          }
                        }}
                        style={{
                          padding: "0.2rem 0.5rem",
                          borderRadius: "0.3rem",
                          border: "none",
                          background: "#fbbf24",
                          color: "#000",
                          fontSize: "0.75rem",
                          cursor: plateCreateName.trim() ? "pointer" : "not-allowed",
                          opacity: plateCreateName.trim() ? 1 : 0.5,
                          fontWeight: 600,
                        }}
                      >
                        Create
                      </button>
                      <button
                        type="button"
                        onClick={() => { setPlateCreateOpen(false); setPlateCreateName(""); }}
                        style={{ padding: "0.2rem 0.4rem", borderRadius: "0.3rem", border: "1px solid #6b7280", background: "transparent", color: "#9ca3af", fontSize: "0.75rem", cursor: "pointer" }}
                      >
                        ✕
                      </button>
                    </>
                  )}
                  {plates.length > 1 && (
                    <select
                      value={activePlateId ?? ""}
                      onChange={(e) => { setActivePlateId(e.target.value || null); setPlateStats(null); }}
                      style={{
                        padding: "0.2rem 0.4rem",
                        borderRadius: "0.3rem",
                        border: "1px solid rgba(251,191,36,0.3)",
                        background: "rgba(15,23,42,0.8)",
                        color: "#fbbf24",
                        fontSize: "0.75rem",
                      }}
                    >
                      {plates.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Active plate grid */}
                {(() => {
                  const activePlate = plates.find((p) => p.id === activePlateId);
                  if (!activePlate) {
                    if (plates.length === 0) {
                      return (
                        <div style={{ fontSize: "0.75rem", color: "#64748b", fontStyle: "italic" }}>
                          Create a plate to assign samples to wells and compare gate statistics across the plate.
                        </div>
                      );
                    }
                    return null;
                  }

                  // Build grid lookup
                  const statLookup: Record<string, PlateStatWell> = {};
                  if (plateStats && plateStats.plate_id === activePlateId) {
                    for (const w of plateStats.wells) statLookup[w.well_id] = w;
                  }
                  const maxCount = plateStats ? Math.max(1, ...plateStats.wells.map((w) => w.count)) : 1;

                  return (
                    <>
                      {/* Gate stats query row */}
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
                        <input
                          type="text"
                          value={plateGateName}
                          onChange={(e) => setPlateGateName(e.target.value)}
                          placeholder="Gate name for heatmap"
                          list="plate-gate-names"
                          style={{
                            padding: "0.2rem 0.4rem",
                            borderRadius: "0.3rem",
                            border: "1px solid rgba(251,191,36,0.4)",
                            background: "rgba(15,23,42,0.8)",
                            color: "white",
                            fontSize: "0.75rem",
                            flex: "1 1 120px",
                            minWidth: "100px",
                          }}
                        />
                        <datalist id="plate-gate-names">
                          {gateList.map((g) => <option key={g.id} value={g.name} />)}
                        </datalist>
                        <button
                          type="button"
                          disabled={!plateGateName.trim() || plateStatsLoading}
                          onClick={async () => {
                            if (!plateGateName.trim() || !activePlateId) return;
                            setPlateStatsLoading(true);
                            try {
                              const stats = await getJson<PlateStatsData>(
                                `${API_BASE}/api/plates/${encodeURIComponent(activePlateId)}/stats?gate_name=${encodeURIComponent(plateGateName.trim())}`
                              );
                              setPlateStats(stats);
                            } catch (e) {
                              setGateMessage(`Plate stats error: ${e instanceof Error ? e.message : String(e)}`);
                            } finally {
                              setPlateStatsLoading(false);
                            }
                          }}
                          style={{
                            padding: "0.2rem 0.5rem",
                            borderRadius: "0.3rem",
                            border: "none",
                            background: "#fbbf24",
                            color: "#000",
                            fontSize: "0.75rem",
                            cursor: "pointer",
                            fontWeight: 600,
                            opacity: (!plateGateName.trim() || plateStatsLoading) ? 0.5 : 1,
                          }}
                        >
                          {plateStatsLoading ? "…" : "Heatmap"}
                        </button>
                        {/* Delete plate button */}
                        <button
                          type="button"
                          onClick={async () => {
                            if (!window.confirm(`Delete plate "${activePlate.name}"?`)) return;
                            try {
                              await fetch(`${API_BASE}/api/plates/${encodeURIComponent(activePlateId ?? "")}`, { method: "DELETE" });
                              setPlates((prev) => prev.filter((p) => p.id !== activePlateId));
                              setActivePlateId(null);
                              setPlateStats(null);
                            } catch (e) {
                              setGateMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
                            }
                          }}
                          style={{ padding: "0.2rem 0.4rem", borderRadius: "0.3rem", border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.1)", color: "#fca5a5", fontSize: "0.72rem", cursor: "pointer" }}
                        >
                          🗑
                        </button>
                      </div>

                      {/* Plate grid */}
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ borderCollapse: "collapse", fontSize: "0.65rem", tableLayout: "fixed" }}>
                          <thead>
                            <tr>
                              <th style={{ width: "1.4rem", padding: "0.1rem" }} />
                              {Array.from({ length: activePlate.cols }, (_, c) => (
                                <th key={c} style={{ width: "2.0rem", textAlign: "center", color: "#64748b", padding: "0.1rem", fontWeight: 500 }}>
                                  {c + 1}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {Array.from({ length: activePlate.rows }, (_, r) => {
                              const rowLetter = "ABCDEFGHIJKLMNOP"[r] ?? String(r + 1);
                              return (
                                <tr key={r}>
                                  <td style={{ color: "#64748b", textAlign: "right", paddingRight: "0.2rem", fontWeight: 500 }}>
                                    {rowLetter}
                                  </td>
                                  {Array.from({ length: activePlate.cols }, (_, c) => {
                                    const wid = `${rowLetter}${c + 1}`;
                                    const well = activePlate.wells.find((w) => w.well_id === wid);
                                    const stat = statLookup[wid];
                                    const hasFile = !!well?.file_id;
                                    const intensity = stat && stat.count > 0 ? stat.count / maxCount : 0;
                                    // Color: amber heat-map (0→dark, 1→bright amber)
                                    const bgAlpha = 0.1 + intensity * 0.75;
                                    const bg = hasFile
                                      ? stat
                                        ? `rgba(251,191,36,${bgAlpha.toFixed(2)})`
                                        : "rgba(71,85,105,0.6)"
                                      : "rgba(15,23,42,0.4)";
                                    const label = well?.label ?? (well?.file_id ? (allFiles.find((f) => f.id === well.file_id)?.sample_name ?? well.file_id.slice(0, 6)) : "");
                                    const tooltipText = well?.file_id
                                      ? stat
                                        ? `${wid}: ${stat.count.toLocaleString()} (${stat.pct_of_parent.toFixed(1)}% parent)`
                                        : `${wid}: ${label || well.file_id.slice(0, 8)}`
                                      : `${wid}: empty`;
                                    return (
                                      <td
                                        key={c}
                                        title={tooltipText}
                                        onClick={() => {
                                          // Clicking a well in assign mode sets file_id from current file
                                          if (!file || !activePlateId) return;
                                          const winfo = activePlate.wells.find((w) => w.well_id === wid);
                                          const alreadyAssigned = winfo?.file_id === file.id;
                                          void (async () => {
                                            try {
                                              const updated = await postJson<PlateInfo>(
                                                `${API_BASE}/api/plates/${encodeURIComponent(activePlateId)}/wells/${encodeURIComponent(wid)}`,
                                                { well_id: wid, file_id: alreadyAssigned ? null : file.id, label: alreadyAssigned ? null : (file.sample_name ?? null) }
                                              );
                                              setPlates((prev) => prev.map((p) => p.id === activePlateId ? updated : p));
                                              setPlateStats(null); // reset stats after assignment change
                                            } catch (e) {
                                              setGateMessage(`Well assign error: ${e instanceof Error ? e.message : String(e)}`);
                                            }
                                          })();
                                        }}
                                        style={{
                                          width: "2.0rem",
                                          height: "1.6rem",
                                          background: bg,
                                          border: well?.file_id === file?.id
                                            ? "1.5px solid #fbbf24"
                                            : "1px solid rgba(71,85,105,0.5)",
                                          borderRadius: "0.2rem",
                                          textAlign: "center",
                                          verticalAlign: "middle",
                                          cursor: file ? "pointer" : "default",
                                          color: intensity > 0.5 ? "#000" : "#94a3b8",
                                          fontSize: "0.6rem",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                          maxWidth: "2.0rem",
                                          padding: "0",
                                          transition: "background 0.15s",
                                        }}
                                      >
                                        {stat ? stat.count > 0 ? stat.count >= 1000 ? `${(stat.count / 1000).toFixed(1)}k` : stat.count : "" : label ? label.slice(0, 3) : ""}
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {/* Legend */}
                      {plateStats && (
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.4rem", fontSize: "0.65rem", color: "#64748b" }}>
                          <div style={{ width: "0.8rem", height: "0.8rem", background: "rgba(251,191,36,0.12)", border: "1px solid rgba(71,85,105,0.5)", borderRadius: "0.1rem" }} />
                          <span>0</span>
                          <div style={{ width: "0.8rem", height: "0.8rem", background: "rgba(251,191,36,0.85)", border: "1px solid rgba(71,85,105,0.5)", borderRadius: "0.1rem" }} />
                          <span>{Math.max(...plateStats.wells.map((w) => w.count)).toLocaleString()}</span>
                          <span style={{ marginLeft: "0.5rem" }}>Click well to assign current file · hover for details</span>
                        </div>
                      )}
                      {!plateStats && file && (
                        <div style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.35rem" }}>
                          Click a well to assign the current file ({file.sample_name}). Then enter a gate name and click Heatmap.
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Q-4: Compensation summary popover (compact, ~220px wide) */}
          {compensationModalOpen && (
            <div
              style={{
                position: "fixed",
                top: "1rem",
                right: "1rem",
                width: "220px",
                maxHeight: "min(60vh, 380px)",
                background: "#0f172a",
                border: "1px solid rgba(168,85,247,0.5)",
                borderRadius: "0.5rem",
                boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
                zIndex: 9998,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {/* Compact header */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.5rem 0.75rem",
                  borderBottom: "1px solid rgba(148,163,184,0.2)",
                  background: "rgba(168,85,247,0.08)",
                }}
              >
                <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "#d8b4fe" }}>
                  🔬 Compensation
                </div>
                <button
                  type="button"
                  onClick={() => setCompensationModalOpen(false)}
                  title="Close (Esc)"
                  style={{
                    background: "none",
                    border: "none",
                    color: "#64748b",
                    fontSize: "1rem",
                    cursor: "pointer",
                    padding: "0 0.2rem",
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>

              {/* Compact summary content */}
              <div style={{ padding: "0.6rem 0.75rem", overflowY: "auto", flex: 1 }}>
                {spilloverLoading ? (
                  <div style={{ fontSize: "0.7rem", color: "#64748b", textAlign: "center", padding: "1rem 0" }}>
                    Loading…
                  </div>
                ) : spilloverData ? (
                  <>
                    {/* Key metric: Condition Number */}
                    <div
                      style={{
                        padding: "0.5rem",
                        borderRadius: "0.3rem",
                        background: "rgba(30,41,59,0.5)",
                        marginBottom: "0.6rem",
                        textAlign: "center",
                      }}
                    >
                      <div style={{ fontSize: "0.6rem", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.2rem" }}>
                        Condition Number
                      </div>
                      <div
                        style={{
                          fontSize: "1.3rem",
                          fontWeight: 700,
                          color: spilloverData.cond < 10 ? "#86efac" : spilloverData.cond < 100 ? "#fbbf24" : "#f87171",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {spilloverData.cond.toFixed(2)}
                      </div>
                      <div style={{ fontSize: "0.65rem", color: "#9ca3af", marginTop: "0.15rem" }}>
                        {spilloverData.cond < 10 ? "✓ Good" : spilloverData.cond < 100 ? "⚠ Fair" : "✗ Poor"}
                      </div>
                    </div>

                    {/* Top spillovers */}
                    {(() => {
                      const topSpillovers: { from: string; to: string; val: number }[] = [];
                      for (let i = 0; i < spilloverData.matrix.length; i++) {
                        const row = spilloverData.matrix[i];
                        if (!row) continue;
                        for (let j = 0; j < row.length; j++) {
                          if (i !== j && row[j]! > 0.01) {
                            topSpillovers.push({
                              from: spilloverData.channel_names[j]!,
                              to: spilloverData.channel_names[i]!,
                              val: row[j]!,
                            });
                          }
                        }
                      }
                      topSpillovers.sort((a, b) => b.val - a.val);
                      const top3 = topSpillovers.slice(0, 3);

                      return (
                        <>
                          <div style={{ fontSize: "0.6rem", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.3rem" }}>
                            Top Spillovers
                          </div>
                          {top3.length === 0 ? (
                            <div style={{ fontSize: "0.65rem", color: "#64748b", fontStyle: "italic", marginBottom: "0.5rem" }}>
                              None significant
                            </div>
                          ) : (
                            <div style={{ marginBottom: "0.5rem" }}>
                              {top3.map((sp, idx) => (
                                <div
                                  key={idx}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    padding: "0.2rem 0.3rem",
                                    fontSize: "0.65rem",
                                    color: "#cbd5e1",
                                    borderBottom: idx < top3.length - 1 ? "1px solid rgba(148,163,184,0.1)" : "none",
                                  }}
                                >
                                  <span style={{ fontFamily: "monospace" }}>
                                    {sp.from.substring(0, 6)} → {sp.to.substring(0, 6)}
                                  </span>
                                  <span
                                    style={{
                                      color: sp.val > 0.05 ? "#fbbf24" : "#9ca3af",
                                      fontWeight: 600,
                                      fontVariantNumeric: "tabular-nums",
                                    }}
                                  >
                                    {(sp.val * 100).toFixed(1)}%
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}

                    {/* Quick info */}
                    <div style={{ fontSize: "0.6rem", color: "#64748b", marginBottom: "0.6rem", lineHeight: "1.3" }}>
                      {spilloverData.channel_names.length} channels
                    </div>

                    {/* View Full Matrix button */}
                    <button
                      type="button"
                      onClick={() => setCompensationFullMatrixOpen(true)}
                      style={{
                        width: "100%",
                        padding: "0.4rem",
                        borderRadius: "0.3rem",
                        border: "1px solid rgba(168,85,247,0.4)",
                        background: "rgba(168,85,247,0.15)",
                        color: "#d8b4fe",
                        fontSize: "0.7rem",
                        fontWeight: 500,
                        cursor: "pointer",
                      }}
                    >
                      View Full Matrix →
                    </button>
                  </>
                ) : (
                  <div style={{ fontSize: "0.7rem", color: "#64748b", textAlign: "center", padding: "1rem 0" }}>
                    No compensation matrix.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Q-4b: Compensation editor modal — full editable matrix + Apply/Reset */}
          {compensationFullMatrixOpen && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.55)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 10000,
                backdropFilter: "blur(3px)",
              }}
              onClick={() => setCompensationFullMatrixOpen(false)}
            >
              <div
                style={{
                  background: "#0f172a",
                  border: "1px solid rgba(168,85,247,0.4)",
                  borderRadius: "0.6rem",
                  padding: "1.25rem",
                  maxWidth: "min(92vw, 860px)",
                  maxHeight: "88vh",
                  overflowY: "auto",
                  boxShadow: "0 24px 48px rgba(0,0,0,0.6)",
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: "0.95rem", fontWeight: 600, color: "#e5e7eb" }}>
                    🔬 Compensation Matrix Editor
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    {/* Load from file */}
                    {file && (
                      <button
                        type="button"
                        onClick={async () => {
                          await loadSpilloverFromFile(file.id);
                          setCompStatus("idle");
                          setCompError(null);
                        }}
                        style={{
                          padding: "0.3rem 0.6rem",
                          borderRadius: "0.35rem",
                          border: "1px solid rgba(74,222,128,0.5)",
                          background: "rgba(34,197,94,0.12)",
                          color: "#4ade80",
                          fontSize: "0.78rem",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        ↓ Load from file
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setCompensationFullMatrixOpen(false)}
                      style={{ background: "none", border: "none", color: "#64748b", fontSize: "1.25rem", cursor: "pointer", padding: "0.1rem 0.3rem", lineHeight: 1 }}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Editable matrix */}
                {spillMatrix.length > 0 ? (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", fontSize: "0.72rem" }}>
                      <thead>
                        <tr>
                          <th style={{ minWidth: "72px", padding: "0 0.2rem 0.3rem", color: "#6b7280", fontWeight: 500, textAlign: "left" }}>Detector ↓</th>
                          {spillChNames.map((name, j) => (
                            <th key={j} style={{ padding: "0 0.2rem 0.3rem", fontWeight: "normal" }}>
                              <input
                                value={name}
                                onChange={(e) => {
                                  const next = [...spillChNames];
                                  next[j] = e.target.value;
                                  setSpillChNames(next);
                                  setCompStatus("idle");
                                  setCompError(null);
                                }}
                                style={{
                                  width: "72px",
                                  background: "rgba(15,23,42,0.7)",
                                  border: "1px solid rgba(148,163,184,0.35)",
                                  borderRadius: "0.25rem",
                                  color: "#c7d2fe",
                                  fontSize: "0.68rem",
                                  padding: "0.15rem 0.25rem",
                                  textAlign: "center",
                                }}
                              />
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {spillMatrix.map((row, i) => (
                          <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "rgba(148,163,184,0.03)" }}>
                            <td style={{ color: "#6b7280", paddingRight: "0.4rem", fontSize: "0.68rem", whiteSpace: "nowrap", maxWidth: "72px", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {spillChNames[i] ?? ""}
                            </td>
                            {row.map((val, j) => (
                              <td key={j} style={{ padding: "0.1rem 0.15rem" }}>
                                <input
                                  type="number"
                                  step="any"
                                  value={val}
                                  onChange={(e) => {
                                    const next = spillMatrix.map((r) => [...r]);
                                    next[i][j] = e.target.value;
                                    setSpillMatrix(next);
                                    setCompStatus("idle");
                                    setCompError(null);
                                  }}
                                  style={{
                                    width: "72px",
                                    background: i === j ? "rgba(34,197,94,0.1)" : "rgba(15,23,42,0.7)",
                                    border: `1px solid ${i === j ? "rgba(74,222,128,0.4)" : "rgba(148,163,184,0.25)"}`,
                                    borderRadius: "0.25rem",
                                    color: "white",
                                    fontSize: "0.7rem",
                                    padding: "0.15rem 0.25rem",
                                    textAlign: "center",
                                  }}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: "0.5rem", fontSize: "0.65rem", color: "#475569" }}>
                      <span style={{ color: "#86efac" }}>■</span> diagonal (self),{" "}
                      values = fraction of signal that spills into each detector
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: "center", padding: "2rem 1rem", color: "#4b5563", fontSize: "0.8rem" }}>
                    <div style={{ marginBottom: "0.5rem" }}>No spillover matrix loaded.</div>
                    {file && (
                      <button
                        type="button"
                        onClick={async () => {
                          await loadSpilloverFromFile(file.id);
                          setCompStatus("idle");
                        }}
                        style={{
                          padding: "0.4rem 0.9rem",
                          borderRadius: "0.4rem",
                          border: "1px solid rgba(74,222,128,0.5)",
                          background: "rgba(34,197,94,0.15)",
                          color: "#4ade80",
                          fontSize: "0.8rem",
                          cursor: "pointer",
                        }}
                      >
                        ↓ Load from FCS file header
                      </button>
                    )}
                  </div>
                )}

                {/* Action row: Apply + Reset + status */}
                {spillMatrix.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", borderTop: "1px solid rgba(148,163,184,0.15)", paddingTop: "0.75rem" }}>
                    <button
                      type="button"
                      disabled={compStatus === "applying"}
                      onClick={async () => {
                        if (!file) return;
                        setCompStatus("applying");
                        setCompError(null);
                        try {
                          const rows = spillMatrix.map((row) =>
                            row.map((v) => {
                              const n = Number(v);
                              if (!Number.isFinite(n)) throw new Error(`Invalid value: "${v}"`);
                              return n;
                            }),
                          );
                          if (!rows.length) throw new Error("Matrix is empty");
                          const n = rows[0].length;
                          if (!rows.every((r) => r.length === n)) throw new Error("Inconsistent row lengths");
                          if (rows.length !== n) throw new Error("Matrix must be square");
                          type CompApplyResp = { file_id: string; n_channels: number; cond?: number | null };
                          const body: { file_id: string; spillover: number[][]; channel_names?: string[] } = { file_id: file.id, spillover: rows };
                          if (spillChNames.length === n) body.channel_names = spillChNames;
                          const applyResp = await postJson<CompApplyResp>(`${API_BASE}/api/compensation/apply`, body);
                          setCompCond(applyResp?.cond ?? null);
                          setIsCompensated(true);
                          setCompStatus("success");
                          setCompensationFullMatrixOpen(false);
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
                        padding: "0.4rem 1rem",
                        borderRadius: "999px",
                        border: "none",
                        fontSize: "0.82rem",
                        fontWeight: 600,
                        cursor: compStatus === "applying" ? "not-allowed" : "pointer",
                        background: "linear-gradient(135deg, #22c55e, #16a34a)",
                        color: "white",
                        opacity: compStatus === "applying" ? 0.7 : 1,
                      }}
                    >
                      {compStatus === "applying" ? "Applying…" : "✓ Apply compensation"}
                    </button>
                    {isCompensated && (
                      <button
                        type="button"
                        disabled={compStatus === "applying"}
                        onClick={async () => {
                          if (!file) return;
                          setCompStatus("applying");
                          try {
                            const res = await fetch(`${API_BASE}/api/compensation/${encodeURIComponent(file.id)}`, { method: "DELETE" });
                            if (!res.ok) throw new Error(`HTTP ${res.status}`);
                            setCompCond(null);
                            setIsCompensated(false);
                            setCompStatus("idle");
                            setCompError(null);
                            setCompensationFullMatrixOpen(false);
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
                          padding: "0.4rem 0.85rem",
                          borderRadius: "999px",
                          border: "1px solid rgba(148,163,184,0.5)",
                          background: "transparent",
                          color: "#94a3b8",
                          fontSize: "0.82rem",
                          cursor: "pointer",
                        }}
                      >
                        Reset
                      </button>
                    )}
                    {compStatus === "success" && (
                      <span style={{ fontSize: "0.78rem", color: "#4ade80" }}>
                        ✓ Applied{compCond != null && ` — κ=${compCond.toFixed(1)}`}
                      </span>
                    )}
                    {compStatus === "error" && compError && (
                      <span style={{ fontSize: "0.75rem", color: "#fca5a5" }}>{compError}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Backdrop for popover (click to close) */}
          {compensationModalOpen && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 9997,
              }}
              onClick={() => setCompensationModalOpen(false)}
            />
          )}
        </div>
        </div>
      </div>

      {/* U: Layout Editor overlay modal */}
      {layoutEditorOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10001,
            display: "flex",
            flexDirection: "column",
            background: "rgba(0,0,0,0.7)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "8px 16px",
              background: "#0e0e1a",
              borderBottom: "1px solid #333",
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, color: "#a78bfa" }}>
              🗂 Layout Editor
            </span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => setLayoutEditorOpen(false)}
              style={{
                background: "none",
                border: "1px solid #444",
                borderRadius: 4,
                color: "#ccc",
                cursor: "pointer",
                fontSize: 13,
                padding: "3px 12px",
              }}
            >
              Close
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", background: "#fff" }}>
            <LayoutEditorPanel />
          </div>
        </div>
      )}

      {/* T: Table Editor overlay modal */}
      {tablePanelOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            display: "flex",
            flexDirection: "column",
            background: "rgba(0,0,0,0.7)",
          }}
        >
          {/* Modal header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "8px 16px",
              background: "#0e0e1a",
              borderBottom: "1px solid #333",
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, color: "#fbbf24" }}>
              📊 Table Editor
            </span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => setTablePanelOpen(false)}
              style={{
                background: "none",
                border: "1px solid #444",
                borderRadius: 4,
                color: "#ccc",
                cursor: "pointer",
                fontSize: 13,
                padding: "3px 12px",
              }}
            >
              Close
            </button>
          </div>
          {/* Panel content */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TablePanel />
          </div>
        </div>
      )}
    </div>
  );
}

