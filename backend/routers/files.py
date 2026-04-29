from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query

from models.file_models import (
  FileDensityResponse,
  FileEventsResponse,
  FileHistogramResponse,
  FileLoadRequest,
  FileLoadResponse,
  FileMetadata,
)
from models.gate_models import GateResponse
from services import fcs_parser, gates as gates_service, storage, transforms as transform_service
import numpy as np


router = APIRouter(prefix="/api/files", tags=["files"])
MAX_FILES_PER_LOAD = 64

_LOGICLE_T_DEFAULT = 262144.0
_LOGICLE_W_DEFAULT = 0.5
_LOGICLE_M_DEFAULT = 4.5
_LOGICLE_A_DEFAULT = 0.0


def _resolve_logicle_t(t_param: Optional[float], channel_range: Optional[float]) -> float:
  """Return effective logicle T: explicit query param → $PnR channel range → 262144 fallback."""
  if t_param is not None:
    return float(t_param)
  if channel_range is not None:
    return float(channel_range)
  return _LOGICLE_T_DEFAULT


def _build_logicle_kwargs(
  t: float,
  w: Optional[float],
  m: Optional[float],
  a: Optional[float],
) -> dict:
  return {
    "logicle_t": t,
    "logicle_w": w if w is not None else _LOGICLE_W_DEFAULT,
    "logicle_m": m if m is not None else _LOGICLE_M_DEFAULT,
    "logicle_a": a if a is not None else _LOGICLE_A_DEFAULT,
  }
MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_LOAD_BYTES = 8 * 1024 * 1024 * 1024
MAX_PATH_CHARS = 4096
ALLOWED_EXTENSIONS = {".fcs"}


def _validated_load_paths(paths: List[str]) -> List[str]:
  if not paths:
    raise HTTPException(status_code=400, detail="No file paths provided")
  if len(paths) > MAX_FILES_PER_LOAD:
    raise HTTPException(status_code=413, detail=f"Too many files requested (max {MAX_FILES_PER_LOAD})")

  validated: List[str] = []
  total_bytes = 0
  for raw in paths:
    path_str = str(raw or "").strip()
    if not path_str:
      raise HTTPException(status_code=400, detail="Empty file path in request")
    if len(path_str) > MAX_PATH_CHARS:
      raise HTTPException(status_code=400, detail="File path is too long")

    resolved = Path(path_str).expanduser()
    try:
      resolved = resolved.resolve(strict=True)
    except FileNotFoundError as exc:
      raise HTTPException(status_code=404, detail=f"File not found: {path_str}") from exc
    except OSError as exc:
      raise HTTPException(status_code=400, detail=f"Invalid file path: {path_str}") from exc

    if not resolved.is_file():
      raise HTTPException(status_code=400, detail=f"Path is not a file: {resolved}")
    if resolved.suffix.lower() not in ALLOWED_EXTENSIONS:
      raise HTTPException(status_code=400, detail=f"Unsupported file type: {resolved.suffix or '(none)'}")

    size_bytes = resolved.stat().st_size
    if size_bytes <= 0:
      raise HTTPException(status_code=400, detail=f"File is empty: {resolved.name}")
    if size_bytes > MAX_SINGLE_FILE_BYTES:
      raise HTTPException(status_code=413, detail=f"File too large: {resolved.name}")
    total_bytes += size_bytes
    if total_bytes > MAX_TOTAL_LOAD_BYTES:
      raise HTTPException(status_code=413, detail="Total upload size exceeds limit")

    validated.append(str(resolved))
  return validated


@router.post("/load", response_model=FileLoadResponse)
async def load_files(body: FileLoadRequest) -> FileLoadResponse:
  """Load one or more FCS files and return their metadata."""
  try:
    files: List[FileMetadata] = fcs_parser.load_and_register_files(_validated_load_paths(body.paths))
  except FileNotFoundError as exc:
    raise HTTPException(status_code=404, detail=f"File not found: {exc}") from exc
  except HTTPException:
    raise
  except Exception as exc:  # surface parse/validation errors to the client for now
    raise HTTPException(status_code=500, detail=f"load_files error: {exc!r}") from exc

  return FileLoadResponse(files=files)


@router.get("/{file_id}/gates", response_model=List[GateResponse])
async def get_file_gates(file_id: str) -> List[GateResponse]:
  """Return gate tree for a file (root-level nodes with nested children)."""
  try:
    return gates_service.get_gate_tree(file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{file_id}/gates")
async def delete_file_gates(file_id: str) -> dict:
  """Clear all gates for a file (e.g. on compensation reset or re-load)."""
  try:
    storage.get_file_metadata(file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  gates_service.delete_all_gates_for_file(file_id)
  return {"status": "deleted", "file_id": file_id, "gates_cleared": True}


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
  logicle_t: Optional[float] = Query(None, description="Logicle T (max scale). Defaults to $PnR when absent."),
  logicle_w: Optional[float] = Query(None, description="Logicle W (linear width). Default 0.5."),
  logicle_m: Optional[float] = Query(None, description="Logicle M (decades). Default 4.5."),
  logicle_a: Optional[float] = Query(None, description="Logicle A (additional negative). Default 0.0."),
) -> FileEventsResponse:
  """Return downsampled events for a loaded file.

  If x_channel and/or y_channel are provided, only those channels are returned.
  Optional transform_x/transform_y apply per-axis transforms before returning.

  For logicle transforms, T defaults to $PnR (detector range) of the respective channel
  when logicle_t is not supplied, falling back to 262144 if $PnR is absent.
  """
  try:
    metadata = storage.get_file_metadata(file_id)
    events = storage.get_file_events_downsampled(file_id, max_events=max_events)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f"events error: {exc!r}") from exc

  # Determine which channel columns to return
  channel_by_name = {ch.name: ch for ch in metadata.channels}
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

  # Per-axis transforms — logicle T is resolved per-channel from $PnR when not supplied
  base_kwargs = {"arcsinh_cofactor": arcsinh_cofactor}
  if sub_events.shape[1] >= 1 and transform_x and transform_x in transform_service.TRANSFORMS:
    if transform_x == "logicle":
      ch_meta = channel_by_name.get(x_channel or "") if x_channel else None
      t = _resolve_logicle_t(logicle_t, ch_meta.range if ch_meta else None)
      kw = {**base_kwargs, **_build_logicle_kwargs(t, logicle_w, logicle_m, logicle_a)}
    else:
      kw = base_kwargs
    sub_events[:, 0] = transform_service.apply_transform(sub_events[:, 0], transform_x, **kw)
  if sub_events.shape[1] >= 2 and transform_y and transform_y in transform_service.TRANSFORMS:
    if transform_y == "logicle":
      ch_meta = channel_by_name.get(y_channel or "") if y_channel else None
      t = _resolve_logicle_t(logicle_t, ch_meta.range if ch_meta else None)
      kw = {**base_kwargs, **_build_logicle_kwargs(t, logicle_w, logicle_m, logicle_a)}
    else:
      kw = base_kwargs
    sub_events[:, 1] = transform_service.apply_transform(sub_events[:, 1], transform_y, **kw)

  try:
    events_list = sub_events.astype(float).tolist()
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f"serialize events: {exc!r}") from exc

  return FileEventsResponse(file_id=file_id, channel_names=channel_names, events=events_list)


@router.get("/{file_id}/density", response_model=FileDensityResponse)
async def get_density(
  file_id: str,
  x_channel: str = Query(..., description="Channel name for X axis"),
  y_channel: str = Query(..., description="Channel name for Y axis"),
  bins_x: int = Query(200, ge=10, le=512, description="Number of bins along X"),
  bins_y: int = Query(200, ge=10, le=512, description="Number of bins along Y"),
  max_events: int = Query(
    200_000,
    ge=1,
    le=1_000_000,
    description="Maximum events to use when computing density (random downsample for very large files)",
  ),
  transform_x: Optional[str] = Query(None, description="linear | log | arcsinh | logicle"),
  transform_y: Optional[str] = Query(None, description="linear | log | arcsinh | logicle"),
  arcsinh_cofactor: float = Query(
    150.0,
    description="Cofactor for arcsinh (e.g. 150 fluo, 5 CyTOF). Only used when transform_* == 'arcsinh'.",
  ),
  logicle_t: Optional[float] = Query(None, description="Logicle T (max scale). Defaults to $PnR when absent."),
  logicle_w: Optional[float] = Query(None, description="Logicle W (linear width). Default 0.5."),
  logicle_m: Optional[float] = Query(None, description="Logicle M (decades). Default 4.5."),
  logicle_a: Optional[float] = Query(None, description="Logicle A (additional negative). Default 0.0."),
) -> FileDensityResponse:
  """Return a 2D density histogram for a pair of channels.

  The histogram is computed in the **transformed** space (after applying any requested
  per-axis transforms) so that gate coordinates and overlays align with the axes.

  For logicle transforms, T defaults to $PnR of the respective channel when logicle_t
  is not supplied, falling back to 262144 when $PnR is absent.
  """
  try:
    metadata = storage.get_file_metadata(file_id)
    events = storage.get_file_events_downsampled(file_id, max_events=max_events)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f"density error: {exc!r}") from exc

  # Resolve channel indices
  channel_by_name = {ch.name: ch for ch in metadata.channels}
  try:
    ch_x = channel_by_name[x_channel]
    ch_y = channel_by_name[y_channel]
  except KeyError:
    raise HTTPException(status_code=400, detail="Requested channel(s) not found")

  x = events[:, ch_x.index - 1].astype(float)
  y = events[:, ch_y.index - 1].astype(float)

  # Per-axis transforms — logicle T resolved per-channel from $PnR when not supplied
  base_kwargs = {"arcsinh_cofactor": arcsinh_cofactor}
  if transform_x and transform_x in transform_service.TRANSFORMS:
    if transform_x == "logicle":
      t = _resolve_logicle_t(logicle_t, ch_x.range)
      kw = {**base_kwargs, **_build_logicle_kwargs(t, logicle_w, logicle_m, logicle_a)}
    else:
      kw = base_kwargs
    x = transform_service.apply_transform(x, transform_x, **kw)
  if transform_y and transform_y in transform_service.TRANSFORMS:
    if transform_y == "logicle":
      t = _resolve_logicle_t(logicle_t, ch_y.range)
      kw = {**base_kwargs, **_build_logicle_kwargs(t, logicle_w, logicle_m, logicle_a)}
    else:
      kw = base_kwargs
    y = transform_service.apply_transform(y, transform_y, **kw)

  # Compute axis ranges in transformed space; expand degenerate ranges slightly
  x_min = float(np.min(x))
  x_max = float(np.max(x))
  y_min = float(np.min(y))
  y_max = float(np.max(y))

  if x_max == x_min:
    delta = 1.0 if x_min == 0 else abs(x_min) * 0.01
    x_min -= delta
    x_max += delta
  if y_max == y_min:
    delta = 1.0 if y_min == 0 else abs(y_min) * 0.01
    y_min -= delta
    y_max += delta

  # 2D histogram; note that numpy.histogram2d expects (x, y) but we pass (y, x)
  # so that the resulting array is indexed as counts[y_bin, x_bin].
  counts, x_edges, y_edges = np.histogram2d(
    y,
    x,
    bins=(bins_y, bins_x),
    range=[[y_min, y_max], [x_min, x_max]],
  )

  # Convert to Python lists for JSON serialisation (rows = y bins from low→high).
  counts_list = counts.tolist()

  return FileDensityResponse(
    file_id=file_id,
    x_channel=x_channel,
    y_channel=y_channel,
    transform_x=transform_x,
    transform_y=transform_y,
    x_min=x_min,
    x_max=x_max,
    y_min=y_min,
    y_max=y_max,
    bins_x=bins_x,
    bins_y=bins_y,
    counts=counts_list,
  )


@router.get("/{file_id}/histogram", response_model=FileHistogramResponse)
async def get_histogram(
  file_id: str,
  channel: str = Query(..., description="Channel name ($PnN)"),
  bins: int = Query(256, ge=16, le=1024, description="Number of histogram bins"),
  transform: Optional[str] = Query(None, description="linear | log | arcsinh | logicle"),
  arcsinh_cofactor: float = Query(150.0, description="Cofactor for arcsinh transform"),
  logicle_t: Optional[float] = Query(None, description="Logicle T. Defaults to $PnR."),
  logicle_w: Optional[float] = Query(None, description="Logicle W. Default 0.5."),
  logicle_m: Optional[float] = Query(None, description="Logicle M. Default 4.5."),
  logicle_a: Optional[float] = Query(None, description="Logicle A. Default 0.0."),
  gate_id: Optional[str] = Query(None, description="Restrict to events inside this gate (optional)"),
  max_events: int = Query(500_000, ge=1, le=2_000_000),
) -> FileHistogramResponse:
  """Return a 1-D histogram for a single channel in transformed space.

  Optionally restricted to a gate population via ``gate_id``.
  ``bin_edges`` has n+1 values; ``counts`` has n values.
  """
  try:
    metadata = storage.get_file_metadata(file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc

  channel_by_name = {ch.name: ch for ch in metadata.channels}
  ch_meta = channel_by_name.get(channel)
  if ch_meta is None:
    raise HTTPException(status_code=400, detail=f"Channel {channel!r} not found")

  # Resolve events (full or gate-masked)
  try:
    if gate_id:
      from services.gates import _store, _get_mask  # pylint: disable=import-outside-toplevel
      record = _store.gates_by_id.get(gate_id)
      if record is None:
        raise HTTPException(status_code=404, detail=f"Gate {gate_id!r} not found")
      all_events = storage.get_file_events(file_id)
      mask = _get_mask(record)
      events_raw = all_events[mask]
    else:
      events_raw = storage.get_file_events_downsampled(file_id, max_events=max_events)
  except HTTPException:
    raise
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f"histogram events error: {exc!r}") from exc

  col_idx = ch_meta.index - 1
  col = events_raw[:, col_idx].astype(float)

  # Resolve transform
  tx = transform if transform and transform in transform_service.TRANSFORMS else "linear"
  base_kwargs: dict = {"arcsinh_cofactor": arcsinh_cofactor}
  if tx == "logicle":
    t = _resolve_logicle_t(logicle_t, ch_meta.range)
    kw = {**base_kwargs, **_build_logicle_kwargs(t, logicle_w, logicle_m, logicle_a)}
  else:
    kw = base_kwargs
  col = transform_service.apply_transform(col, tx, **kw)

  # Filter out NaN/inf from transform
  finite = col[np.isfinite(col)]
  if finite.size == 0:
    return FileHistogramResponse(
      file_id=file_id, channel=channel, transform=tx,
      bin_edges=[0.0, 1.0], counts=[0],
      x_min=0.0, x_max=1.0,
    )

  x_min = float(np.min(finite))
  x_max = float(np.max(finite))
  if x_max == x_min:
    delta = max(1.0, abs(x_min) * 0.01)
    x_min -= delta
    x_max += delta

  counts_arr, edges = np.histogram(finite, bins=bins, range=(x_min, x_max))

  return FileHistogramResponse(
    file_id=file_id,
    channel=channel,
    transform=tx,
    bin_edges=[float(e) for e in edges],
    counts=[int(c) for c in counts_arr],
    x_min=x_min,
    x_max=x_max,
  )


@router.delete("/{file_id}")
async def delete_file(file_id: str) -> dict:
  """Evict a file from the in-memory cache."""
  try:
    storage.delete_file(file_id)
  except KeyError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc
  return {"status": "deleted", "file_id": file_id}


@router.get("/cache/status")
async def cache_status() -> dict:
  """Return basic cache usage information."""
  return storage.get_cache_status()

