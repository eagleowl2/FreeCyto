"""Workspace save/load schema."""

from __future__ import annotations

from typing import Any, Dict, List

from pydantic import BaseModel, Field


class WorkspaceFileEntry(BaseModel):
  path: str
  id: str | None = None  # stable file id (for reference after load)
  n_channels: int | None = Field(
    default=None,
    ge=1,
    description="Channel count when saving (e.g. synthetic reload); omit for legacy v1 saves.",
  )


class WorkspaceGateDef(BaseModel):
  """Gate definition for restore (no id)."""
  file_id: str
  name: str
  type: str
  x_channel: str
  y_channel: str
  transform_x: str = "linear"
  transform_y: str = "linear"
  arcsinh_cofactor: float = 150.0
  logicle_T: float = 262144.0
  logicle_W: float = 0.5
  logicle_M: float = 4.5
  logicle_A: float = 0.0
  parent_gate_id: str | None = None
  order: int = 0
  original_id: str | None = None  # gate id at save time, for id_map on load
  x_min: float | None = None
  y_min: float | None = None
  x_max: float | None = None
  y_max: float | None = None
  vertices: List[List[float]] | None = None
  expression: str | None = None  # for boolean gates
  # N: ellipse gate geometry
  center_x: float | None = None
  center_y: float | None = None
  radius_x: float | None = None
  radius_y: float | None = None
  angle: float = 0.0
  # V: quad gate crosshair
  x_threshold: float | None = None
  y_threshold: float | None = None


class WorkspaceSave(BaseModel):
  version: int = 2
  files: List[WorkspaceFileEntry] = Field(default_factory=list)
  compensation: Dict[str, List[List[float]]] = Field(
    default_factory=dict,
    description="file_id -> spillover matrix",
  )
  gates: List[WorkspaceGateDef] = Field(default_factory=list)
  default_axes: Dict[str, Dict[str, Any]] = Field(
    default_factory=dict,
    description="file_id -> { x_channel, y_channel, transform_x, transform_y }",
  )


class WorkspaceLoadResult(BaseModel):
  """Result of loading a workspace."""
  files_loaded: int
  compensation_applied: int
  gates_created: int
  gate_errors: List[str] = Field(
    default_factory=list,
    description="Non-fatal gate creation failures (name, parent, channels, etc.)",
  )
  file_metadata: List[Dict[str, Any]] = Field(
    default_factory=list,
    description="FileMetadata for each loaded file (id, path, event_count, channels, spillover, etc.)",
  )
  gates: List[Dict[str, Any]] = Field(
    default_factory=list,
    description="GateResponse for each created gate",
  )
