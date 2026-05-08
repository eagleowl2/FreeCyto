"""Layout models — Phase U.

Extended layout models supporting rich metadata, gating strategies,
and full CRUD for the layout editor UI.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


# ─── Gating strategy step ────────────────────────────────────────────────────

class GatingStep(BaseModel):
    """One step in an ordered gating strategy (workflow)."""

    gate_name: str = Field(..., description="Name of the gate to apply at this step")
    condition_type: Literal["always", "if_parent_count_gt", "if_parent_pct_gt"] = Field(
        "always",
        description="When to apply this gate: always, or conditionally on parent population size",
    )
    threshold: float = Field(
        0.0,
        description=(
            "Threshold for conditional application. "
            "For 'if_parent_count_gt': minimum event count. "
            "For 'if_parent_pct_gt': minimum percentage of total."
        ),
    )
    notes: str = Field("", description="Free-text annotation for this step")


# ─── Layout metadata ─────────────────────────────────────────────────────────

class LayoutMetadata(BaseModel):
    """Descriptive metadata attached to a saved layout (template)."""

    description: str = Field("", description="Human-readable description of the gating strategy")
    author: str = Field("", description="Analyst or lab responsible for this template")
    compatible_channels: List[str] = Field(
        default_factory=list,
        description="Channel names this template expects (auto-populated from gate definitions)",
    )
    tags: List[str] = Field(
        default_factory=list,
        description="Free-form tags for search/filter (e.g., 'CD4', 'lymphocytes', 'PBMC')",
    )


# ─── Requests ─────────────────────────────────────────────────────────────────

class LayoutUpdateRequest(BaseModel):
    """Partial update for layout name and/or metadata."""

    name: Optional[str] = None
    metadata: Optional[LayoutMetadata] = None


class StrategyUpdateRequest(BaseModel):
    """Replace the gating strategy for a layout."""

    steps: List[GatingStep] = Field(default_factory=list)


# ─── Responses ───────────────────────────────────────────────────────────────

class LayoutListItem(BaseModel):
    """Compact layout summary for list views."""

    id: str
    name: str
    source_file_id: str
    gate_count: int
    description: str
    author: str
    tags: List[str]
    created_date: datetime
    modified_date: datetime
    strategy_step_count: int


class LayoutDetailResponse(BaseModel):
    """Full layout including gate tree and gating strategy."""

    id: str
    name: str
    source_file_id: str
    gate_count: int
    metadata: LayoutMetadata
    strategy: List[GatingStep]
    created_date: datetime
    modified_date: datetime
