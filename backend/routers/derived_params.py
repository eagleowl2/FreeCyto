from __future__ import annotations

from fastapi import APIRouter, HTTPException

from models.derived_param_models import DerivedParamCreate, DerivedParamResponse
from services import derived_params as dp_service, storage

router = APIRouter(prefix="/api/derived-params", tags=["derived-params"])


@router.get("/{file_id}", response_model=list[DerivedParamResponse])
async def list_derived_params(file_id: str) -> list[DerivedParamResponse]:
  """List all derived parameters for a file."""
  try:
    storage.get_file_metadata(file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  return dp_service.list_derived_params(file_id)


@router.post("/{file_id}", response_model=DerivedParamResponse, status_code=201)
async def create_derived_param(file_id: str, body: DerivedParamCreate) -> DerivedParamResponse:
  """Create a formula-based virtual channel for a file."""
  if body.file_id != file_id:
    raise HTTPException(status_code=400, detail="body.file_id does not match URL file_id")
  try:
    return dp_service.create_derived_param(body)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except ValueError as exc:
    raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/{file_id}/{param_id}", status_code=204)
async def delete_derived_param(file_id: str, param_id: str) -> None:
  """Delete a derived parameter."""
  try:
    dp_service.delete_derived_param(file_id, param_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
