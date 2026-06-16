from __future__ import annotations

import io
from typing import List

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from models.file_models import FileDensityResponse, FileEventsResponse
from models.gate_models import GateCreateRequest, GateResponse, GateStatsResponse, GateUpdateRequest
from services import fcs_export as fcs_export_service
from services import gates as gates_service
from services.gates import GateNameExistsError


router = APIRouter(prefix="/api/gates", tags=["gates"])


def _snapshot_session_async() -> None:
  """Best-effort workspace snapshot for session restore; never raises."""
  try:
    from services import session as session_service
    from services.workspace_service import build_workspace_save

    session_service.save_session(build_workspace_save().model_dump())
  except Exception:
    pass


@router.post("", response_model=GateResponse)
async def create_gate(body: GateCreateRequest) -> GateResponse:
  """Create a gate. Coordinates in transformed space (same as plot).

  A ``quad`` gate is created as a single node plus four child rectangle gates
  (Q1..Q4); the response carries the node with its four children populated.
  """
  try:
    if body.params.type == "quad":
      resp = gates_service.create_quad_gate(body)
    else:
      resp = gates_service.create_gate(body)
  except GateNameExistsError as exc:
    raise HTTPException(status_code=409, detail=str(exc)) from exc
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  _snapshot_session_async()
  return resp


@router.get("/files/{file_id}", response_model=List[GateResponse])
async def list_gates(file_id: str) -> List[GateResponse]:
  """Return gate tree for a file (same shape as GET /api/files/{file_id}/gates)."""
  try:
    return gates_service.get_gate_tree(file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{gate_id}/events", response_model=FileEventsResponse)
async def get_gate_events(
  gate_id: str,
  max_events: int = Query(50_000, ge=1, le=500_000),
  x_channel: str | None = Query(None),
  y_channel: str | None = Query(None),
  transform_x: str | None = Query(None, description="linear | log | arcsinh | logicle"),
  transform_y: str | None = Query(None, description="linear | log | arcsinh | logicle"),
  arcsinh_cofactor: float = Query(150.0, description="Cofactor for arcsinh"),
  logicle_t: float | None = Query(None, description="Logicle T (max scale)"),
  logicle_w: float | None = Query(None, description="Logicle W (linear width)"),
  logicle_m: float | None = Query(None, description="Logicle M (decades)"),
  logicle_a: float | None = Query(None, description="Logicle A (additional negative)"),
) -> FileEventsResponse:
  """Return downsampled events inside the gate population (mask applied to file events)."""
  try:
    file_id, channel_names, events_list = gates_service.get_gate_events(
      gate_id,
      max_events=max_events,
      x_channel=x_channel,
      y_channel=y_channel,
      transform_x=transform_x,
      transform_y=transform_y,
      arcsinh_cofactor=arcsinh_cofactor,
      logicle_t=logicle_t,
      logicle_w=logicle_w,
      logicle_m=logicle_m,
      logicle_a=logicle_a,
    )
    return FileEventsResponse(file_id=file_id, channel_names=channel_names, events=events_list)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{gate_id}/density", response_model=FileDensityResponse)
async def get_gate_density(
  gate_id: str,
  bins_x: int = Query(200, ge=10, le=512, description="Number of bins along X"),
  bins_y: int = Query(200, ge=10, le=512, description="Number of bins along Y"),
  max_events: int = Query(
    200_000,
    ge=1,
    le=1_000_000,
    description="Maximum events to use when computing density (random downsample within the gate population)",
  ),
  x_channel: str | None = Query(None),
  y_channel: str | None = Query(None),
  transform_x: str | None = Query(None, description="linear | log | arcsinh | logicle"),
  transform_y: str | None = Query(None, description="linear | log | arcsinh | logicle"),
  arcsinh_cofactor: float | None = Query(
    None,
    description="Cofactor for arcsinh (e.g. 150 fluo, 5 CyTOF). Defaults to gate's stored value.",
  ),
  logicle_t: float | None = Query(None, description="Logicle T (max scale); defaults to gate's stored value"),
  logicle_w: float | None = Query(None, description="Logicle W (linear width); defaults to gate's stored value"),
  logicle_m: float | None = Query(None, description="Logicle M (decades); defaults to gate's stored value"),
  logicle_a: float | None = Query(None, description="Logicle A (additional negative); defaults to gate's stored value"),
) -> FileDensityResponse:
  """Return a 2D density histogram for a gate population.

  Density is computed after applying the gate mask, in transformed space, so it
  aligns with both the gate geometry and the plot axes.
  """
  try:
    (
      file_id,
      x_name,
      y_name,
      tx,
      ty,
      x_min,
      x_max,
      y_min,
      y_max,
      bx,
      by,
      counts,
    ) = gates_service.get_gate_density(
      gate_id,
      bins_x=bins_x,
      bins_y=bins_y,
      max_events=max_events,
      x_channel=x_channel,
      y_channel=y_channel,
      transform_x=transform_x,
      transform_y=transform_y,
      arcsinh_cofactor=arcsinh_cofactor,
      logicle_t=logicle_t,
      logicle_w=logicle_w,
      logicle_m=logicle_m,
      logicle_a=logicle_a,
    )
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc

  return FileDensityResponse(
    file_id=file_id,
    x_channel=x_name,
    y_channel=y_name,
    transform_x=tx,
    transform_y=ty,
    x_min=x_min,
    x_max=x_max,
    y_min=y_min,
    y_max=y_max,
    bins_x=bx,
    bins_y=by,
    counts=counts,
  )


@router.get("/{gate_id}/stats", response_model=GateStatsResponse)
async def get_gate_stats(gate_id: str) -> GateStatsResponse:
  """Return per-channel descriptive statistics (MFI, median, SD, CV) for a gate's population.

  All values are in **raw (untransformed) channel space** — matching FlowJo MFI convention.
  Computed on the full unsampled population (no downsampling) for accuracy.
  """
  try:
    return gates_service.get_gate_stats(gate_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f"stats error: {exc!r}") from exc


@router.patch("/{gate_id}", response_model=GateResponse)
async def update_gate(gate_id: str, body: GateUpdateRequest) -> GateResponse:
  """Update gate geometry (bounds for rectangle, vertices for polygon). Coordinates in transformed space."""
  try:
    resp = gates_service.update_gate(gate_id, body)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
  _snapshot_session_async()
  return resp


@router.get("/{gate_id}/export-fcs")
async def export_gate_fcs(gate_id: str) -> StreamingResponse:
  """Download gated events as a minimal FCS 3.1 file.

  The exported file contains only the events that pass through this gate
  (using the same compensation state as the in-memory store).
  """
  try:
    fcs_bytes, filename = fcs_export_service.export_gate_fcs(gate_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
  safe_filename = filename.replace('"', "")
  return StreamingResponse(
    io.BytesIO(fcs_bytes),
    media_type="application/octet-stream",
    headers={"Content-Disposition": f'attachment; filename="{safe_filename}"'},
  )


@router.get("/{gate_id}/export-csv")
async def export_gate_csv(
  gate_id: str,
  max_events: int = Query(0, ge=0, description="Max events to export; 0 = no limit (full gate)"),
) -> StreamingResponse:
  """Download gated events as a CSV file.

  Columns are the raw (untransformed) channel values in display-name order.
  The first row is a header; subsequent rows are one event per line.
  """
  try:
    rows, filename, _count = gates_service.export_gate_csv_stream(gate_id, max_events=max_events)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  safe_filename = filename.replace('"', "")
  return StreamingResponse(
    rows,
    media_type="text/csv",
    headers={"Content-Disposition": f'attachment; filename="{safe_filename}"'},
  )


# R-1: Quadrant gate (FlowJo-style 4-region gate)


class QuadrantGateRequest(BaseModel):
  """Create a quadrant gate (4-region split with crosshair).

  Creates 4 rectangle gates atomically:
    Q1: top-right (x>x_split, y>y_split) - both positive
    Q2: top-left  (x<x_split, y>y_split) - x neg, y pos
    Q3: bottom-left (x<x_split, y<y_split) - both negative
    Q4: bottom-right (x>x_split, y<y_split) - x pos, y neg
  """
  file_id: str
  x_channel: str
  y_channel: str
  x_split: float = Field(..., description="X-axis crosshair position (transformed space)")
  y_split: float = Field(..., description="Y-axis crosshair position (transformed space)")
  name_prefix: str = Field("Quad", description="Gate name prefix; will create {prefix}_Q1..Q4")
  parent_gate_id: str | None = None
  transform_x: str = "linear"
  transform_y: str = "linear"
  arcsinh_cofactor: float = 150.0
  logicle_T: float = 262144.0
  logicle_W: float = 0.5
  logicle_M: float = 4.5
  logicle_A: float = 0.0
  # Bounds for the outer extent of quadrants (defaults to large range)
  x_min: float = Field(-1e10, description="Outer left bound")
  x_max: float = Field(1e10, description="Outer right bound")
  y_min: float = Field(-1e10, description="Outer bottom bound")
  y_max: float = Field(1e10, description="Outer top bound")


class QuadrantGateResponse(BaseModel):
  """Response from quadrant gate creation."""
  q1: GateResponse  # top-right
  q2: GateResponse  # top-left
  q3: GateResponse  # bottom-left
  q4: GateResponse  # bottom-right
  x_split: float
  y_split: float


@router.post("/quadrant", response_model=QuadrantGateResponse)
async def create_quadrant_gate(body: QuadrantGateRequest) -> QuadrantGateResponse:
  """Create a quadrant gate: 4 rectangle gates split by an X/Y crosshair.

  Common FlowJo-style operation for 2D plots. Returns all 4 sub-gates.
  """
  from models.gate_models import RectangleGateCreate, GateCreateRequest as GCR

  common_kwargs = dict(
    file_id=body.file_id,
    x_channel=body.x_channel,
    y_channel=body.y_channel,
    parent_gate_id=body.parent_gate_id,
    transform_x=body.transform_x,
    transform_y=body.transform_y,
    arcsinh_cofactor=body.arcsinh_cofactor,
    logicle_T=body.logicle_T,
    logicle_W=body.logicle_W,
    logicle_M=body.logicle_M,
    logicle_A=body.logicle_A,
  )

  quadrants = [
    # Q1: top-right (high X, high Y) — typically double-positive
    (f"{body.name_prefix}_Q1", body.x_split, body.y_split, body.x_max, body.y_max),
    # Q2: top-left (low X, high Y)
    (f"{body.name_prefix}_Q2", body.x_min, body.y_split, body.x_split, body.y_max),
    # Q3: bottom-left (low X, low Y) — typically double-negative
    (f"{body.name_prefix}_Q3", body.x_min, body.y_min, body.x_split, body.y_split),
    # Q4: bottom-right (high X, low Y)
    (f"{body.name_prefix}_Q4", body.x_split, body.y_min, body.x_max, body.y_split),
  ]

  created: list[GateResponse] = []
  created_ids: list[str] = []
  try:
    for (name, xmn, ymn, xmx, ymx) in quadrants:
      req = GCR(
        name=name,
        params=RectangleGateCreate(type="rectangle", x_min=xmn, y_min=ymn, x_max=xmx, y_max=ymx),
        **common_kwargs,
      )
      resp = gates_service.create_gate(req)
      created.append(resp)
      created_ids.append(resp.id)
  except GateNameExistsError as exc:
    # Roll back partial creates
    for gid in created_ids:
      try:
        gates_service.delete_gate(gid)
      except Exception:
        pass
    raise HTTPException(status_code=409, detail=str(exc)) from exc
  except (ValueError, KeyError) as exc:
    for gid in created_ids:
      try:
        gates_service.delete_gate(gid)
      except Exception:
        pass
    raise HTTPException(status_code=400, detail=str(exc)) from exc

  _snapshot_session_async()
  return QuadrantGateResponse(
    q1=created[0],
    q2=created[1],
    q3=created[2],
    q4=created[3],
    x_split=body.x_split,
    y_split=body.y_split,
  )


# Q-1: Batch gate copy


@router.post("/copy")
async def copy_gates(
  source_file_id: str = Query(..., description="File to copy gate tree from"),
  target_file_ids: list[str] = Query(..., description="Files to copy gate tree to"),
) -> dict:
  """Copy the entire gate tree from one file to one or more target files.

  Creates new gates on target files with the same parameters as the source.
  Returns counts of gates created per target file.
  """
  try:
    result = gates_service.copy_gates_between_files(source_file_id, target_file_ids)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
  _snapshot_session_async()
  return result


@router.delete("/{gate_id}")
async def delete_gate(gate_id: str) -> dict:
  """Delete a gate and all its descendants. Returns deleted_ids."""
  try:
    deleted_ids = gates_service.delete_gate(gate_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  if not deleted_ids:
    raise HTTPException(status_code=404, detail="Gate not found")
  _snapshot_session_async()
  return {"status": "deleted", "gate_id": gate_id, "deleted_ids": deleted_ids}
