from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class FileLoadRequest(BaseModel):
  """Request body for /api/files/load."""

  paths: List[str] = Field(..., description="Absolute or workspace-relative FCS file paths")
  downsample_events: int = Field(
    50_000,
    ge=1,
    description="Target number of events to return for visualization (server may return fewer)",
  )


class ChannelMetadata(BaseModel):
  """Per-channel metadata derived from the FCS TEXT segment.

  `name` (from $PnN) is the stable API contract key. `display_name` is for UI only.
  """

  name: str = Field(..., description="$PnN – raw instrument name; API contract key")
  index: int = Field(..., description="1-based channel index (Pn)")
  stain: Optional[str] = Field(None, description="$PnS – reagent / marker name; None if absent or duplicate of name")
  display_name: str = Field(
    "",
    description="Human-readable label, e.g. 'FL1-A :: CD19' or 'FSC-A' when no stain",
  )
  range: Optional[float] = Field(None, description="$PnR – detector range; used as logicle T when present")
  amplification: Optional[str] = Field(None, description="$PnE – amplification / gain string")


class FileMetadata(BaseModel):
  """Public FCS file metadata used throughout the backend."""

  id: str
  path: str
  sample_name: Optional[str] = None
  event_count: int
  channels: List[ChannelMetadata]

  # Provenance (informational only; not used in gate logic)
  instrument: Optional[str] = None
  operator: Optional[str] = None
  acquisition_datetime: Optional[str] = None
  comment: Optional[str] = None

  # Raw spillover string from $SPILLOVER / $SPILL; parsed by the compensation service.
  spillover_str: Optional[str] = None

  # Backwards-compatible matrix field for existing callers; prefer spillover_str going forward.
  spillover: Optional[List[List[float]]] = Field(
    None,
    description="(Legacy) spillover matrix; prefer spillover_str + compensation.parse_spillover_from_metadata.",
  )


class FileLoadResponse(BaseModel):
  files: List[FileMetadata]


class FileEventsResponse(BaseModel):
  file_id: str
  channel_names: List[str]
  events: List[List[float]]


class FileDensityResponse(BaseModel):
  """2D density histogram for a pair of channels."""

  file_id: str
  x_channel: str
  y_channel: str
  transform_x: Optional[str] = None
  transform_y: Optional[str] = None
  x_min: float
  x_max: float
  y_min: float
  y_max: float
  bins_x: int
  bins_y: int
  counts: List[List[float]]


class CompensationApplyRequest(BaseModel):
  file_id: str = Field(..., description="ID of the file to compensate")
  spillover: List[List[float]] = Field(
    ...,
    description="Square spillover (compensation) matrix in channel order",
  )


class CompensationApplyResponse(BaseModel):
  file_id: str
  n_channels: int
  cond: Optional[float] = Field(
    None,
    description="Condition number of the spillover matrix. <10 = well-conditioned, >100 = poorly-conditioned.",
  )


class CompensationStatusResponse(BaseModel):
  file_id: str
  is_compensated: bool
  n_channels: int
  cond: Optional[float] = None


