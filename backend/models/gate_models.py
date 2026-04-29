"""Gate models. All coordinates in TRANSFORMED space (same units as plot axes).
Transform type and parameters are stored with each gate so coordinates can be
interpreted at evaluation and workspace reload."""

from __future__ import annotations

from typing import Annotated, List, Literal, Optional

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


class IntervalGateCreate(BaseModel):
  """1-D range gate on a single channel (histogram interval). y_channel is unused."""
  type: Literal["interval"]
  x_min: float
  x_max: float


class BooleanGateCreate(BaseModel):
  """Boolean combination of existing gates (AND / OR / NOT).

  ``expression`` uses gate names as operands and ``AND``, ``OR``, ``NOT`` as operators.
  Parentheses are supported.  Gate names with special characters must be backtick-quoted.

  Examples::
      "Lymphocytes AND NOT dead_cells"
      "`CD4+` OR `CD8+`"
      "(Singlets AND Lymphocytes) AND NOT debris"
  """
  type: Literal["boolean"]
  expression: str = Field(..., min_length=1, description="Boolean expression over gate names")


class EllipseGateCreate(BaseModel):
  """Ellipse gate in transformed channel space.

  The ellipse is defined by its centre, semi-axes, and an optional CCW rotation angle.
  All coordinates are in the same transformed space as the plot axes.
  """
  type: Literal["ellipse"]
  center_x: float = Field(..., description="X coordinate of ellipse centre (transformed space)")
  center_y: float = Field(..., description="Y coordinate of ellipse centre (transformed space)")
  radius_x: float = Field(..., gt=0.0, description="Semi-axis length along X before rotation")
  radius_y: float = Field(..., gt=0.0, description="Semi-axis length along Y before rotation")
  angle: float = Field(0.0, description="CCW rotation angle in degrees")


GateParamsCreate = Annotated[
  RectangleGateCreate | PolygonGateCreate | IntervalGateCreate | BooleanGateCreate | EllipseGateCreate,
  Field(discriminator="type"),
]


class GateCreateRequest(BaseModel):
  """Create a gate. Coordinates in transformed space (same as plot view)."""
  file_id: str
  name: str = Field(..., min_length=1, description="Display name for the gate")
  x_channel: str = Field("", description="Channel name for X axis (empty for boolean gates)")
  y_channel: str = Field("", description="Channel name for Y axis (empty string for interval/boolean gates)")
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
  expression: str | None = Field(None, description="Boolean expression (type='boolean' only)")
  # N: ellipse gate geometry
  center_x: float | None = None
  center_y: float | None = None
  radius_x: float | None = None
  radius_y: float | None = None
  angle: float = 0.0
  count: int = 0
  pct_total: float = 0.0
  pct_of_parent: float = 0.0
  pct_of_total: float = 0.0
  parent_count: int = 0
  children: List["GateResponse"] = Field(default_factory=list)

  # pct_total kept as field alias for FE transition; same value as pct_of_total (A-5).
  model_config = ConfigDict()


class GateUpdateRequest(BaseModel):
  """Update gate geometry in-place. Coordinates in transformed space (same as plot view).
  Provide x_min/y_min/x_max/y_max for rectangle gates, vertices for polygon gates,
  center_x/center_y/radius_x/radius_y/angle for ellipse gates."""
  x_min: float | None = None
  y_min: float | None = None
  x_max: float | None = None
  y_max: float | None = None
  vertices: List[List[float]] | None = None
  # N: ellipse gate update fields
  center_x: float | None = None
  center_y: float | None = None
  radius_x: float | None = None
  radius_y: float | None = None
  angle: float | None = None


class ChannelStats(BaseModel):
  """Per-channel descriptive statistics for a gate population (raw, untransformed space)."""
  channel_name: str = Field(..., description="$PnN – API contract key")
  display_name: str = Field("", description="Human-readable label for the UI")
  mean: float = Field(..., description="Arithmetic mean (MFI) of raw values inside the gate")
  median: float = Field(..., description="Median of raw values inside the gate")
  sd: float = Field(..., description="Sample standard deviation of raw values inside the gate")
  cv: Optional[float] = Field(None, description="CV% = sd/mean*100; None when mean ≤ 0")


class GateStatsResponse(BaseModel):
  """Per-channel statistics for a gate population."""
  gate_id: str
  file_id: str
  gate_name: str
  count: int
  pct_of_parent: float
  pct_total: float
  channel_stats: List[ChannelStats] = Field(default_factory=list)
