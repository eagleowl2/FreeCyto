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
  index: int = Field(..., description="1-based channel index (Pn)")
  name: str = Field(..., description="$PnN - short channel name")
  stain: Optional[str] = Field(None, description="$PnS - fluorochrome / marker name")
  range: Optional[float] = Field(None, description="$PnR - detector range")
  amplification: Optional[str] = Field(None, description="$PnE - amplification")


class FileMetadata(BaseModel):
  id: str
  path: str
  sample_name: Optional[str] = None
  instrument: Optional[str] = None
  operator: Optional[str] = None
  acquisition_datetime: Optional[str] = None
  event_count: int
  channels: List[ChannelMetadata]


class FileLoadResponse(BaseModel):
  files: List[FileMetadata]


class FileEventsResponse(BaseModel):
  file_id: str
  channel_names: List[str]
  events: List[List[float]]


class CompensationApplyRequest(BaseModel):
  file_id: str = Field(..., description="ID of the file to compensate")
  spillover: List[List[float]] = Field(
    ...,
    description="Square spillover (compensation) matrix in channel order",
  )


class CompensationApplyResponse(BaseModel):
  file_id: str
  n_channels: int


