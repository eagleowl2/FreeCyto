from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class GroupCreateRequest(BaseModel):
  name: str = Field(..., min_length=1, description="Display name for the group")
  file_ids: List[str] = Field(..., min_length=1, description="IDs of loaded files to include in this group")


class SampleInfo(BaseModel):
  file_id: str
  label: str = Field(..., description="Display name derived from filename")


class GroupResponse(BaseModel):
  id: str
  name: str
  samples: List[SampleInfo]
  template_id: Optional[str] = Field(None, description="ID of the attached gating template, if any")


class TemplateGate(BaseModel):
  """Gate definition portable across files — no file_id binding."""

  name: str
  type: str = Field(..., description="'rectangle' | 'polygon' | 'interval'")
  parent_name: Optional[str] = Field(None, description="Parent gate name; None = root level")
  x_channel: str
  y_channel: str = ""
  transform_x: str = "linear"
  transform_y: str = "linear"
  arcsinh_cofactor: float = 150.0
  logicle_T: float = 262144.0
  logicle_W: float = 0.5
  logicle_M: float = 4.5
  logicle_A: float = 0.0
  x_min: Optional[float] = None
  y_min: Optional[float] = None
  x_max: Optional[float] = None
  y_max: Optional[float] = None
  vertices: Optional[List[List[float]]] = None


class GatingTemplate(BaseModel):
  id: str
  name: str
  source_file_id: str
  gates: List[TemplateGate]


class TemplateResponse(BaseModel):
  id: str
  name: str
  source_file_id: str
  gate_count: int


class TemplateCreateRequest(BaseModel):
  source_file_id: str = Field(..., description="File ID whose gate tree becomes the template")
  template_name: str = Field(..., min_length=1, description="Human-readable name for the template")


class ApplyTemplateRequest(BaseModel):
  template_id: str = Field(..., description="ID of the template to apply to all samples in the group")


class BatchStatRow(BaseModel):
  file_id: str
  label: str
  gate_name: str
  count: int
  pct_of_parent: float
  pct_of_total: float
  parent_count: int


class BatchStatsResponse(BaseModel):
  group_id: str
  gate_name: str
  rows: List[BatchStatRow]
