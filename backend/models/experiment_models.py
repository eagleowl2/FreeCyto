"""Experiment, Group, and Sample data models for Phase T.

Hierarchy: Experiment → Group(s) → Sample(s)
Each Sample is linked to a loaded FCS file_id.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


# ─── Sample ───────────────────────────────────────────────────────────────────

class SampleMeta(BaseModel):
    """Optional scientific metadata attached to a sample."""
    treatment: str | None = None
    condition: str | None = None
    replicate: int | None = None
    timepoint: str | None = None
    notes: str | None = None


class SampleRecord(BaseModel):
    id: str
    name: str
    file_id: str | None = None          # linked loaded FCS file
    path: str | None = None             # original FCS file path
    load_status: str = "pending"        # pending | loaded | error
    compensation_applied: bool = False
    gate_count: int = 0
    created_date: datetime = Field(default_factory=datetime.utcnow)
    modified_date: datetime = Field(default_factory=datetime.utcnow)
    meta: SampleMeta = Field(default_factory=SampleMeta)


class SampleAddRequest(BaseModel):
    name: str
    file_id: str | None = None
    path: str | None = None
    meta: SampleMeta = Field(default_factory=SampleMeta)


class SampleUpdateRequest(BaseModel):
    name: str | None = None
    file_id: str | None = None
    path: str | None = None
    load_status: str | None = None
    compensation_applied: bool | None = None
    gate_count: int | None = None
    meta: SampleMeta | None = None


class SampleResponse(BaseModel):
    id: str
    name: str
    file_id: str | None
    path: str | None
    load_status: str
    compensation_applied: bool
    gate_count: int
    created_date: datetime
    modified_date: datetime
    meta: SampleMeta


# ─── Group ────────────────────────────────────────────────────────────────────

class GroupRecord(BaseModel):
    id: str
    name: str
    description: str = ""
    template_id: str | None = None      # default gating template for this group
    created_date: datetime = Field(default_factory=datetime.utcnow)
    samples: dict[str, SampleRecord] = Field(default_factory=dict)


class GroupCreateRequest(BaseModel):
    name: str
    description: str = ""
    template_id: str | None = None


class GroupUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    template_id: str | None = None


class GroupResponse(BaseModel):
    id: str
    name: str
    description: str
    template_id: str | None
    created_date: datetime
    sample_count: int
    samples: List[SampleResponse] = Field(default_factory=list)


# ─── Experiment ───────────────────────────────────────────────────────────────

class ExperimentMeta(BaseModel):
    instrument: str | None = None
    operator: str | None = None
    panel: str | None = None
    organism: str | None = None
    tissue: str | None = None
    notes: str | None = None


class ExperimentRecord(BaseModel):
    id: str
    name: str
    description: str = ""
    default_plate_format: str = "96"
    created_date: datetime = Field(default_factory=datetime.utcnow)
    modified_date: datetime = Field(default_factory=datetime.utcnow)
    meta: ExperimentMeta = Field(default_factory=ExperimentMeta)
    groups: dict[str, GroupRecord] = Field(default_factory=dict)


class ExperimentCreateRequest(BaseModel):
    name: str
    description: str = ""
    default_plate_format: str = "96"
    meta: ExperimentMeta = Field(default_factory=ExperimentMeta)


class ExperimentUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    default_plate_format: str | None = None
    meta: ExperimentMeta | None = None


class ExperimentResponse(BaseModel):
    id: str
    name: str
    description: str
    default_plate_format: str
    created_date: datetime
    modified_date: datetime
    meta: ExperimentMeta
    group_count: int
    sample_count: int
    groups: List[GroupResponse] = Field(default_factory=list)


class ExperimentListItem(BaseModel):
    """Lightweight experiment summary for list views (no groups/samples)."""
    id: str
    name: str
    description: str
    group_count: int
    sample_count: int
    created_date: datetime
    modified_date: datetime
