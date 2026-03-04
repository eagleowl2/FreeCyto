from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query

from models.file_models import (
  FileEventsResponse,
  FileLoadRequest,
  FileLoadResponse,
  FileMetadata,
)
from services import fcs_parser, storage, transforms as transform_service


router = APIRouter(prefix="/api/files", tags=["files"])


@router.post("/load", response_model=FileLoadResponse)
async def load_files(body: FileLoadRequest) -> FileLoadResponse:
  """Load one or more FCS files and return their metadata."""
  try:
    files: List[FileMetadata] = fcs_parser.load_and_register_files(body.paths)
  except FileNotFoundError as exc:
    raise HTTPException(status_code=404, detail=f"File not found: {exc}") from exc
  except Exception as exc:  # surface parse/validation errors to the client for now
    raise HTTPException(status_code=500, detail=f"load_files error: {exc!r}") from exc

  return FileLoadResponse(files=files)


@router.get("/{file_id}/channels", response_model=FileMetadata)
async def get_channels(file_id: str) -> FileMetadata:
  """Return full metadata (including channels) for a loaded file."""
  try:
    metadata = storage.get_file_metadata(file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  return metadata


@router.get("/{file_id}/events", response_model=FileEventsResponse)
async def get_events(
  file_id: str,
  max_events: int = Query(50_000, ge=1, le=500_000),
  x_channel: Optional[str] = None,
  y_channel: Optional[str] = None,
  transform_x: Optional[str] = Query(None, description="linear | log | arcsinh | logicle"),
  transform_y: Optional[str] = Query(None, description="linear | log | arcsinh | logicle"),
  arcsinh_cofactor: float = Query(150.0, description="Cofactor for arcsinh (e.g. 150 fluo, 5 CyTOF)"),
) -> FileEventsResponse:
  """Return downsampled events for a loaded file.

  If x_channel and/or y_channel are provided, only those channels are returned.
  Optional transform_x/transform_y apply per-axis transforms before returning.
  """
  try:
    metadata = storage.get_file_metadata(file_id)
    events = storage.get_file_events_downsampled(file_id, max_events=max_events)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f"events error: {exc!r}") from exc

  # Determine which channel columns to return
  channel_order = metadata.channels
  if x_channel or y_channel:
    wanted = [name for name in (x_channel, y_channel) if name]
    indices: List[int] = []
    names: List[str] = []
    for ch in channel_order:
      if ch.name in wanted:
        indices.append(ch.index - 1)
        names.append(ch.name)
    if not indices:
      raise HTTPException(status_code=400, detail="Requested channel(s) not found")
    sub_events = events[:, indices].copy()
    channel_names = names
  else:
    sub_events = events.copy()
    channel_names = [ch.name for ch in channel_order]

  # Apply per-column transforms when exactly two columns (x and y)
  kwargs = {"arcsinh_cofactor": arcsinh_cofactor}
  if sub_events.shape[1] >= 1 and transform_x and transform_x in transform_service.TRANSFORMS:
    sub_events[:, 0] = transform_service.apply_transform(
      sub_events[:, 0], transform_x, **kwargs
    )
  if sub_events.shape[1] >= 2 and transform_y and transform_y in transform_service.TRANSFORMS:
    sub_events[:, 1] = transform_service.apply_transform(
      sub_events[:, 1], transform_y, **kwargs
    )

  try:
    events_list = sub_events.astype(float).tolist()
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f"serialize events: {exc!r}") from exc

  return FileEventsResponse(file_id=file_id, channel_names=channel_names, events=events_list)


