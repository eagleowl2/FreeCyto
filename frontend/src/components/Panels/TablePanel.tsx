/**
 * TablePanel — Phase T
 *
 * Tabbed panel that hosts:
 *   • Batch Stats — samples × gates statistics for the active experiment
 *   • Plate Wells  — well assignments for a plate (selected by drop-down)
 *   • Population   — per-gate per-channel statistics for the active gate
 *
 * Data is fetched from the backend whenever the relevant selection changes.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useExperiment } from "../../context/ExperimentContext";
import { BatchStatsTable } from "../Tables/BatchStatsTable";
import { PlateWellTable } from "../Tables/PlateWellTable";
import { PopStatsTable } from "../Tables/PopStatsTable";
import type { BatchStatsTable as BatchStatsData, PlateWellTable as PlateWellData, PopStatsTable as PopStatsData } from "../../types/table";

const API = "http://127.0.0.1:8765";

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── Tab types ────────────────────────────────────────────────────────────────

type Tab = "batch" | "wells" | "population";

// ─── Styles ──────────────────────────────────────────────────────────────────

const S = {
  root: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    background: "#12121e",
  },
  tabBar: {
    display: "flex",
    alignItems: "center",
    borderBottom: "1px solid #333",
    padding: "0 8px",
    gap: 2,
    flexShrink: 0,
    background: "#0e0e1a",
  },
  tab: (active: boolean): React.CSSProperties => ({
    padding: "6px 14px",
    fontSize: 12,
    cursor: "pointer",
    borderBottom: active ? "2px solid #4da6ff" : "2px solid transparent",
    color: active ? "#90c8ff" : "#777",
    userSelect: "none",
    transition: "color 0.1s, border-color 0.1s",
    marginBottom: -1,
  }),
  content: {
    flex: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column" as const,
  },
  notice: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#555",
    fontSize: 13,
    fontStyle: "italic",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 10px",
    borderBottom: "1px solid #222",
    flexShrink: 0,
  },
  label: {
    fontSize: 12,
    color: "#888",
  },
  input: {
    background: "#1e1e2e",
    border: "1px solid #444",
    borderRadius: 4,
    color: "#ccc",
    fontSize: 12,
    padding: "3px 8px",
    outline: "none",
  },
} as const;

// ─── Batch stats tab ──────────────────────────────────────────────────────────

function BatchTab() {
  const { activeExperiment, selectSample } = useExperiment();
  const [data, setData] = useState<BatchStatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateFilter, setGateFilter] = useState("");
  const prevExpId = useRef<string | null>(null);

  useEffect(() => {
    if (!activeExperiment) { setData(null); return; }
    if (prevExpId.current === activeExperiment.id && data) return; // already loaded
    prevExpId.current = activeExperiment.id;
    setLoading(true);
    setError(null);
    const params = gateFilter.trim() ? `?gate_names=${encodeURIComponent(gateFilter.trim())}` : "";
    fetchJSON<BatchStatsData>(`${API}/api/tables/batch-stats/${activeExperiment.id}${params}`)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [activeExperiment, gateFilter]);

  const handleRefresh = useCallback(() => {
    if (!activeExperiment) return;
    prevExpId.current = null; // force re-fetch
    setData(null);
  }, [activeExperiment]);

  if (!activeExperiment) {
    return <div style={S.notice}>Select an experiment to view batch statistics.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={S.toolbar}>
        <span style={S.label}>Gates (comma-sep):</span>
        <input
          style={{ ...S.input, width: 240 }}
          placeholder="All gates"
          value={gateFilter}
          onChange={(e) => setGateFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleRefresh(); }}
        />
        <button
          style={{
            background: "#1e3a5f",
            border: "1px solid #2d5a8e",
            borderRadius: 4,
            color: "#90c8ff",
            cursor: "pointer",
            fontSize: 12,
            padding: "3px 10px",
          }}
          onClick={handleRefresh}
        >
          Refresh
        </button>
        <span style={{ flex: 1 }} />
        {loading && <span style={{ fontSize: 11, color: "#888" }}>Loading…</span>}
        {error && <span style={{ fontSize: 11, color: "#f44336" }}>Error: {error}</span>}
      </div>
      {data ? (
        <BatchStatsTable
          data={data}
          onSelectSample={selectSample}
        />
      ) : (
        !loading && <div style={S.notice}>No data loaded.</div>
      )}
    </div>
  );
}

// ─── Plate wells tab ──────────────────────────────────────────────────────────

function WellsTab() {
  const [plateId, setPlateId] = useState("");
  const [gateName, setGateName] = useState("");
  const [data, setData] = useState<PlateWellData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLoad = useCallback(() => {
    if (!plateId.trim()) return;
    setLoading(true);
    setError(null);
    const params = gateName.trim() ? `?gate_name=${encodeURIComponent(gateName.trim())}` : "";
    fetchJSON<PlateWellData>(`${API}/api/tables/plate-wells/${plateId.trim()}${params}`)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [plateId, gateName]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={S.toolbar}>
        <span style={S.label}>Plate ID:</span>
        <input
          style={{ ...S.input, width: 180 }}
          placeholder="plate-uuid"
          value={plateId}
          onChange={(e) => setPlateId(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleLoad(); }}
        />
        <span style={S.label}>Gate:</span>
        <input
          style={{ ...S.input, width: 140 }}
          placeholder="optional"
          value={gateName}
          onChange={(e) => setGateName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleLoad(); }}
        />
        <button
          style={{
            background: "#1e3a5f",
            border: "1px solid #2d5a8e",
            borderRadius: 4,
            color: "#90c8ff",
            cursor: "pointer",
            fontSize: 12,
            padding: "3px 10px",
          }}
          onClick={handleLoad}
          disabled={!plateId.trim()}
        >
          Load
        </button>
        {loading && <span style={{ fontSize: 11, color: "#888" }}>Loading…</span>}
        {error && <span style={{ fontSize: 11, color: "#f44336" }}>Error: {error}</span>}
      </div>
      {data ? (
        <PlateWellTable data={data} />
      ) : (
        !loading && (
          <div style={S.notice}>Enter a Plate ID and click Load.</div>
        )
      )}
    </div>
  );
}

// ─── Population stats tab ─────────────────────────────────────────────────────

function PopulationTab() {
  const [gateId, setGateId] = useState("");
  const [data, setData] = useState<PopStatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLoad = useCallback(() => {
    if (!gateId.trim()) return;
    setLoading(true);
    setError(null);
    fetchJSON<PopStatsData>(`${API}/api/tables/population/${gateId.trim()}`)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [gateId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={S.toolbar}>
        <span style={S.label}>Gate ID:</span>
        <input
          style={{ ...S.input, width: 220 }}
          placeholder="gate-uuid"
          value={gateId}
          onChange={(e) => setGateId(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleLoad(); }}
        />
        <button
          style={{
            background: "#1e3a5f",
            border: "1px solid #2d5a8e",
            borderRadius: 4,
            color: "#90c8ff",
            cursor: "pointer",
            fontSize: 12,
            padding: "3px 10px",
          }}
          onClick={handleLoad}
          disabled={!gateId.trim()}
        >
          Load
        </button>
        {loading && <span style={{ fontSize: 11, color: "#888" }}>Loading…</span>}
        {error && <span style={{ fontSize: 11, color: "#f44336" }}>Error: {error}</span>}
      </div>
      {data ? (
        <PopStatsTable data={data} />
      ) : (
        !loading && (
          <div style={S.notice}>Enter a Gate ID and click Load.</div>
        )
      )}
    </div>
  );
}

// ─── Root panel ───────────────────────────────────────────────────────────────

export function TablePanel() {
  const [activeTab, setActiveTab] = useState<Tab>("batch");

  return (
    <div style={S.root}>
      {/* Tab bar */}
      <div style={S.tabBar}>
        <div style={S.tab(activeTab === "batch")} onClick={() => setActiveTab("batch")}>
          Batch Stats
        </div>
        <div style={S.tab(activeTab === "wells")} onClick={() => setActiveTab("wells")}>
          Plate Wells
        </div>
        <div style={S.tab(activeTab === "population")} onClick={() => setActiveTab("population")}>
          Population
        </div>
      </div>

      {/* Content */}
      <div style={S.content}>
        {activeTab === "batch" && <BatchTab />}
        {activeTab === "wells" && <WellsTab />}
        {activeTab === "population" && <PopulationTab />}
      </div>
    </div>
  );
}
