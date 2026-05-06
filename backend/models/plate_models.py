"""Plate layout models.

A PlateLayout represents a multi-well plate (e.g. 96-well, 8×12) where each
well can be associated with a loaded FCS file.  Plate stats aggregate gate
event counts across all wells so users can compare populations at a glance
from the plate-grid view.
"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


# Standard plate formats
PLATE_FORMATS = {
    "96": (8, 12),   # rows A-H, cols 1-12
    "48": (6, 8),    # rows A-F, cols 1-8
    "24": (4, 6),    # rows A-D, cols 1-6
    "12": (3, 4),    # rows A-C, cols 1-4
    "6":  (2, 3),    # rows A-B, cols 1-3
}

ROW_LETTERS = "ABCDEFGHIJKLMNOP"  # up to 16 rows


class PlateWellInfo(BaseModel):
    """Info for a single well in a plate."""
    well_id: str = Field(..., description="Well identifier, e.g. 'A1', 'B12'")
    row: int = Field(..., description="0-based row index (A=0, B=1, …)")
    col: int = Field(..., description="0-based column index (1-based display: col+1)")
    file_id: Optional[str] = Field(None, description="FCS file assigned to this well (None = empty)")
    label: Optional[str] = Field(None, description="User-defined well label, e.g. 'Sample 1'")


class PlateCreateRequest(BaseModel):
    """Create a new plate layout."""
    name: str = Field(..., min_length=1, description="Human-readable plate name")
    format: str = Field("96", description="Plate format: '96', '48', '24', '12', '6'")
    rows: Optional[int] = Field(None, ge=1, le=16, description="Custom row count (overrides format)")
    cols: Optional[int] = Field(None, ge=1, le=24, description="Custom column count (overrides format)")


class PlateResponse(BaseModel):
    """Full plate with all well definitions."""
    id: str
    name: str
    rows: int
    cols: int
    wells: List[PlateWellInfo] = Field(default_factory=list)


class PlateAssignWellRequest(BaseModel):
    """Assign a file to a well."""
    well_id: str = Field(..., description="Well identifier, e.g. 'A1'")
    file_id: Optional[str] = Field(None, description="FCS file ID to assign; None clears the well")
    label: Optional[str] = Field(None, description="Optional user label for the well")


class PlateWellStatRow(BaseModel):
    """Gate statistics for a single well."""
    well_id: str
    file_id: Optional[str]
    label: Optional[str]
    row: int
    col: int
    count: int = 0
    pct_of_parent: float = 0.0
    pct_of_total: float = 0.0
    total_events: int = 0


class PlateStatsResponse(BaseModel):
    """Aggregated gate statistics across all wells of a plate."""
    plate_id: str
    plate_name: str
    gate_name: str
    rows: int
    cols: int
    wells: List[PlateWellStatRow] = Field(default_factory=list)
