"""Plate layout service.

Manages in-memory plate layouts (96-well, etc.).  Each plate maps well IDs
(e.g. "A1", "B12") to loaded FCS file IDs.  Provides gate-stat aggregation
across all wells for a given gate name.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Optional

from models.plate_models import (
    PLATE_FORMATS,
    ROW_LETTERS,
    PlateAssignWellRequest,
    PlateCreateRequest,
    PlateResponse,
    PlateStatsResponse,
    PlateWellInfo,
    PlateWellStatRow,
)


@dataclass
class _Well:
    well_id: str
    row: int
    col: int
    file_id: Optional[str] = None
    label: Optional[str] = None


@dataclass
class _Plate:
    id: str
    name: str
    rows: int
    cols: int
    wells: dict[str, _Well] = field(default_factory=dict)


class PlateStore:
    """In-memory plate layout store."""

    def __init__(self) -> None:
        self._plates: dict[str, _Plate] = {}

    def reset(self) -> None:
        self._plates.clear()

    def create(self, req: PlateCreateRequest) -> _Plate:
        if not req.name.strip():
            raise ValueError("Plate name must not be empty")
        fmt = PLATE_FORMATS.get(req.format, (8, 12))
        n_rows = req.rows if req.rows is not None else fmt[0]
        n_cols = req.cols if req.cols is not None else fmt[1]
        plate_id = str(uuid.uuid4())[:8]
        wells: dict[str, _Well] = {}
        for r in range(n_rows):
            row_letter = ROW_LETTERS[r] if r < len(ROW_LETTERS) else str(r + 1)
            for c in range(n_cols):
                wid = f"{row_letter}{c + 1}"
                wells[wid] = _Well(well_id=wid, row=r, col=c)
        plate = _Plate(id=plate_id, name=req.name.strip(), rows=n_rows, cols=n_cols, wells=wells)
        self._plates[plate_id] = plate
        return plate

    def get(self, plate_id: str) -> _Plate:
        plate = self._plates.get(plate_id)
        if plate is None:
            raise KeyError(f"Plate {plate_id!r} not found")
        return plate

    def list_all(self) -> list[_Plate]:
        return list(self._plates.values())

    def delete(self, plate_id: str) -> None:
        if plate_id not in self._plates:
            raise KeyError(f"Plate {plate_id!r} not found")
        del self._plates[plate_id]

    def assign_well(self, plate_id: str, req: PlateAssignWellRequest) -> None:
        plate = self.get(plate_id)
        well = plate.wells.get(req.well_id)
        if well is None:
            raise KeyError(f"Well {req.well_id!r} not found in plate {plate_id!r}")
        well.file_id = req.file_id
        if req.label is not None:
            well.label = req.label

    @staticmethod
    def _to_response(plate: _Plate) -> PlateResponse:
        wells = [
            PlateWellInfo(
                well_id=w.well_id,
                row=w.row,
                col=w.col,
                file_id=w.file_id,
                label=w.label,
            )
            for w in sorted(plate.wells.values(), key=lambda x: (x.row, x.col))
        ]
        return PlateResponse(id=plate.id, name=plate.name, rows=plate.rows, cols=plate.cols, wells=wells)


_store = PlateStore()


def reset_plate_store() -> None:
    """Clear all plates (tests)."""
    _store.reset()


def create_plate(req: PlateCreateRequest) -> PlateResponse:
    plate = _store.create(req)
    return _store._to_response(plate)


def list_plates() -> list[PlateResponse]:
    return [_store._to_response(p) for p in _store.list_all()]


def get_plate(plate_id: str) -> PlateResponse:
    return _store._to_response(_store.get(plate_id))


def delete_plate(plate_id: str) -> None:
    _store.delete(plate_id)


def assign_well(plate_id: str, req: PlateAssignWellRequest) -> PlateResponse:
    _store.assign_well(plate_id, req)
    return _store._to_response(_store.get(plate_id))


def get_plate_stats(plate_id: str, gate_name: str) -> PlateStatsResponse:
    """Compute per-well gate statistics for the named gate.

    For each well that has an assigned file, look up the gate by name in that
    file and return its count/percentages.  Wells without a file or where the
    gate doesn't exist return zeroes.
    """
    from services import gates as gates_service, storage

    plate = _store.get(plate_id)
    rows: list[PlateWellStatRow] = []

    for w in sorted(plate.wells.values(), key=lambda x: (x.row, x.col)):
        stat_row = PlateWellStatRow(
            well_id=w.well_id,
            file_id=w.file_id,
            label=w.label,
            row=w.row,
            col=w.col,
        )
        if w.file_id:
            try:
                meta = storage.get_file_metadata(w.file_id)
                stat_row.total_events = meta.event_count
                # Find gate by name in this file's gate tree
                gate_tree = gates_service.get_gate_tree(w.file_id)
                matched = _find_gate_by_name(gate_tree, gate_name)
                if matched is not None:
                    stat_row.count = matched.count
                    stat_row.pct_of_parent = matched.pct_of_parent
                    stat_row.pct_of_total = matched.pct_of_total
            except (KeyError, Exception):
                pass  # file not loaded or gate missing → zeroes
        rows.append(stat_row)

    return PlateStatsResponse(
        plate_id=plate_id,
        plate_name=plate.name,
        gate_name=gate_name,
        rows=plate.rows,
        cols=plate.cols,
        wells=rows,
    )


def _find_gate_by_name(tree: list, name: str):  # type: ignore[type-arg]
    """DFS to find first gate matching *name* (case-insensitive)."""
    for node in tree:
        if node.name.lower() == name.lower():
            return node
        found = _find_gate_by_name(node.children, name)
        if found is not None:
            return found
    return None


def bulk_assign_wells(plate_id: str, assignments: list[dict]) -> PlateResponse:
    """Assign multiple wells at once.

    ``assignments`` is a list of dicts with keys: well_id, file_id, label.
    Unknown wells or duplicate entries are silently skipped.
    """
    plate = _store.get(plate_id)
    for a in assignments:
        wid = a.get("well_id", "")
        w = plate.wells.get(wid)
        if w is None:
            continue
        w.file_id = a.get("file_id") or None
        if "label" in a:
            w.label = a["label"] or None
    return _store._to_response(plate)
