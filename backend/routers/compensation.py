from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException

from models.file_models import (
  CompensationApplyRequest,
  CompensationApplyResponse,
  CompensationStatusResponse,
  SpilloverParseResponse,
)
from services import compensation as compensation_service, gates as gates_service, storage


router = APIRouter(prefix="/api/compensation", tags=["compensation"])


@router.get("/spillover/{file_id}", response_model=SpilloverParseResponse)
async def get_spillover(file_id: str) -> SpilloverParseResponse:
  """Parse and return the $SPILLOVER / $SPILL matrix embedded in the file's FCS header."""
  try:
    meta = storage.get_file_metadata(file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc

  raw = meta.spillover_str or ""
  result = compensation_service.parse_spillover_string(raw)
  if result is None:
    raise HTTPException(
      status_code=404,
      detail=f"No valid $SPILLOVER / $SPILL keyword found in file {file_id!r}.",
    )

  channel_names, matrix = result
  cond = float(np.linalg.cond(matrix))
  return SpilloverParseResponse(
    file_id=file_id,
    channel_names=channel_names,
    matrix=matrix.tolist(),
    cond=cond,
  )


@router.post("/apply", response_model=CompensationApplyResponse)
async def apply_compensation(body: CompensationApplyRequest) -> CompensationApplyResponse:
  """Apply a spillover (compensation) matrix to a file's events."""
  # Validate file exists up front for a clearer error
  try:
    metadata = storage.get_file_metadata(body.file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc

  try:
    cond = compensation_service.apply_compensation(
      body.file_id,
      body.spillover,
      channel_names=body.channel_names,
    )
  except (ValueError, NotImplementedError) as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f"compensation error: {exc!r}") from exc

  return CompensationApplyResponse(
    file_id=body.file_id,
    n_channels=len(metadata.channels),
    cond=cond,
  )


@router.delete("/{file_id}")
async def reset_compensation(file_id: str) -> CompensationStatusResponse:
  """Reset a file to its raw (uncompensated) events."""
  try:
    storage.clear_compensation(file_id)
    gates_service.invalidate_file_caches(file_id)
    status = storage.get_compensation_status(file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  return CompensationStatusResponse(**status)


@router.get("/status/{file_id}", response_model=CompensationStatusResponse)
async def compensation_status(file_id: str) -> CompensationStatusResponse:
  """Return compensation status for a file."""
  try:
    status = storage.get_compensation_status(file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  return CompensationStatusResponse(**status)


