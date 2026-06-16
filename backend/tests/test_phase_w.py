"""Phase W — Robust & persistent gating templates.

Covers:
  - templates capture AND apply every gate type (rectangle, polygon, interval,
    boolean, ellipse, quad), not just rectangle/polygon/interval
  - quad templates reproduce the node + 4 child rectangles on the target
  - disk persistence round-trip for groups + attached templates
  - reset_group_store does not wipe the on-disk file
"""

from __future__ import annotations

import importlib
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from models.file_models import ChannelMetadata, FileMetadata
from models.gate_models import (
    BooleanGateCreate,
    EllipseGateCreate,
    GateCreateRequest,
    IntervalGateCreate,
    PolygonGateCreate,
    QuadGateCreate,
    RectangleGateCreate,
)
from services import gates as gates_service
from services import groups as groups_service
from services import storage


def _make_file(n_events: int = 800, seed: int = 1, file_id: str | None = None) -> str:
    rng = np.random.default_rng(seed)
    events = rng.uniform(0, 1000, size=(n_events, 2)).astype(np.float32)
    fid = file_id or f"w_{seed}"
    channels = [
        ChannelMetadata(name="FSC-A", index=1, stain=None, display_name="FSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="SSC-A", index=2, stain=None, display_name="SSC-A", range=1024.0, amplification=None),
    ]
    meta = FileMetadata(id=fid, path=f"/test/{fid}.fcs", sample_name=fid, event_count=n_events, channels=channels)
    storage.register_file(meta, events)
    return fid


def _gate(file_id: str, name: str, params, parent: str | None = None) -> str:
    return gates_service.create_gate(GateCreateRequest(
        file_id=file_id, name=name, x_channel="FSC-A", y_channel="SSC-A",
        parent_gate_id=parent, params=params,
    )).id


# ---------------------------------------------------------------------------
# Template completeness — all gate types
# ---------------------------------------------------------------------------


class TestTemplateAllGateTypes:
    def test_ellipse_captured_and_applied(self):
        src = _make_file(seed=10, file_id="w_ell_src")
        tgt = _make_file(seed=11, file_id="w_ell_tgt")
        _gate(src, "Blob", EllipseGateCreate(type="ellipse", center_x=500, center_y=500, radius_x=200, radius_y=150, angle=30.0))

        grp = groups_service.create_group("G", [src, tgt])
        tpl = groups_service.create_template(grp.id, src, "T")
        tg = next(g for g in tpl.gates if g.name == "Blob")
        assert tg.type == "ellipse"
        assert tg.center_x == 500 and tg.radius_x == 200 and tg.angle == 30.0

        ids = groups_service.apply_template(tpl.id, tgt)
        assert len(ids) == 1
        applied = next(g for g in gates_service.list_gates(tgt) if g.name == "Blob")
        assert applied.type == "ellipse"
        assert applied.center_x == 500 and applied.radius_y == 150 and applied.angle == 30.0

    def test_boolean_captured_and_applied(self):
        src = _make_file(seed=12, file_id="w_bool_src")
        tgt = _make_file(seed=13, file_id="w_bool_tgt")
        _gate(src, "A", RectangleGateCreate(type="rectangle", x_min=0, y_min=0, x_max=500, y_max=1000))
        _gate(src, "B", RectangleGateCreate(type="rectangle", x_min=0, y_min=0, x_max=1000, y_max=500))
        _gate(src, "AandB", BooleanGateCreate(type="boolean", expression="A AND B"))

        grp = groups_service.create_group("G", [src, tgt])
        tpl = groups_service.create_template(grp.id, src, "T")
        bg = next(g for g in tpl.gates if g.name == "AandB")
        assert bg.type == "boolean" and bg.expression == "A AND B"

        ids = groups_service.apply_template(tpl.id, tgt)
        assert len(ids) == 3
        applied = {g.name: g for g in gates_service.list_gates(tgt)}
        assert applied["AandB"].type == "boolean"
        # Boolean = intersection ⇒ count ≤ each operand.
        assert applied["AandB"].count <= applied["A"].count
        assert applied["AandB"].count <= applied["B"].count

    def test_interval_captured_and_applied(self):
        src = _make_file(seed=14, file_id="w_int_src")
        tgt = _make_file(seed=15, file_id="w_int_tgt")
        _gate(src, "FSChi", IntervalGateCreate(type="interval", x_min=400, x_max=900))

        grp = groups_service.create_group("G", [src, tgt])
        tpl = groups_service.create_template(grp.id, src, "T")
        ids = groups_service.apply_template(tpl.id, tgt)
        assert len(ids) == 1
        applied = next(g for g in gates_service.list_gates(tgt) if g.name == "FSChi")
        assert applied.type == "interval"
        assert applied.x_min == 400 and applied.x_max == 900

    def test_quad_captured_and_applied(self):
        src = _make_file(seed=16, file_id="w_quad_src")
        tgt = _make_file(seed=17, file_id="w_quad_tgt")
        # Create a first-class quad on the source (node + 4 children).
        gates_service.create_quad_gate(GateCreateRequest(
            file_id=src, name="Quad", x_channel="FSC-A", y_channel="SSC-A",
            params=QuadGateCreate(type="quad", x_threshold=500.0, y_threshold=500.0),
        ))

        grp = groups_service.create_group("G", [src, tgt])
        tpl = groups_service.create_template(grp.id, src, "T")
        # Template should hold the quad node + its 4 child rectangles = 5 gates.
        assert len(tpl.gates) == 5
        quad_tg = next(g for g in tpl.gates if g.type == "quad")
        assert quad_tg.x_threshold == 500.0 and quad_tg.y_threshold == 500.0

        ids = groups_service.apply_template(tpl.id, tgt)
        assert len(ids) == 5
        tgt_gates = gates_service.list_gates(tgt)
        quad = next(g for g in tgt_gates if g.type == "quad")
        assert quad.x_threshold == 500.0
        children = [g for g in tgt_gates if g.parent_gate_id == quad.id]
        assert len(children) == 4
        # Children partition the quad population.
        assert sum(c.count for c in children) == quad.count

    def test_polygon_still_works(self):
        """Regression: polygon templates remain functional after the refactor."""
        src = _make_file(seed=18, file_id="w_poly_src")
        tgt = _make_file(seed=19, file_id="w_poly_tgt")
        _gate(src, "Poly", PolygonGateCreate(type="polygon", vertices=[[100, 100], [800, 100], [450, 800]]))
        grp = groups_service.create_group("G", [src, tgt])
        tpl = groups_service.create_template(grp.id, src, "T")
        ids = groups_service.apply_template(tpl.id, tgt)
        assert len(ids) == 1
        assert next(g for g in gates_service.list_gates(tgt) if g.name == "Poly").type == "polygon"


# ---------------------------------------------------------------------------
# Disk persistence
# ---------------------------------------------------------------------------


class TestGroupPersistence:
    def test_groups_and_templates_round_trip(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENCYTO_DATA_DIR", str(tmp_path))
        src = _make_file(seed=20, file_id="w_persist")
        _gate(src, "Lymph", RectangleGateCreate(type="rectangle", x_min=100, y_min=100, x_max=900, y_max=900))

        grp = groups_service.create_group("PersistGroup", [src])
        tpl = groups_service.create_template(grp.id, src, "PersistTpl")

        # The file should exist on disk now.
        assert (tmp_path / "groups.json").exists()

        # Simulate a fresh process: clear memory, reload from disk.
        groups_service.reset_group_store()
        assert groups_service.list_groups() == []
        groups_service._load_from_disk()

        groups = groups_service.list_groups()
        assert len(groups) == 1
        assert groups[0].name == "PersistGroup"
        assert groups[0].template_id == tpl.id
        assert {s.file_id for s in groups[0].samples} == {src}

        # The reloaded template is usable: apply it to a target.
        tgt = _make_file(seed=21, file_id="w_persist_tgt")
        ids = groups_service.apply_template(tpl.id, tgt)
        assert len(ids) == 1

    def test_reset_does_not_wipe_disk(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENCYTO_DATA_DIR", str(tmp_path))
        src = _make_file(seed=22, file_id="w_nowipe")
        groups_service.create_group("KeepMe", [src])
        path = tmp_path / "groups.json"
        before = path.read_text(encoding="utf-8")

        groups_service.reset_group_store()  # must NOT touch disk

        assert path.read_text(encoding="utf-8") == before
        groups_service._load_from_disk()
        assert any(g.name == "KeepMe" for g in groups_service.list_groups())

    def test_delete_group_persists(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENCYTO_DATA_DIR", str(tmp_path))
        src = _make_file(seed=23, file_id="w_del")
        grp = groups_service.create_group("ToGo", [src])
        groups_service.delete_group(grp.id)

        groups_service.reset_group_store()
        groups_service._load_from_disk()
        assert groups_service.list_groups() == []
