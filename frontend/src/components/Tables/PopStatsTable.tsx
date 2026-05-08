/**
 * PopStatsTable — Phase T
 *
 * Per-gate, per-channel statistics table.
 * Columns: Channel | MFI | Median | SD | CV% | Geo Mean
 * CV% > 100 highlighted in amber. Sortable, exportable.
 */

import React, { useCallback, useMemo, useState } from "react";
import type { PopStatsRow, PopStatsTable as PopStatsTableData, SortDir } from "../../types/table";

// ─── Styles ──────────────────────────────────────────────────────────────────

const S = {
  wrapper: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    overflow: "hidden",
    background: "#12121e",
  },
  header: {
    padding: "8px 10px 6px",
    borderBottom: "1px solid #333",
    flexShrink: 0,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 10px",
    borderBottom: "1px solid #333",
    flexShrink: 0,
  },
  btn: {
    background: "#1e3a5f",
    border: "1px solid #2d5a8e",
    borderRadius: 4,
    color: "#90c8ff",
    cursor: "pointer",
    fontSize: 12,
    padding: "3px 10px",
  },
  tableScroll: {
    flex: 1,
    overflow: "auto",
  },
  table: {
    borderCollapse: "collapse" as const,
    width: "100%",
    fontSize: 12,
    color: "#ccc",
  },
  th: (sorted: boolean): React.CSSProperties => ({
    background: "#1a1a2e",
    border: "1px solid #333",
    padding: "6px 10px",
    whiteSpace: "nowrap" as const,
    cursor: "pointer",
    userSelect: "none" as const,
    color: sorted ? "#90c8ff" : "#aaa",
    fontWeight: 600,
    position: "sticky" as const,
    top: 0,
    zIndex: 1,
  }),
  td: (alt: boolean): React.CSSProperties => ({
    border: "1px solid #2a2a3a",
    padding: "5px 10px",
    background: alt ? "#16162a" : "transparent",
    whiteSpace: "nowrap",
  }),
  tdNum: (alt: boolean, warn?: boolean): React.CSSProperties => ({
    border: "1px solid #2a2a3a",
    padding: "5px 10px",
    textAlign: "right",
    background: warn ? "rgba(255,160,0,0.1)" : alt ? "#16162a" : "transparent",
    color: warn ? "#ffa040" : "inherit",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  }),
  footer: {
    borderTop: "1px solid #333",
    padding: "4px 10px",
    fontSize: 11,
    color: "#666",
    flexShrink: 0,
  },
} as const;

// ─── Sort ─────────────────────────────────────────────────────────────────────

type Col = "channel" | "mfi" | "median" | "sd" | "cv_pct" | "geo_mean";

function sortRows(rows: PopStatsRow[], col: Col, dir: SortDir): PopStatsRow[] {
  const factor = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = a[col];
    const vb = b[col];
    if (typeof va === "string" && typeof vb === "string")
      return factor * va.localeCompare(vb);
    return factor * ((va as number) - (vb as number));
  });
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function buildCSV(data: PopStatsTableData, rows: PopStatsRow[]): string {
  const lines = [
    `# Gate: ${data.gate_name} | Count: ${data.count} | % Parent: ${data.pct_of_parent.toFixed(2)}% | % Total: ${data.pct_of_total.toFixed(2)}%`,
    "Channel,MFI,Median,SD,CV%,Geo Mean",
  ];
  for (const r of rows) {
    lines.push(
      [
        `"${r.display_name}"`,
        r.mfi.toFixed(2),
        r.median.toFixed(2),
        r.sd.toFixed(2),
        r.cv_pct.toFixed(2),
        r.geo_mean.toFixed(2),
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

// ─── Component ────────────────────────────────────────────────────────────────

interface PopStatsTableProps {
  data: PopStatsTableData;
}

export function PopStatsTable({ data }: PopStatsTableProps) {
  const [sortCol, setSortCol] = useState<Col>("channel");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const sorted = useMemo(
    () => sortRows(data.rows, sortCol, sortDir),
    [data.rows, sortCol, sortDir],
  );

  const handleSort = useCallback((col: Col) => {
    setSortCol((prev) => {
      if (prev === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      else setSortDir("asc");
      return col;
    });
  }, []);

  const arrow = (col: Col) => {
    if (sortCol !== col) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  };

  const handleExport = useCallback(() => {
    const csv = buildCSV(data, sorted);
    downloadCSV(csv, `population_${data.gate_id}.csv`);
  }, [data, sorted]);

  const handleCopy = useCallback(async () => {
    const csv = buildCSV(data, sorted);
    try {
      await navigator.clipboard.writeText(csv);
    } catch {
      console.warn("Clipboard write failed");
    }
  }, [data, sorted]);

  return (
    <div style={S.wrapper}>
      {/* Gate summary header */}
      <div style={S.header}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#90c8ff", marginBottom: 3 }}>
          {data.gate_name}
        </div>
        <div style={{ fontSize: 11, color: "#888", display: "flex", gap: 16 }}>
          <span>Count: <strong style={{ color: "#ccc" }}>{data.count.toLocaleString()}</strong></span>
          <span>% Parent: <strong style={{ color: "#ccc" }}>{data.pct_of_parent.toFixed(2)}%</strong></span>
          <span>% Total: <strong style={{ color: "#ccc" }}>{data.pct_of_total.toFixed(2)}%</strong></span>
        </div>
      </div>

      {/* Toolbar */}
      <div style={S.toolbar}>
        <span style={{ flex: 1 }} />
        <button style={S.btn} onClick={handleCopy}>Copy</button>
        <button style={S.btn} onClick={handleExport}>⬇ CSV</button>
      </div>

      {/* Table */}
      <div style={S.tableScroll}>
        <table style={S.table}>
          <thead>
            <tr>
              {(
                [
                  ["channel", "Channel"],
                  ["mfi", "MFI"],
                  ["median", "Median"],
                  ["sd", "SD"],
                  ["cv_pct", "CV%"],
                  ["geo_mean", "Geo Mean"],
                ] as [Col, string][]
              ).map(([col, label]) => (
                <th
                  key={col}
                  style={S.th(sortCol === col)}
                  onClick={() => handleSort(col)}
                >
                  {label}{arrow(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 20, textAlign: "center", color: "#555" }}>
                  No channel data available.
                </td>
              </tr>
            ) : (
              sorted.map((row, i) => {
                const alt = i % 2 === 1;
                const highCV = row.cv_pct > 100;
                return (
                  <tr key={row.channel}>
                    <td style={S.td(alt)}>{row.display_name}</td>
                    <td style={S.tdNum(alt)}>{row.mfi.toFixed(2)}</td>
                    <td style={S.tdNum(alt)}>{row.median.toFixed(2)}</td>
                    <td style={S.tdNum(alt)}>{row.sd.toFixed(2)}</td>
                    <td style={S.tdNum(alt, highCV)} title={highCV ? "High CV% — check gating or compensation" : undefined}>
                      {row.cv_pct.toFixed(1)}%{highCV ? " ⚠" : ""}
                    </td>
                    <td style={S.tdNum(alt)}>{row.geo_mean.toFixed(2)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div style={S.footer}>
        {sorted.length} channels
        {sorted.filter((r) => r.cv_pct > 100).length > 0 && (
          <span style={{ marginLeft: 8, color: "#ffa040" }}>
            ⚠ {sorted.filter((r) => r.cv_pct > 100).length} high CV%
          </span>
        )}
      </div>
    </div>
  );
}
