"""Tables router — Phase T.

Endpoints:
  GET    /api/tables/batch-stats/{exp_id}       Batch statistics table
  GET    /api/tables/plate-wells/{plate_id}     Plate well assignment table
  GET    /api/tables/population/{gate_id}       Population statistics per channel
  POST   /api/tables/export                      Export any table as CSV
"""

from __future__ import annotations

import io
import logging
from typing import List

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from models.table_models import (
    BatchStatsRow,
    BatchStatsTable,
    GateStatCell,
    PlateWellRow,
    PlateWellTable,
    PopStatsRow,
    PopStatsTable,
    TableExportRequest,
)

logger = logging.getLogger("opencyto")
router = APIRouter(prefix="/api/tables", tags=["tables"])


# ─── Batch Stats Table ───────────────────────────────────────────────────────

@router.get("/batch-stats/{exp_id}", response_model=BatchStatsTable)
async def get_batch_stats_table(
    exp_id: str,
    gate_names: str = Query("", description="Comma-separated gate names to include as columns"),
) -> BatchStatsTable:
    """Return a samples × gates statistics table for the experiment.

    - gate_names: comma-separated list of gate names to include as columns.
      If empty, all unique gate names found across the experiment are used.
    - Rows with no loaded file return zero counts.
    """
    from services import experiment_service, gates as gates_service
    from services.storage import get_file_metadata

    store = experiment_service.get_store()
    try:
        exp = store.get_experiment(exp_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    # collect all sample+gate data first
    requested_cols = [g.strip() for g in gate_names.split(",") if g.strip()]

    # Phase 1: collect all gate trees and find columns if not specified
    sample_data: list[dict] = []
    all_gate_names: set[str] = set()

    for grp_id, grp in exp.groups.items():
        for sample in grp.samples.values():
            if not sample.file_id:
                sample_data.append({
                    "sample": sample, "grp_id": grp_id, "grp": grp,
                    "gate_tree": [], "total": 0,
                })
                continue
            try:
                gate_tree = gates_service.get_gate_tree(sample.file_id)
                meta = get_file_metadata(sample.file_id)
                total = meta.event_count if meta else 0
                _collect_gate_names(gate_tree, all_gate_names)
            except Exception:
                gate_tree = []
                total = 0
            sample_data.append({
                "sample": sample, "grp_id": grp_id, "grp": grp,
                "gate_tree": gate_tree, "total": total,
            })

    # Phase 2: determine columns
    if requested_cols:
        columns = requested_cols
    else:
        columns = sorted(all_gate_names)

    # Phase 3: build rows
    rows: list[BatchStatsRow] = []
    for sd in sample_data:
        sample = sd["sample"]
        gate_stats: list[GateStatCell] = []
        for col in columns:
            found = _find_gate_by_name(sd["gate_tree"], col)
            if found:
                cell = GateStatCell(
                    gate_name=col,
                    count=found.count,
                    pct_of_parent=found.pct_of_parent,
                    pct_of_total=found.pct_of_total,
                )
            else:
                cell = GateStatCell(gate_name=col, count=0,
                                    pct_of_parent=0.0, pct_of_total=0.0)
            gate_stats.append(cell)

        rows.append(BatchStatsRow(
            sample_id=sample.id,
            sample_name=sample.name,
            file_id=sample.file_id,
            load_status=sample.load_status,
            group_id=sd["grp_id"],
            group_name=sd["grp"].name,
            total_events=sd["total"],
            gate_stats=gate_stats,
        ))

    return BatchStatsTable(experiment_id=exp_id, gate_names=columns, rows=rows)


# ─── Plate Well Table ─────────────────────────────────────────────────────────

@router.get("/plate-wells/{plate_id}", response_model=PlateWellTable)
async def get_plate_well_table(
    plate_id: str,
    gate_name: str = Query("", description="Gate name for count/pct columns"),
) -> PlateWellTable:
    """Return a well assignment table with optional gate statistics."""
    from services import plate_service, gates as gates_service

    try:
        plate = plate_service.get_plate(plate_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    wells: list[PlateWellRow] = []
    for w in plate.wells:
        # Default values
        gate_count = 0.0
        gate_pct = 0.0
        load_status = "empty"
        sample_name = None

        if w.file_id and gate_name:
            load_status = "loaded"
            sample_name = w.label
            try:
                gate_tree = gates_service.get_gate_tree(w.file_id)
                found = _find_gate_by_name(gate_tree, gate_name)
                if found:
                    gate_count = float(found.count)
                    gate_pct = found.pct_of_parent
            except Exception:
                load_status = "error"
        elif w.file_id:
            load_status = "loaded"
            sample_name = w.label

        wells.append(PlateWellRow(
            well_id=w.well_id,
            row=w.row,
            col=w.col,
            file_id=w.file_id,
            sample_name=sample_name,
            label=w.label,
            load_status=load_status,
            gate_count=gate_count,
            gate_pct=gate_pct,
        ))

    return PlateWellTable(
        plate_id=plate_id,
        plate_name=plate.name,
        rows=plate.rows,
        cols=plate.cols,
        gate_name=gate_name or None,
        wells=wells,
    )


# ─── Population Stats Table ──────────────────────────────────────────────────

@router.get("/population/{gate_id}", response_model=PopStatsTable)
async def get_population_stats_table(gate_id: str) -> PopStatsTable:
    """Return channel-wise statistics for a specific gate population."""
    import numpy as np
    from services import gates as gates_service
    from services.storage import get_file_events, get_file_metadata

    # Resolve gate
    try:
        gate_resp = gates_service.get_gate_by_id(gate_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    file_id = gate_resp.file_id
    try:
        events = get_file_events(file_id)        # full (comp or raw) events
        meta = get_file_metadata(file_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    # Get gate mask
    try:
        mask = gates_service.get_gate_mask(gate_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to get gate mask: {exc}") from exc

    gated = events[mask]  # shape: (count, n_channels)
    if gated.shape[0] == 0:
        rows = []
    else:
        rows = []
        channels = meta.channels if meta else []
        for idx, ch in enumerate(channels):
            col = gated[:, idx]
            col_pos = col[col > 0]
            mfi = float(np.mean(col))
            median = float(np.median(col))
            sd = float(np.std(col))
            cv_pct = float((sd / mfi * 100) if mfi != 0 else 0.0)
            geo_mean = float(np.exp(np.mean(np.log(col_pos)))) if len(col_pos) > 0 else 0.0
            rows.append(PopStatsRow(
                channel=ch.name,
                display_name=ch.display_name or ch.name,
                mfi=mfi,
                median=median,
                sd=sd,
                cv_pct=cv_pct,
                geo_mean=geo_mean,
            ))

    return PopStatsTable(
        gate_id=gate_id,
        gate_name=gate_resp.name,
        file_id=file_id,
        count=gate_resp.count,
        pct_of_parent=gate_resp.pct_of_parent,
        pct_of_total=gate_resp.pct_of_total,
        rows=rows,
    )


# ─── Generic Export ──────────────────────────────────────────────────────────

@router.post("/export")
async def export_table(body: TableExportRequest) -> StreamingResponse:
    """Export any table type as CSV."""
    buf = io.StringIO()

    if body.table_type == "batch_stats":
        if not body.experiment_id:
            raise HTTPException(400, "experiment_id required for batch_stats export")
        table = await get_batch_stats_table(body.experiment_id, body.gate_name or "")
        buf.write("Sample,Group,File ID,Load Status,Total Events")
        for col in table.gate_names:
            buf.write(f",{col} Count,{col} % Parent,{col} % Total")
        buf.write("\n")
        for row in table.rows:
            buf.write(f"{row.sample_name},{row.group_name},{row.file_id or ''},{row.load_status},{row.total_events}")
            for gs in row.gate_stats:
                buf.write(f",{gs.count},{gs.pct_of_parent:.2f},{gs.pct_of_total:.2f}")
            buf.write("\n")
        filename = f"batch_stats_{body.experiment_id}.csv"

    elif body.table_type == "plate_wells":
        if not body.plate_id:
            raise HTTPException(400, "plate_id required for plate_wells export")
        table = await get_plate_well_table(body.plate_id, body.gate_name or "")
        buf.write("Well,Row,Col,File ID,Sample Name,Label,Status,Gate Count,Gate % Parent\n")
        for w in table.wells:
            buf.write(f"{w.well_id},{w.row},{w.col},{w.file_id or ''},{w.sample_name or ''},{w.label or ''},{w.load_status},{w.gate_count:.0f},{w.gate_pct:.2f}\n")
        filename = f"plate_wells_{body.plate_id}.csv"

    elif body.table_type == "population":
        if not body.gate_id:
            raise HTTPException(400, "gate_id required for population export")
        table = await get_population_stats_table(body.gate_id)
        buf.write(f"# Gate: {table.gate_name} | Count: {table.count} | % Parent: {table.pct_of_parent:.2f}% | % Total: {table.pct_of_total:.2f}%\n")
        buf.write("Channel,MFI,Median,SD,CV%,Geo Mean\n")
        for row in table.rows:
            buf.write(f"{row.display_name},{row.mfi:.2f},{row.median:.2f},{row.sd:.2f},{row.cv_pct:.2f},{row.geo_mean:.2f}\n")
        filename = f"population_{body.gate_id}.csv"

    else:
        raise HTTPException(400, f"Unknown table_type: {body.table_type!r}")

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─── helpers ─────────────────────────────────────────────────────────────────

def _find_gate_by_name(gates, name: str):
    """Depth-first search for a gate by name (case-insensitive)."""
    for g in gates:
        if g.name.lower() == name.lower():
            return g
        found = _find_gate_by_name(g.children, name)
        if found:
            return found
    return None


def _collect_gate_names(gates, result: set) -> None:
    for g in gates:
        result.add(g.name)
        _collect_gate_names(g.children, result)
