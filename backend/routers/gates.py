from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException, Query

from models.file_models import FileDensityResponse, FileEventsResponse
from models.gate_models import GateCreateRequest, GateResponse, GateStatsResponse
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
  """Create a gate (rectangle or polygon). Coordinates in transformed space (same as plot)."""
  try:
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
