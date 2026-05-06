"""Plate layout API endpoints (P-1: Plate/Batch Processing).

Provides CRUD for plate layouts and per-well gate statistics aggregation.
Each plate maps well positions (e.g. "A1") to loaded FCS file IDs.

Endpoints:
  POST   /api/plates                     — create plate
  GET    /api/plates                     — list all plates
  GET    /api/plates/{plate_id}          — get plate with wells
  DELETE /api/plates/{plate_id}          — delete plate
  POST   /api/plates/{plate_id}/wells    — assign file(s) to well(s)
  GET    /api/plates/{plate_id}/stats    — gate stats across all wells
"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from models.plate_models import (
    PlateAssignWellRequest,
    PlateCreateRequest,
    PlateResponse,
    PlateStatsResponse,
)
from services import plate_service


router = APIRouter(prefix="/api/plates", tags=["plates"])


class BulkWellAssignment(BaseModel):
    well_id: str
    file_id: str | None = None
    label: str | None = None


class BulkAssignRequest(BaseModel):
    assignments: List[BulkWellAssignment]


@router.post("", response_model=PlateResponse)
async def create_plate(body: PlateCreateRequest) -> PlateResponse:
    """Create a new plate layout (96-well, 48-well, etc.)."""
    try:
        return plate_service.create_plate(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("", response_model=List[PlateResponse])
async def list_plates() -> List[PlateResponse]:
    """List all plate layouts."""
    return plate_service.list_plates()


@router.get("/{plate_id}", response_model=PlateResponse)
async def get_plate(plate_id: str) -> PlateResponse:
    """Get a plate layout with all well assignments."""
    try:
        return plate_service.get_plate(plate_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{plate_id}")
async def delete_plate(plate_id: str) -> dict:
    """Delete a plate layout."""
    try:
        plate_service.delete_plate(plate_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"status": "deleted", "plate_id": plate_id}


@router.post("/{plate_id}/wells", response_model=PlateResponse)
async def assign_wells(plate_id: str, body: BulkAssignRequest) -> PlateResponse:
    """Assign FCS files to wells (bulk operation).

    Send a list of ``{ well_id, file_id, label }`` objects.  Omit ``file_id``
    or set it to ``null`` to clear a well.
    """
    try:
        assignments = [a.model_dump() for a in body.assignments]
        return plate_service.bulk_assign_wells(plate_id, assignments)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{plate_id}/wells/{well_id}", response_model=PlateResponse)
async def assign_single_well(
    plate_id: str,
    well_id: str,
    body: PlateAssignWellRequest,
) -> PlateResponse:
    """Assign a single FCS file to one well."""
    body_with_well = PlateAssignWellRequest(
        well_id=well_id,
        file_id=body.file_id,
        label=body.label,
    )
    try:
        return plate_service.assign_well(plate_id, body_with_well)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{plate_id}/stats", response_model=PlateStatsResponse)
async def get_plate_stats(
    plate_id: str,
    gate_name: str = Query(..., description="Gate name to aggregate across wells"),
) -> PlateStatsResponse:
    """Compute gate event counts and percentages for every well in the plate.

    Returns a grid of count/pct values that can be displayed as a heat-map.
    Wells without an assigned file return zeroes.
    """
    try:
        return plate_service.get_plate_stats(plate_id, gate_name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
