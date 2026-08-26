"""Experiment service — Phase T.

Manages a hierarchy of Experiments → Groups → Samples.
State is held in-memory and persisted to
  ~/.freecyto/experiments.json
on every write so restarts restore the workspace.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import List

from timeutils import utcnow as _utcnow

from models.experiment_models import (
    ExperimentCreateRequest,
    ExperimentListItem,
    ExperimentMeta,
    ExperimentRecord,
    ExperimentResponse,
    ExperimentUpdateRequest,
    GroupCreateRequest,
    GroupRecord,
    GroupResponse,
    GroupUpdateRequest,
    SampleAddRequest,
    SampleMeta,
    SampleRecord,
    SampleResponse,
    SampleUpdateRequest,
)

logger = logging.getLogger("opencyto")

# ─── persistence path ─────────────────────────────────────────────────────────

def _experiments_path() -> Path:
    base = Path(os.getenv("OPENCYTO_DATA_DIR", Path.home() / ".freecyto"))
    base.mkdir(parents=True, exist_ok=True)
    return base / "experiments.json"


# ─── conversion helpers ───────────────────────────────────────────────────────

def _sample_to_response(s: SampleRecord) -> SampleResponse:
    return SampleResponse(
        id=s.id, name=s.name, file_id=s.file_id, path=s.path,
        load_status=s.load_status, compensation_applied=s.compensation_applied,
        gate_count=s.gate_count, created_date=s.created_date,
        modified_date=s.modified_date, meta=s.meta,
    )


def _group_to_response(g: GroupRecord, include_samples: bool = True) -> GroupResponse:
    return GroupResponse(
        id=g.id, name=g.name, description=g.description,
        template_id=g.template_id, created_date=g.created_date,
        sample_count=len(g.samples),
        samples=[_sample_to_response(s) for s in g.samples.values()] if include_samples else [],
    )


def _exp_to_response(e: ExperimentRecord, include_groups: bool = True) -> ExperimentResponse:
    sample_count = sum(len(g.samples) for g in e.groups.values())
    return ExperimentResponse(
        id=e.id, name=e.name, description=e.description,
        default_plate_format=e.default_plate_format,
        created_date=e.created_date, modified_date=e.modified_date,
        meta=e.meta, group_count=len(e.groups), sample_count=sample_count,
        groups=[_group_to_response(g) for g in e.groups.values()] if include_groups else [],
    )


def _exp_to_list_item(e: ExperimentRecord) -> ExperimentListItem:
    sample_count = sum(len(g.samples) for g in e.groups.values())
    return ExperimentListItem(
        id=e.id, name=e.name, description=e.description,
        group_count=len(e.groups), sample_count=sample_count,
        created_date=e.created_date, modified_date=e.modified_date,
    )


# ─── store ────────────────────────────────────────────────────────────────────

class ExperimentStore:
    """Thread-safe in-memory store with JSON persistence."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._experiments: dict[str, ExperimentRecord] = {}
        self._load_from_disk()

    # ── persistence ──────────────────────────────────────────────────────────

    def _load_from_disk(self) -> None:
        path = _experiments_path()
        if not path.exists():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            for item in raw.get("experiments", []):
                exp = ExperimentRecord(**item)
                self._experiments[exp.id] = exp
            logger.info("Loaded %d experiments from %s", len(self._experiments), path)
        except Exception:
            logger.exception("Failed to load experiments from disk — starting fresh")

    def _save_to_disk(self) -> None:
        path = _experiments_path()
        try:
            data = {
                "version": 1,
                "experiments": [
                    json.loads(e.model_dump_json()) for e in self._experiments.values()
                ],
            }
            path.write_text(json.dumps(data, default=str, indent=2), encoding="utf-8")
        except Exception:
            logger.exception("Failed to persist experiments to disk")

    # ── experiment CRUD ──────────────────────────────────────────────────────

    def create_experiment(self, req: ExperimentCreateRequest) -> ExperimentRecord:
        exp = ExperimentRecord(
            id=str(uuid.uuid4()),
            name=req.name,
            description=req.description,
            default_plate_format=req.default_plate_format,
            meta=req.meta,
        )
        with self._lock:
            self._experiments[exp.id] = exp
            self._save_to_disk()
        return exp

    def list_experiments(self) -> List[ExperimentRecord]:
        with self._lock:
            return list(self._experiments.values())

    def get_experiment(self, exp_id: str) -> ExperimentRecord:
        with self._lock:
            exp = self._experiments.get(exp_id)
        if exp is None:
            raise KeyError(f"Experiment '{exp_id}' not found")
        return exp

    def update_experiment(self, exp_id: str, req: ExperimentUpdateRequest) -> ExperimentRecord:
        with self._lock:
            exp = self._experiments.get(exp_id)
            if exp is None:
                raise KeyError(f"Experiment '{exp_id}' not found")
            if req.name is not None:
                exp.name = req.name
            if req.description is not None:
                exp.description = req.description
            if req.default_plate_format is not None:
                exp.default_plate_format = req.default_plate_format
            if req.meta is not None:
                exp.meta = req.meta
            exp.modified_date = _utcnow()
            self._save_to_disk()
        return exp

    def delete_experiment(self, exp_id: str) -> None:
        with self._lock:
            if exp_id not in self._experiments:
                raise KeyError(f"Experiment '{exp_id}' not found")
            del self._experiments[exp_id]
            self._save_to_disk()

    # ── group CRUD ───────────────────────────────────────────────────────────

    def add_group(self, exp_id: str, req: GroupCreateRequest) -> GroupRecord:
        with self._lock:
            exp = self._experiments.get(exp_id)
            if exp is None:
                raise KeyError(f"Experiment '{exp_id}' not found")
            group = GroupRecord(
                id=str(uuid.uuid4()),
                name=req.name,
                description=req.description,
                template_id=req.template_id,
            )
            exp.groups[group.id] = group
            exp.modified_date = _utcnow()
            self._save_to_disk()
        return group

    def get_group(self, exp_id: str, group_id: str) -> GroupRecord:
        exp = self.get_experiment(exp_id)
        grp = exp.groups.get(group_id)
        if grp is None:
            raise KeyError(f"Group '{group_id}' not found in experiment '{exp_id}'")
        return grp

    def update_group(self, exp_id: str, group_id: str, req: GroupUpdateRequest) -> GroupRecord:
        with self._lock:
            exp = self._experiments.get(exp_id)
            if exp is None:
                raise KeyError(f"Experiment '{exp_id}' not found")
            grp = exp.groups.get(group_id)
            if grp is None:
                raise KeyError(f"Group '{group_id}' not found")
            if req.name is not None:
                grp.name = req.name
            if req.description is not None:
                grp.description = req.description
            if req.template_id is not None:
                grp.template_id = req.template_id
            exp.modified_date = _utcnow()
            self._save_to_disk()
        return grp

    def delete_group(self, exp_id: str, group_id: str) -> None:
        with self._lock:
            exp = self._experiments.get(exp_id)
            if exp is None:
                raise KeyError(f"Experiment '{exp_id}' not found")
            if group_id not in exp.groups:
                raise KeyError(f"Group '{group_id}' not found")
            del exp.groups[group_id]
            exp.modified_date = _utcnow()
            self._save_to_disk()

    # ── sample CRUD ──────────────────────────────────────────────────────────

    def add_sample(self, exp_id: str, group_id: str, req: SampleAddRequest) -> SampleRecord:
        with self._lock:
            exp = self._experiments.get(exp_id)
            if exp is None:
                raise KeyError(f"Experiment '{exp_id}' not found")
            grp = exp.groups.get(group_id)
            if grp is None:
                raise KeyError(f"Group '{group_id}' not found")
            sample = SampleRecord(
                id=str(uuid.uuid4()),
                name=req.name,
                file_id=req.file_id,
                path=req.path,
                load_status="loaded" if req.file_id else "pending",
                meta=req.meta,
            )
            grp.samples[sample.id] = sample
            exp.modified_date = _utcnow()
            self._save_to_disk()
        return sample

    def get_sample(self, exp_id: str, group_id: str, sample_id: str) -> SampleRecord:
        grp = self.get_group(exp_id, group_id)
        s = grp.samples.get(sample_id)
        if s is None:
            raise KeyError(f"Sample '{sample_id}' not found in group '{group_id}'")
        return s

    def update_sample(
        self, exp_id: str, group_id: str, sample_id: str, req: SampleUpdateRequest
    ) -> SampleRecord:
        with self._lock:
            exp = self._experiments.get(exp_id)
            if exp is None:
                raise KeyError(f"Experiment '{exp_id}' not found")
            grp = exp.groups.get(group_id)
            if grp is None:
                raise KeyError(f"Group '{group_id}' not found")
            s = grp.samples.get(sample_id)
            if s is None:
                raise KeyError(f"Sample '{sample_id}' not found")
            if req.name is not None:
                s.name = req.name
            if req.file_id is not None:
                s.file_id = req.file_id
                s.load_status = "loaded"
            if req.path is not None:
                s.path = req.path
            if req.load_status is not None:
                s.load_status = req.load_status
            if req.compensation_applied is not None:
                s.compensation_applied = req.compensation_applied
            if req.gate_count is not None:
                s.gate_count = req.gate_count
            if req.meta is not None:
                s.meta = req.meta
            s.modified_date = _utcnow()
            exp.modified_date = _utcnow()
            self._save_to_disk()
        return s

    def delete_sample(self, exp_id: str, group_id: str, sample_id: str) -> None:
        with self._lock:
            exp = self._experiments.get(exp_id)
            if exp is None:
                raise KeyError(f"Experiment '{exp_id}' not found")
            grp = exp.groups.get(group_id)
            if grp is None:
                raise KeyError(f"Group '{group_id}' not found")
            if sample_id not in grp.samples:
                raise KeyError(f"Sample '{sample_id}' not found")
            del grp.samples[sample_id]
            exp.modified_date = _utcnow()
            self._save_to_disk()

    # ── bulk helpers ─────────────────────────────────────────────────────────

    def move_sample(
        self,
        exp_id: str,
        src_group_id: str,
        sample_id: str,
        dst_group_id: str,
    ) -> SampleRecord:
        """Move a sample from one group to another within the same experiment."""
        with self._lock:
            exp = self._experiments.get(exp_id)
            if exp is None:
                raise KeyError(f"Experiment '{exp_id}' not found")
            src = exp.groups.get(src_group_id)
            dst = exp.groups.get(dst_group_id)
            if src is None:
                raise KeyError(f"Source group '{src_group_id}' not found")
            if dst is None:
                raise KeyError(f"Destination group '{dst_group_id}' not found")
            sample = src.samples.pop(sample_id, None)
            if sample is None:
                raise KeyError(f"Sample '{sample_id}' not found in group '{src_group_id}'")
            dst.samples[sample_id] = sample
            exp.modified_date = _utcnow()
            self._save_to_disk()
        return sample

    def get_all_samples_for_experiment(self, exp_id: str) -> list[tuple[str, SampleRecord]]:
        """Return [(group_id, SampleRecord)] for all samples in the experiment."""
        exp = self.get_experiment(exp_id)
        result = []
        for grp_id, grp in exp.groups.items():
            for sample in grp.samples.values():
                result.append((grp_id, sample))
        return result


# ─── module-level singleton ───────────────────────────────────────────────────

_store = ExperimentStore()


def get_store() -> ExperimentStore:
    return _store


def reset_experiment_store() -> None:
    """Clear all experiments from the store (for testing only)."""
    with _store._lock:
        _store._experiments.clear()
