from __future__ import annotations

from fastapi import APIRouter, HTTPException

from models.file_models import CompensationApplyRequest, CompensationApplyResponse
from services import compensation as compensation_service, storage


router = APIRouter(prefix="/api/compensation", tags=["compensation"])


@router.post("/apply", response_model=CompensationApplyResponse)
async def apply_compensation(body: CompensationApplyRequest) -> CompensationApplyResponse:
  """Apply a spillover (compensation) matrix to a file's events.

  For now this overwrites the stored events matrix for the file. A future
  version can preserve raw vs compensated data separately.
  """
  # Validate file exists up front for a clearer error
  try:
    metadata = storage.get_file_metadata(body.file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc

  try:
    compensation_service.apply_compensation(body.file_id, body.spillover)
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f"compensation error: {exc!r}") from exc

  return CompensationApplyResponse(file_id=body.file_id, n_channels=len(metadata.channels))

