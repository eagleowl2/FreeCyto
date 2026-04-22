"""Gate models. All coordinates in TRANSFORMED space (same units as plot axes).
Transform type and parameters are stored with each gate so coordinates can be
interpreted at evaluation and workspace reload."""

from __future__ import annotations

from typing import Annotated, List, Literal

from pydantic import BaseModel, ConfigDict, Field


class RectangleGateParams(BaseModel):
  """Bounds in transformed channel units (x_channel, y_channel)."""
  x_min: float
  y_min: float
  x_max: float
  y_max: float


class PolygonGateParams(BaseModel):
  """Vertices in transformed channel units (x_channel, y_channel)."""
  vertices: List[List[float]] = Field(..., description="List of [x, y] in transformed units")


# Discriminated union for create payload (Pydantic validates at parse time)
class RectangleGateCreate(BaseModel):
  type: Literal["rectangle"]
  x_min: float
  y_min: float
  x_max: float
  y_max: float


class PolygonGateCreate(BaseModel):
  type: Literal["polygon"]
  vertices: List[List[float]] = Field(..., min_length=3, description="At least 3 [x, y] in transformed space")


GateParamsCreate = Annotated[
  RectangleGateCreate | PolygonGateCreate,
  Field(discriminator="type"),
]


class GateCreateRequest(BaseModel):
  """Create a gate. Coordinates in transformed space (same as plot view)."""
  file_id: str
  name: str = Field(..., min_length=1, description="Display name for the gate")
  x_channel: str = Field(..., description="Channel name for X axis")
  y_channel: str = Field(..., description="Channel name for Y axis")
  parent_gate_id: str | None = Field(None, description="Parent gate id for hierarchical gating")
  order: int = Field(-1, description="Order among siblings (0-based); -1 = append at end")
  transform_x: str = "linear"
  transform_y: str = "linear"
  arcsinh_cofactor: float = 150.0
  logicle_T: float = Field(262144.0, description="Logicle T (max scale)")
  logicle_W: float = Field(0.5, description="Logicle W (linear width)")
  logicle_M: float = Field(4.5, description="Logicle M (decades)")
  logicle_A: float = Field(0.0, description="Logicle A (additional negative)")
  params: GateParamsCreate


class GateResponse(BaseModel):
  """Gate with computed count and percentages."""
  id: str
  file_id: str
  name: str
  type: str
  x_channel: str
  y_channel: str
  parent_gate_id: str | None = None
  depth: int = 0
  order: int = 0
  transform_x: str = "linear"
  transform_y: str = "linear"
  arcsinh_cofactor: float = 150.0
  logicle_T: float = 262144.0
  logicle_W: float = 0.5
  logicle_M: float = 4.5
  logicle_A: float = 0.0
  x_min: float | None = None
  y_min: float | None = None
  x_max: float | None = None
  y_max: float | None = None
  vertices: List[List[float]] | None = None
  count: int = 0
  pct_total: float = 0.0
  pct_of_parent: float = 0.0
  pct_of_total: float = 0.0
  parent_count: int = 0
  children: List["GateResponse"] = Field(default_factory=list)

  # pct_total kept as field alias for FE transition; same value as pct_of_total (A-5).
  model_config = ConfigDict()
