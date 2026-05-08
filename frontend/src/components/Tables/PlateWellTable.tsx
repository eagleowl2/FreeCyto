/**
 * PlateWellTable — Phase T
 *
 * Grid view of a plate (96, 48, 24, 12, or 6-well).
 * Each well cell shows: well ID, sample name, load status, gate count/pct.
 * Click a well to select; double-click to edit label.
 * Color-intensity represents gate count (heat-map).
 * Supports CSV export of well assignments.
 */

import React, { useCallback, useMemo, useState } from "react";
import type { PlateWellRow, PlateWellTable as PlateWellTableData } from "../../types/table";

// ─── Color scale ──────────────────────────────────────────────────────────────

function countToColor(count: number, maxCount: number): string {
  if (maxCount === 0 || count === 0) return "transparent";
  const t = Math.min(count / maxCount, 1);
  // Blue (low) → Cyan → Green (high)
  const r = Math.round(0 + t * 0);
  const g = Math.round(80 + t * 175);
  const b = Math.round(160 + t * (0 - 160));
  return `rgba(${r},${g},${b},${0.15 + t * 0.5})`;
}

// ─── Row letters / column numbers ────────────────────────────────────────────

function rowLabel(r: number) {
  return String.fromCharCode(64 + r); // 1→A, 2→B …
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function buildCSV(data: PlateWellTableData): string {
  const lines = ["Well,Row,Col,File ID,Sample Name,Label,Status,Gate Count,Gate % Parent"];
  for (const w of data.wells) {
    lines.push(
      [
        w.well_id,
        rowLabel(w.row),
        w.col,
        w.file_id ?? "",
        w.sample_name ?? "",
        w.label ?? "",
        w.load_status,
        w.gate_count.toFixed(0),
        w.gate_pct.toFixed(2),
      ].join(","),
    );
  }
  return lines.join("\n");
}

function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Well cell ────────────────────────────────────────────────────────────────

interface WellCellProps {
  well: PlateWellRow;
  maxCount: number;
  selected: boolean;
  onClick: (wellId: string) => void;
  onDoubleClick: (well: PlateWellRow) => void;
}

function WellCell({ well, maxCount, selected, onClick, onDoubleClick }: WellCellProps) {
  const bg = useMemo(
    () => (well.gate_count > 0 ? countToColor(well.gate_count, maxCount) : undefined),
    [well.gate_count, maxCount],
  );

  const statusColor =
    well.load_status === "loaded"
      ? "#4caf50"
      : well.load_status === "error"
      ? "#f44336"
      : "#444";

  const cellStyle: React.CSSProperties = {
    border: selected ? "2px solid #4da6ff" : "1px solid #2a2a3a",
    borderRadius: 4,
    padding: "4px 3px",
    cursor: well.file_id ? "pointer" : "default",
    background: selected ? "#1e3a5f88" : bg,
    minWidth: 56,
    minHeight: 52,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    color: "#ccc",
    textAlign: "center",
    transition: "border 0.1s",
    position: "relative",
  };

  return (
    <td style={{ padding: 2 }}>
      <div
        style={cellStyle}
        onClick={() => onClick(well.well_id)}
        onDoubleClick={() => onDoubleClick(well)}
        title={well.file_id ? `${well.well_id}: ${well.sample_name ?? well.label ?? well.file_id}` : well.well_id}
      >
        {/* Status dot */}
        <span
          style={{
            position: "absolute",
            top: 3,
            right: 3,
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: statusColor,
          }}
        />
        {/* Well ID */}
        <span style={{ fontWeight: 600, color: "#888", fontSize: 9 }}>{well.well_id}</span>
        {/* Label / sample name */}
        {(well.label || well.sample_name) && (
          <span
            style={{
              fontSize: 9,
              color: "#ccc",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 50,
              whiteSpace: "nowrap",
            }}
          >
            {well.label ?? well.sample_name}
          </span>
        )}
        {/* Gate count */}
        {well.gate_count > 0 && (
          <span style={{ fontSize: 9, color: "#90c8ff" }}>
            {well.gate_count >= 1000
              ? `${(well.gate_count / 1000).toFixed(1)}k`
              : well.gate_count.toFixed(0)}
          </span>
        )}
        {/* Percent */}
        {well.gate_pct > 0 && (
          <span style={{ fontSize: 9, color: "#aaa" }}>{well.gate_pct.toFixed(1)}%</span>
        )}
      </div>
    </td>
  );
}

// ─── Edit dialog ──────────────────────────────────────────────────────────────

interface WellDetailProps {
  well: PlateWellRow;
  onClose: () => void;
}

function WellDetail({ well, onClose }: WellDetailProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          background: "#1e1e2e",
          border: "1px solid #444",
          borderRadius: 8,
          padding: 20,
          minWidth: 280,
          color: "#ccc",
          fontSize: 13,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 12px", color: "#90c8ff" }}>Well {well.well_id}</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          {[
            ["File ID", well.file_id ?? "—"],
            ["Sample", well.sample_name ?? "—"],
            ["Label", well.label ?? "—"],
            ["Status", well.load_status],
            ["Gate Count", well.gate_count.toLocaleString()],
            ["Gate % Parent", `${well.gate_pct.toFixed(2)}%`],
          ].map(([k, v]) => (
            <tr key={k}>
              <td style={{ padding: "3px 8px 3px 0", color: "#888", fontWeight: 500 }}>{k}</td>
              <td style={{ padding: "3px 0" }}>{v}</td>
            </tr>
          ))}
        </table>
        <button
          style={{
            marginTop: 16,
            background: "none",
            border: "1px solid #444",
            borderRadius: 4,
            color: "#ccc",
            cursor: "pointer",
            padding: "4px 12px",
          }}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface PlateWellTableProps {
  data: PlateWellTableData;
}

export function PlateWellTable({ data }: PlateWellTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailWell, setDetailWell] = useState<PlateWellRow | null>(null);

  // Build well map for O(1) lookup
  const wellMap = useMemo(() => {
    const m = new Map<string, PlateWellRow>();
    for (const w of data.wells) m.set(w.well_id, w);
    return m;
  }, [data.wells]);

  const maxCount = useMemo(
    () => Math.max(0, ...data.wells.map((w) => w.gate_count)),
    [data.wells],
  );

  const handleClick = useCallback((wellId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(wellId)) next.delete(wellId);
      else next.add(wellId);
      return next;
    });
  }, []);

  const handleExport = useCallback(() => {
    const csv = buildCSV(data);
    downloadCSV(csv, `plate_wells_${data.plate_id}.csv`);
  }, [data]);

  // Build grid: rows 1..data.rows, cols 1..data.cols
  const grid = useMemo(() => {
    const rows: PlateWellRow[][] = [];
    for (let r = 1; r <= data.rows; r++) {
      const cols: PlateWellRow[] = [];
      for (let c = 1; c <= data.cols; c++) {
        const wellId = `${rowLabel(r)}${c}`;
        const well = wellMap.get(wellId);
        if (well) {
          cols.push(well);
        } else {
          // Empty placeholder
          cols.push({
            well_id: wellId,
            row: r,
            col: c,
            file_id: null,
            sample_name: null,
            label: null,
            load_status: "empty",
            gate_count: 0,
            gate_pct: 0,
          });
        }
      }
      rows.push(cols);
    }
    return rows;
  }, [data, wellMap]);

  const loadedCount = data.wells.filter((w) => w.load_status === "loaded").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "#12121e" }}>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderBottom: "1px solid #333",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, color: "#ccc", fontWeight: 600 }}>
          {data.plate_name}
        </span>
        <span style={{ fontSize: 11, color: "#666" }}>
          {data.rows}×{data.cols}
          {data.gate_name && ` · ${data.gate_name}`}
        </span>
        <span style={{ flex: 1 }} />
        {selected.size > 0 && (
          <span style={{ fontSize: 12, color: "#888" }}>{selected.size} selected</span>
        )}
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
          onClick={handleExport}
        >
          ⬇ CSV
        </button>
      </div>

      {/* Legend */}
      {data.gate_name && maxCount > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            fontSize: 10,
            color: "#666",
            borderBottom: "1px solid #222",
            flexShrink: 0,
          }}
        >
          <span>Low</span>
          <div
            style={{
              width: 80,
              height: 8,
              borderRadius: 4,
              background: "linear-gradient(to right, rgba(0,80,160,0.2), rgba(0,200,80,0.65))",
            }}
          />
          <span>High ({maxCount.toLocaleString()})</span>
        </div>
      )}

      {/* Grid */}
      <div style={{ flex: 1, overflow: "auto", padding: 10 }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0 }}>
          <thead>
            <tr>
              <th style={{ width: 20, fontSize: 10, color: "#555" }} />
              {Array.from({ length: data.cols }, (_, i) => (
                <th
                  key={i + 1}
                  style={{
                    fontSize: 10,
                    color: "#555",
                    fontWeight: 400,
                    textAlign: "center",
                    paddingBottom: 4,
                  }}
                >
                  {i + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((rowWells, ri) => (
              <tr key={ri}>
                <td
                  style={{
                    fontSize: 10,
                    color: "#555",
                    fontWeight: 600,
                    paddingRight: 4,
                    textAlign: "center",
                    verticalAlign: "middle",
                  }}
                >
                  {rowLabel(ri + 1)}
                </td>
                {rowWells.map((w) => (
                  <WellCell
                    key={w.well_id}
                    well={w}
                    maxCount={maxCount}
                    selected={selected.has(w.well_id)}
                    onClick={handleClick}
                    onDoubleClick={setDetailWell}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div
        style={{
          borderTop: "1px solid #333",
          padding: "4px 10px",
          fontSize: 11,
          color: "#666",
          flexShrink: 0,
        }}
      >
        {loadedCount} / {data.wells.length} wells loaded
        {selected.size > 0 && ` · ${selected.size} selected`}
      </div>

      {/* Detail modal */}
      {detailWell && (
        <WellDetail well={detailWell} onClose={() => setDetailWell(null)} />
      )}
    </div>
  );
}
