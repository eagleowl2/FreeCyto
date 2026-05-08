"""Table data models for Phase T — Table Editor.

Used by /api/tables/* endpoints to return structured tabular data
for batch statistics, plate well assignments, and population statistics.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


# ─── Batch Statistics Table ───────────────────────────────────────────────────

class GateStatCell(BaseModel):
    """Statistics for one gate in one sample row."""
    gate_name: str
    count: int
    pct_of_parent: float
    pct_of_total: float
    mfi: Dict[str, float] = {}       # channel → MFI (mean fluorescence intensity)


class BatchStatsRow(BaseModel):
    """One row = one sample; columns = gate statistics."""
    sample_id: str
    sample_name: str
    file_id: str | None
    load_status: str
    group_id: str
    group_name: str
    total_events: int
    gate_stats: List[GateStatCell]   # one per gate column (parallel to header)


class BatchStatsTable(BaseModel):
    """Complete batch stats table: headers + rows."""
    experiment_id: str
    gate_names: List[str]            # column headers (gate names)
    rows: List[BatchStatsRow]


# ─── Plate Well Table ─────────────────────────────────────────────────────────

class PlateWellRow(BaseModel):
    """One row = one well in the plate."""
    well_id: str                     # e.g. "A1", "H12"
    row: int                         # 0-indexed row (A=0, B=1, ...)
    col: int                         # 0-indexed col (1→0, 2→1, ...)
    file_id: str | None
    sample_name: str | None          # from experiment sample record
    label: str | None
    load_status: str                 # "empty" | "loaded" | "pending" | "error"
    gate_count: float                # event count for selected gate (0 if none)
    gate_pct: float                  # pct of parent for selected gate


class PlateWellTable(BaseModel):
    """Complete plate well table."""
    plate_id: str
    plate_name: str
    rows: int
    cols: int
    gate_name: str | None            # gate used for count/pct columns
    wells: List[PlateWellRow]


# ─── Population Statistics Table ─────────────────────────────────────────────

class PopStatsRow(BaseModel):
    """One row = one channel in the gate population."""
    channel: str
    display_name: str
    mfi: float                       # mean fluorescence intensity (raw)
    median: float
    sd: float
    cv_pct: float                    # coefficient of variation %
    geo_mean: float                  # geometric mean


class PopStatsTable(BaseModel):
    """Per-gate per-file population statistics."""
    gate_id: str
    gate_name: str
    file_id: str
    count: int
    pct_of_parent: float
    pct_of_total: float
    rows: List[PopStatsRow]          # one per channel


# ─── Export ───────────────────────────────────────────────────────────────────

class TableExportRequest(BaseModel):
    """Request to export table data as CSV or text."""
    table_type: str                  # "batch_stats" | "plate_wells" | "population"
    experiment_id: str | None = None
    plate_id: str | None = None
    gate_id: str | None = None
    gate_name: str | None = None
    file_id: str | None = None
    format: str = "csv"              # "csv" only for now
