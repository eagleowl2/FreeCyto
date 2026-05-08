/**
 * BatchStatsTable — Phase T
 *
 * Sortable, filterable table: rows = samples, column groups = gates.
 * Each gate column group: Count | % Parent | % Total.
 * Supports multi-row selection, CSV export, and clipboard copy.
 */

import React, { useCallback, useMemo, useRef, useState } from "react";
import type { BatchStatsRow, BatchStatsTable as BatchStatsTableData, SortDir } from "../../types/table";

// ─── Styles ──────────────────────────────────────────────────────────────────

const S = {
  wrapper: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    overflow: "hidden",
    background: "#12121e",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderBottom: "1px solid #333",
    flexShrink: 0,
  },
  searchInput: {
    background: "#1e1e2e",
    border: "1px solid #444",
    borderRadius: 4,
    color: "#ccc",
    fontSize: 12,
    padding: "3px 8px",
    width: 200,
    outline: "none",
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
    padding: "5px 8px",
    whiteSpace: "nowrap" as const,
    cursor: "pointer",
    userSelect: "none" as const,
    color: sorted ? "#90c8ff" : "#aaa",
    fontWeight: 600,
    position: "sticky" as const,
    top: 0,
    zIndex: 1,
  }),
  thGroup: {
    background: "#16162a",
    border: "1px solid #333",
    padding: "4px 8px",
    textAlign: "center" as const,
    color: "#888",
    fontWeight: 600,
    fontSize: 11,
    position: "sticky" as const,
    top: 0,
    zIndex: 2,
  } as React.CSSProperties,
  td: (selected: boolean, alt: boolean): React.CSSProperties => ({
    border: "1px solid #2a2a3a",
    padding: "4px 8px",
    background: selected ? "#1e3a5f55" : alt ? "#16162a" : "transparent",
    whiteSpace: "nowrap",
  }),
  tdNum: (selected: boolean, alt: boolean): React.CSSProperties => ({
    border: "1px solid #2a2a3a",
    padding: "4px 8px",
    textAlign: "right",
    background: selected ? "#1e3a5f55" : alt ? "#16162a" : "transparent",
    fontVariantNumeric: "tabular-nums",
  }),
  footer: {
    borderTop: "1px solid #333",
    padding: "4px 10px",
    fontSize: 11,
    color: "#666",
    flexShrink: 0,
  },
} as const;

// ─── Sort helpers ─────────────────────────────────────────────────────────────

type SortKey =
  | { type: "sample_name" }
  | { type: "group_name" }
  | { type: "total_events" }
  | { type: "load_status" }
  | { type: "gate_count"; gate: string }
  | { type: "gate_pct_parent"; gate: string }
  | { type: "gate_pct_total"; gate: string };

function sortRows(
  rows: BatchStatsRow[],
  key: SortKey,
  dir: SortDir,
): BatchStatsRow[] {
  const factor = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let va: string | number;
    let vb: string | number;

    switch (key.type) {
      case "sample_name":
        va = a.sample_name.toLowerCase();
        vb = b.sample_name.toLowerCase();
        break;
      case "group_name":
        va = a.group_name.toLowerCase();
        vb = b.group_name.toLowerCase();
        break;
      case "total_events":
        va = a.total_events;
        vb = b.total_events;
        break;
      case "load_status":
        va = a.load_status;
        vb = b.load_status;
        break;
      case "gate_count": {
        const ca = a.gate_stats.find((g) => g.gate_name === key.gate);
        const cb = b.gate_stats.find((g) => g.gate_name === key.gate);
        va = ca?.count ?? 0;
        vb = cb?.count ?? 0;
        break;
      }
      case "gate_pct_parent": {
        const ca = a.gate_stats.find((g) => g.gate_name === key.gate);
        const cb = b.gate_stats.find((g) => g.gate_name === key.gate);
        va = ca?.pct_of_parent ?? 0;
        vb = cb?.pct_of_parent ?? 0;
        break;
      }
      case "gate_pct_total": {
        const ca = a.gate_stats.find((g) => g.gate_name === key.gate);
        const cb = b.gate_stats.find((g) => g.gate_name === key.gate);
        va = ca?.pct_of_total ?? 0;
        vb = cb?.pct_of_total ?? 0;
        break;
      }
    }

    if (typeof va === "string" && typeof vb === "string") {
      return factor * va.localeCompare(vb);
    }
    return factor * ((va as number) - (vb as number));
  });
}

// ─── CSV export helper ────────────────────────────────────────────────────────

function buildCSV(data: BatchStatsTableData, rows: BatchStatsRow[]): string {
  const headers = ["Sample", "Group", "File ID", "Load Status", "Total Events"];
  for (const g of data.gate_names) {
    headers.push(`${g} Count`, `${g} % Parent`, `${g} % Total`);
  }

  const lines: string[] = [headers.join(",")];
  for (const row of rows) {
    const cells = [
      `"${row.sample_name}"`,
      `"${row.group_name}"`,
      row.file_id ?? "",
      row.load_status,
      String(row.total_events),
    ];
    for (const gs of row.gate_stats) {
      cells.push(String(gs.count), gs.pct_of_parent.toFixed(2), gs.pct_of_total.toFixed(2));
    }
    lines.push(cells.join(","));
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

interface BatchStatsTableProps {
  data: BatchStatsTableData;
  /** Called when user clicks a sample row (to navigate to it). */
  onSelectSample?: (sampleId: string) => void;
}

export function BatchStatsTable({ data, onSelectSample }: BatchStatsTableProps) {
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>({ type: "sample_name" });
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);

  // Filter rows
  const filtered = useMemo(() => {
    if (!filter.trim()) return data.rows;
    const q = filter.toLowerCase();
    return data.rows.filter(
      (r) =>
        r.sample_name.toLowerCase().includes(q) ||
        r.group_name.toLowerCase().includes(q),
    );
  }, [data.rows, filter]);

  // Sort
  const sorted = useMemo(
    () => sortRows(filtered, sortKey, sortDir),
    [filtered, sortKey, sortDir],
  );

  const handleSortClick = useCallback(
    (key: SortKey) => {
      setSortKey((prev) => {
        const same = JSON.stringify(prev) === JSON.stringify(key);
        if (same) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        else setSortDir("asc");
        return key;
      });
    },
    [],
  );

  const sortArrow = (key: SortKey) => {
    const isSorted = JSON.stringify(sortKey) === JSON.stringify(key);
    if (!isSorted) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  };

  // Row selection (click = single, shift+click = range, ctrl+click = toggle)
  const handleRowClick = useCallback(
    (e: React.MouseEvent, sampleId: string) => {
      if (e.shiftKey && lastClickedRef.current) {
        const ids = sorted.map((r) => r.sample_id);
        const from = ids.indexOf(lastClickedRef.current);
        const to = ids.indexOf(sampleId);
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelected((prev) => {
          const next = new Set(prev);
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
          return next;
        });
      } else if (e.ctrlKey || e.metaKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(sampleId)) next.delete(sampleId);
          else next.add(sampleId);
          return next;
        });
      } else {
        setSelected(new Set([sampleId]));
        onSelectSample?.(sampleId);
      }
      lastClickedRef.current = sampleId;
    },
    [sorted, onSelectSample],
  );

  const handleExport = useCallback(() => {
    const rows = selected.size > 0
      ? sorted.filter((r) => selected.has(r.sample_id))
      : sorted;
    const csv = buildCSV(data, rows);
    downloadCSV(csv, `batch_stats_${data.experiment_id}.csv`);
  }, [data, sorted, selected]);

  const handleCopy = useCallback(async () => {
    const rows = selected.size > 0
      ? sorted.filter((r) => selected.has(r.sample_id))
      : sorted;
    const csv = buildCSV(data, rows);
    try {
      await navigator.clipboard.writeText(csv);
    } catch {
      console.warn("Clipboard write failed");
    }
  }, [data, sorted, selected]);

  const selectedCount = selected.size;

  return (
    <div style={S.wrapper}>
      {/* Toolbar */}
      <div style={S.toolbar}>
        <input
          style={S.searchInput}
          placeholder="Filter by sample or group…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span style={{ flex: 1 }} />
        {selectedCount > 0 && (
          <span style={{ fontSize: 12, color: "#888" }}>{selectedCount} selected</span>
        )}
        <button style={S.btn} onClick={handleCopy} title="Copy to clipboard">
          Copy
        </button>
        <button style={S.btn} onClick={handleExport} title="Export CSV">
          ⬇ CSV
        </button>
      </div>

      {/* Table */}
      <div style={S.tableScroll}>
        <table style={S.table}>
          <thead>
            {/* Gate group header row */}
            <tr>
              <th style={{ ...S.thGroup, textAlign: "left" as const }} rowSpan={2}>
                Sample
              </th>
              <th style={{ ...S.thGroup, textAlign: "left" as const }} rowSpan={2}>
                Group
              </th>
              <th style={{ ...S.thGroup, textAlign: "right" as const }} rowSpan={2}>
                Events
              </th>
              <th style={{ ...S.thGroup, textAlign: "left" as const }} rowSpan={2}>
                Status
              </th>
              {data.gate_names.map((g) => (
                <th key={g} style={S.thGroup} colSpan={3}>
                  {g}
                </th>
              ))}
            </tr>
            {/* Column sub-headers */}
            <tr>
              {data.gate_names.map((g) => (
                <React.Fragment key={g}>
                  <th
                    style={S.th(JSON.stringify(sortKey) === JSON.stringify({ type: "gate_count", gate: g }))}
                    onClick={() => handleSortClick({ type: "gate_count", gate: g })}
                  >
                    Count{sortArrow({ type: "gate_count", gate: g })}
                  </th>
                  <th
                    style={S.th(JSON.stringify(sortKey) === JSON.stringify({ type: "gate_pct_parent", gate: g }))}
                    onClick={() => handleSortClick({ type: "gate_pct_parent", gate: g })}
                  >
                    %P{sortArrow({ type: "gate_pct_parent", gate: g })}
                  </th>
                  <th
                    style={S.th(JSON.stringify(sortKey) === JSON.stringify({ type: "gate_pct_total", gate: g }))}
                    onClick={() => handleSortClick({ type: "gate_pct_total", gate: g })}
                  >
                    %T{sortArrow({ type: "gate_pct_total", gate: g })}
                  </th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={4 + data.gate_names.length * 3}
                  style={{ padding: 20, textAlign: "center", color: "#555" }}
                >
                  {filter ? "No samples match the filter." : "No samples in this experiment."}
                </td>
              </tr>
            ) : (
              sorted.map((row, i) => {
                const sel = selected.has(row.sample_id);
                const alt = i % 2 === 1;
                return (
                  <tr
                    key={row.sample_id}
                    style={{ cursor: "pointer" }}
                    onClick={(e) => handleRowClick(e, row.sample_id)}
                    onDoubleClick={() => onSelectSample?.(row.sample_id)}
                  >
                    <td style={S.td(sel, alt)}>{row.sample_name}</td>
                    <td style={S.td(sel, alt)}>{row.group_name}</td>
                    <td style={S.tdNum(sel, alt)}>{row.total_events.toLocaleString()}</td>
                    <td style={S.td(sel, alt)}>
                      <span
                        style={{
                          display: "inline-block",
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          marginRight: 4,
                          background:
                            row.load_status === "loaded"
                              ? "#4caf50"
                              : row.load_status === "error"
                              ? "#f44336"
                              : "#888",
                        }}
                      />
                      {row.load_status}
                    </td>
                    {row.gate_stats.map((gs) => (
                      <React.Fragment key={gs.gate_name}>
                        <td style={S.tdNum(sel, alt)}>{gs.count.toLocaleString()}</td>
                        <td style={S.tdNum(sel, alt)}>{gs.pct_of_parent.toFixed(1)}%</td>
                        <td style={S.tdNum(sel, alt)}>{gs.pct_of_total.toFixed(1)}%</td>
                      </React.Fragment>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div style={S.footer}>
        {sorted.length} of {data.rows.length} samples
        {data.gate_names.length > 0 && ` · ${data.gate_names.length} gates`}
        {selectedCount > 0 && ` · ${selectedCount} selected`}
      </div>
    </div>
  );
}

