/** Phase T — Table data types (returned by /api/tables and /api/experiments batch-stats endpoints) */

export interface GateStatCell {
  gate_name: string;
  count: number;
  pct_of_parent: number;
  pct_of_total: number;
  mfi?: Record<string, number>;
}

export interface BatchStatsRow {
  sample_id: string;
  sample_name: string;
  file_id: string | null;
  load_status: string;
  group_id: string;
  group_name: string;
  total_events: number;
  gate_stats: GateStatCell[];
}

export interface BatchStatsTable {
  experiment_id: string;
  gate_names: string[];
  rows: BatchStatsRow[];
}

/** Plate well */
export interface PlateWellRow {
  well_id: string;
  row: number;
  col: number;
  file_id: string | null;
  sample_name: string | null;
  label: string | null;
  load_status: string;
  gate_count: number;
  gate_pct: number;
}

export interface PlateWellTable {
  plate_id: string;
  plate_name: string;
  rows: number;
  cols: number;
  gate_name: string | null;
  wells: PlateWellRow[];
}

/** Population (per-gate per-channel stats) */
export interface PopStatsRow {
  channel: string;
  display_name: string;
  mfi: number;
  median: number;
  sd: number;
  cv_pct: number;
  geo_mean: number;
}

export interface PopStatsTable {
  gate_id: string;
  gate_name: string;
  file_id: string;
  count: number;
  pct_of_parent: number;
  pct_of_total: number;
  rows: PopStatsRow[];
}

export type SortDir = "asc" | "desc";
