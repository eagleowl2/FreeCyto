import React from "react";
import { WebGLScatter } from "./WebGLScatter";

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
};

type ScatterPoint = { x: number; y: number };

const API_BASE = "http://127.0.0.1:8765";

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
  const [channelNames, setChannelNames] = React.useState<string[]>([]);
  const [xChannel, setXChannel] = React.useState("");
  const [yChannel, setYChannel] = React.useState("");
  const [transformX, setTransformX] = React.useState<"linear" | "log" | "arcsinh" | "logicle">("linear");
  const [transformY, setTransformY] = React.useState<"linear" | "log" | "arcsinh" | "logicle">("linear");
  const [points, setPoints] = React.useState<ScatterPoint[]>([]);
  const [fcsStatus, setFcsStatus] = React.useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [fcsError, setFcsError] = React.useState<string | null>(null);

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

  type EventsResponse = { channel_names: string[]; events: number[][]; };

  const fetchEventsAndPlot = React.useCallback(
    async (fileId: string, x: string, y: string, tx: string, ty: string) => {
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
      const rawPoints: ScatterPoint[] = eventsResp.events.map((row) => ({
        x: row[0] ?? 0,
        y: row[1] ?? 0,
      }));
      if (!rawPoints.length) throw new Error("No events returned for plotting");
      const xs = rawPoints.map((p) => p.x);
      const ys = rawPoints.map((p) => p.y);
      const xMin = Math.min(...xs);
      const xMax = Math.max(...xs);
      const yMin = Math.min(...ys);
      const yMax = Math.max(...ys);
      const norm = (v: number, min: number, max: number) =>
        max === min ? 0.5 : (v - min) / (max - min);
      setPoints(
        rawPoints.map((p) => ({
          x: norm(p.x, xMin, xMax),
          y: norm(p.y, yMin, yMax),
        })),
      );
    },
    [],
  );

  const handleLoadFcs = React.useCallback(async (pathOverride?: string) => {
    const path = (pathOverride ?? fcsPath).trim();
    if (!path) return;
    setFcsStatus("loading");
    setFcsError(null);
    setPoints([]);
    setFile(null);
    setChannelNames([]);
    setXChannel("");
    setYChannel("");

    try {
      type LoadResponse = {
        files: Array<{
          id: string;
          path: string;
          sample_name?: string | null;
          event_count: number;
          channels: Array<{ name: string }>;
        }>;
      };

      const loadResp = await postJson<LoadResponse>(`${API_BASE}/api/files/load`, {
        paths: [path],
        downsample_events: 50000,
      });

      if (!loadResp.files.length) throw new Error("Backend returned no files");
      const first = loadResp.files[0];
      const names = first.channels.map((c) => c.name);
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
      };
      setFile(loaded);
      setLoadedFiles((prev) => {
        const existingIdx = prev.findIndex((f) => f.id === loaded.id);
        if (existingIdx === -1) return [...prev, loaded];
        const copy = prev.slice();
        copy[existingIdx] = loaded;
        return copy;
      });
      setChannelNames(names);
      setXChannel(xName);
      setYChannel(yName);
      setTransformX("linear");
      setTransformY("linear");
      setFcsStatus("loaded");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFcsError(message);
      setFcsStatus("error");
    }
  }, [fcsPath, fetchEventsAndPlot]);

  // Refetch events when file or axis/transform selection changes
  React.useEffect(() => {
    if (!file?.id || !xChannel || !yChannel) return;
    setFcsError(null);
    setFcsStatus("loading");
    let cancelled = false;
    (async () => {
      try {
        await fetchEventsAndPlot(file.id, xChannel, yChannel, transformX, transformY);
        if (!cancelled) setFcsStatus("loaded");
      } catch (err) {
        if (!cancelled) {
          setFcsError(err instanceof Error ? err.message : String(err));
          setFcsStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file?.id, xChannel, yChannel, transformX, transformY, fetchEventsAndPlot]);

  const width = 480;
  const height = 360;
  const margin = 24;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "stretch",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        background:
          "radial-gradient(circle at top, #0f172a 0, #020617 45%, #020617 100%)",
        color: "white",
        padding: "2.5rem 3rem",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 320px) minmax(0, 560px)",
          gap: "2rem",
          alignItems: "flex-start",
          maxWidth: "1100px",
          width: "100%",
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
              display: "flex",
              gap: "0.6rem",
              marginBottom: "0.6rem",
            }}
          >
            <input
              type="text"
              value={fcsPath}
              readOnly
              placeholder="Select FCS file(s)…"
              style={{
                flex: 1,
                padding: "0.5rem 0.65rem",
                borderRadius: "0.6rem",
                border: "1px solid rgba(148,163,184,0.6)",
                backgroundColor: "rgba(15,23,42,0.2)",
                color: "white",
                fontSize: "0.9rem",
              }}
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  const anyGlobal = globalThis as any;
                  const paths: string[] =
                    anyGlobal.opencyto?.openFcsFiles
                      ? await anyGlobal.opencyto.openFcsFiles()
                      : [];
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
                padding: "0.5rem 0.95rem",
                borderRadius: "0.7rem",
                border: "none",
                fontSize: "0.9rem",
                fontWeight: 500,
                cursor: "pointer",
                background:
                  "linear-gradient(135deg, #22c55e, #16a34a, #22c55e)",
                color: "white",
                opacity: fcsStatus === "loading" ? 0.7 : 1,
                whiteSpace: "nowrap",
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
                    onClick={() => {
                      setFile(lf);
                      setChannelNames(lf.channels);
                      setXChannel(lf.channels[0] ?? "");
                      setYChannel(lf.channels[1] ?? lf.channels[0] ?? "");
                      setTransformX("linear");
                      setTransformY("linear");
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
                <div>
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
                    {channelNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
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
                    {channelNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
                  X transform
                  <select
                    value={transformX}
                    onChange={(e) =>
                      setTransformX(e.target.value as "linear" | "log" | "arcsinh" | "logicle")
                    }
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
                      setTransformY(e.target.value as "linear" | "log" | "arcsinh" | "logicle")
                    }
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
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: "0.35rem",
                    gap: "0.5rem",
                  }}
                >
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
                        if (!rows.every((r) => r.length === n) || n !== file.channels.length) {
                          throw new Error(
                            "Matrix must be square and match number of channels for this file",
                          );
                        }
                        const body = { file_id: file.id, spillover: rows };
                        await postJson(`${API_BASE}/api/compensation/apply`, body);
                        setCompStatus("success");
                        // After applying compensation, force a refetch of events
                        await fetchEventsAndPlot(file.id, xChannel, yChannel, transformX, transformY);
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
            <WebGLScatter points={points} width={width} height={height} margin={margin} />
            <svg
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              style={{ display: "block", width: "100%", height: "auto", pointerEvents: "none" }}
            >
              <rect
                x={margin}
                y={margin}
                width={width - 2 * margin}
                height={height - 2 * margin}
                fill="transparent"
                stroke="#4b5563"
                strokeWidth={1}
              />
              {points.length === 0 && (
                <text
                  x={width / 2}
                  y={height / 2}
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
    </div>
  );
}

