"""Phase V — First-class quad gate tests.

A quad gate is a single node holding a movable crosshair plus four derived child
rectangle gates (Q1..Q4). Covers:
  - create_quad_gate makes 1 node + 4 children
  - quad node is a passthrough (count == parent population)
  - the 4 children partition the parent (counts sum to parent count)
  - naming convention {name}_Q1..Q4 and crosshair quadrant placement
  - update_gate moving the crosshair re-derives all 4 children together
  - hierarchical quad (child of a rectangle)
  - delete cascades node + children
  - rollback on child name collision
  - workspace save/load round-trip
  - copy_gates_between_files preserves the quad structure
  - router-level POST /api/gates (quad) + PATCH crosshair
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest
from fastapi.testclient import TestClient

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from main import app
from models.file_models import ChannelMetadata, FileMetadata
from models.gate_models import (
    GateCreateRequest,
    GateUpdateRequest,
    QuadGateCreate,
    RectangleGateCreate,
)
from services import gates as gates_service
from services import storage
from services.gates import GateNameExistsError, reset_gate_store
from services.workspace_service import build_workspace_save, load_workspace


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


def _make_quad_file(
    n_per_quad: int = 250,
    seed: int = 42,
    file_id: str = "test_v_quad",
    channel_names: tuple[str, str, str] = ("FSC-A", "SSC-A", "FL1-A"),
) -> str:
    """File with n_per_quad events in each quadrant relative to a (500, 500) split."""
    rng = np.random.default_rng(seed)
    q1 = rng.uniform([501, 501], [1000, 1000], size=(n_per_quad, 2))  # top-right
    q2 = rng.uniform([0, 501], [499, 1000], size=(n_per_quad, 2))     # top-left
    q3 = rng.uniform([0, 0], [499, 499], size=(n_per_quad, 2))        # bottom-left
    q4 = rng.uniform([501, 0], [1000, 499], size=(n_per_quad, 2))     # bottom-right
    events_2d = np.vstack([q1, q2, q3, q4])
    rng.shuffle(events_2d)
    third = rng.uniform(0, 1000, size=(n_per_quad * 4, 1))
    events = np.hstack([events_2d, third]).astype(np.float32)
    channels = [
        ChannelMetadata(name=channel_names[0], index=1, stain=None, display_name=channel_names[0], range=1024.0, amplification=None),
        ChannelMetadata(name=channel_names[1], index=2, stain=None, display_name=channel_names[1], range=1024.0, amplification=None),
        ChannelMetadata(name=channel_names[2], index=3, stain=None, display_name=channel_names[2], range=1024.0, amplification=None),
    ]
    meta = FileMetadata(id=file_id, path=f"/test/{file_id}.fcs", sample_name=file_id, event_count=n_per_quad * 4, channels=channels)
    storage.register_file(meta, events)
    return file_id


def _make_quad(
    file_id: str,
    name: str = "Quad",
    x_thr: float = 500.0,
    y_thr: float = 500.0,
    parent_gate_id: str | None = None,
    x_channel: str = "FSC-A",
    y_channel: str = "SSC-A",
):
    req = GateCreateRequest(
        file_id=file_id,
        name=name,
        x_channel=x_channel,
        y_channel=y_channel,
        parent_gate_id=parent_gate_id,
        params=QuadGateCreate(type="quad", x_threshold=x_thr, y_threshold=y_thr),
    )
    return gates_service.create_quad_gate(req)


@pytest.fixture(autouse=True)
def _clean():
    reset_gate_store()
    yield
    reset_gate_store()


@pytest.fixture
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# Creation
# ---------------------------------------------------------------------------


class TestCreateQuadGate:
    def test_creates_node_plus_four_children(self):
        fid = _make_quad_file()
        quad = _make_quad(fid)
        assert quad.type == "quad"
        assert quad.x_threshold == 500.0
        assert quad.y_threshold == 500.0
        assert len(quad.children) == 4
        # total gates: 1 node + 4 children
        assert len(gates_service.list_gates(fid)) == 5

    def test_children_naming_convention(self):
        fid = _make_quad_file()
        quad = _make_quad(fid, name="MyQuad")
        names = sorted(c.name for c in quad.children)
        assert names == ["MyQuad_Q1", "MyQuad_Q2", "MyQuad_Q3", "MyQuad_Q4"]

    def test_children_are_rectangles_parented_to_quad(self):
        fid = _make_quad_file()
        quad = _make_quad(fid)
        for child in quad.children:
            assert child.type == "rectangle"
            assert child.parent_gate_id == quad.id

    def test_node_is_passthrough(self):
        """The quad node population equals all events (it is a root passthrough)."""
        fid = _make_quad_file(n_per_quad=250)  # 1000 events total
        quad = _make_quad(fid)
        assert quad.count == 1000

    def test_children_partition_parent(self):
        """Q1+Q2+Q3+Q4 counts sum to the quad node (parent) count."""
        fid = _make_quad_file(n_per_quad=250)
        quad = _make_quad(fid)
        child_total = sum(c.count for c in quad.children)
        assert child_total == quad.count == 1000

    def test_quadrant_placement(self):
        """Each quadrant gets ~250 events for a centred (500,500) split."""
        fid = _make_quad_file(n_per_quad=250)
        quad = _make_quad(fid)
        by_name = {c.name: c for c in quad.children}
        for suffix in ("Q1", "Q2", "Q3", "Q4"):
            assert by_name[f"Quad_{suffix}"].count == 250

    def test_q1_is_top_right(self):
        """Q1 (top-right) bounds: x_min=thr, y_min=thr, x_max=+inf, y_max=+inf."""
        fid = _make_quad_file()
        quad = _make_quad(fid, x_thr=500.0, y_thr=500.0)
        q1 = next(c for c in quad.children if c.name == "Quad_Q1")
        assert q1.x_min == 500.0
        assert q1.y_min == 500.0
        assert q1.x_max == float("inf")
        assert q1.y_max == float("inf")


# ---------------------------------------------------------------------------
# Moving the crosshair
# ---------------------------------------------------------------------------


class TestMoveCrosshair:
    def test_update_threshold_redistributes_children(self):
        """Moving the crosshair changes the four quadrant counts but keeps the sum."""
        fid = _make_quad_file(n_per_quad=250)
        quad = _make_quad(fid, x_thr=500.0, y_thr=500.0)
        before = {c.name: c.count for c in quad.children}

        gates_service.update_gate(quad.id, GateUpdateRequest(x_threshold=250.0, y_threshold=250.0))

        gates = {g.id: g for g in gates_service.list_gates(fid)}
        children = [g for g in gates.values() if g.parent_gate_id == quad.id]
        after = {c.name: c.count for c in children}
        # The split moved → distribution changes, but total is preserved.
        assert sum(after.values()) == 1000
        assert after != before

    def test_update_threshold_persisted_on_node(self):
        fid = _make_quad_file()
        quad = _make_quad(fid)
        resp = gates_service.update_gate(quad.id, GateUpdateRequest(x_threshold=300.0, y_threshold=700.0))
        assert resp.x_threshold == 300.0
        assert resp.y_threshold == 700.0

    def test_update_threshold_updates_child_bounds(self):
        """After moving the crosshair, child rectangle edges track the new threshold."""
        fid = _make_quad_file()
        quad = _make_quad(fid, x_thr=500.0, y_thr=500.0)
        gates_service.update_gate(quad.id, GateUpdateRequest(x_threshold=300.0, y_threshold=700.0))
        gates = {g.id: g for g in gates_service.list_gates(fid)}
        q1 = next(g for g in gates.values() if g.name == "Quad_Q1")
        assert q1.x_min == 300.0
        assert q1.y_min == 700.0


# ---------------------------------------------------------------------------
# Hierarchy
# ---------------------------------------------------------------------------


class TestQuadHierarchy:
    def test_quad_under_rectangle(self):
        """A quad parented to a rectangle passes the rectangle population through."""
        fid = _make_quad_file(n_per_quad=250)
        rect = gates_service.create_gate(GateCreateRequest(
            file_id=fid, name="Parent",
            x_channel="FSC-A", y_channel="SSC-A",
            params=RectangleGateCreate(type="rectangle", x_min=0, y_min=0, x_max=1000, y_max=1000),
        ))
        quad = _make_quad(fid, name="ChildQuad", parent_gate_id=rect.id)
        # Quad node passes parent through.
        assert quad.count == rect.count
        # Children still partition the quad population.
        assert sum(c.count for c in quad.children) == quad.count

    def test_child_counts_le_parent(self):
        fid = _make_quad_file(n_per_quad=250)
        rect = gates_service.create_gate(GateCreateRequest(
            file_id=fid, name="HalfPlane",
            x_channel="FSC-A", y_channel="SSC-A",
            params=RectangleGateCreate(type="rectangle", x_min=501, y_min=0, x_max=1000, y_max=1000),
        ))
        quad = _make_quad(fid, name="Q", parent_gate_id=rect.id)
        assert quad.count == rect.count
        for c in quad.children:
            assert c.count <= quad.count


# ---------------------------------------------------------------------------
# Delete + rollback
# ---------------------------------------------------------------------------


class TestQuadDeleteRollback:
    def test_delete_cascades_children(self):
        fid = _make_quad_file()
        quad = _make_quad(fid)
        deleted = gates_service.delete_gate(quad.id)
        assert len(deleted) == 5  # node + 4 children
        assert gates_service.list_gates(fid) == []

    def test_name_collision_rolls_back_whole_quad(self):
        """If a child name collides, the entire quad (node + any children) is removed."""
        fid = _make_quad_file()
        # Pre-create a gate that collides with the future child name "Quad_Q1".
        gates_service.create_gate(GateCreateRequest(
            file_id=fid, name="Quad_Q1",
            x_channel="FSC-A", y_channel="SSC-A",
            params=RectangleGateCreate(type="rectangle", x_min=0, y_min=0, x_max=10, y_max=10),
        ))
        with pytest.raises(GateNameExistsError):
            _make_quad(fid, name="Quad")
        # Only the pre-existing gate remains; the quad node was rolled back.
        remaining = gates_service.list_gates(fid)
        assert len(remaining) == 1
        assert remaining[0].name == "Quad_Q1"
        assert remaining[0].type == "rectangle"


# ---------------------------------------------------------------------------
# Workspace round-trip + copy
# ---------------------------------------------------------------------------


def _make_synthetic_quad_file(n_per_quad: int, seed: int) -> str:
    fid = f"synthetic_{n_per_quad * 4}_{seed}"
    rng = np.random.default_rng(seed)
    q1 = rng.uniform([501, 501], [1000, 1000], size=(n_per_quad, 2))
    q2 = rng.uniform([0, 501], [499, 1000], size=(n_per_quad, 2))
    q3 = rng.uniform([0, 0], [499, 499], size=(n_per_quad, 2))
    q4 = rng.uniform([501, 0], [1000, 499], size=(n_per_quad, 2))
    events_2d = np.vstack([q1, q2, q3, q4])
    third = rng.uniform(0, 1000, size=(n_per_quad * 4, 1))
    events = np.hstack([events_2d, third]).astype(np.float32)
    channels = [
        ChannelMetadata(name="CH1", index=1, stain=None, display_name="CH1", range=1024.0, amplification=None),
        ChannelMetadata(name="CH2", index=2, stain=None, display_name="CH2", range=1024.0, amplification=None),
        ChannelMetadata(name="CH3", index=3, stain=None, display_name="CH3", range=1024.0, amplification=None),
    ]
    meta = FileMetadata(id=fid, path=f"/synthetic/{n_per_quad * 4}_{seed}.fcs", sample_name="synthetic", event_count=n_per_quad * 4, channels=channels)
    storage.register_file(meta, events)
    return fid


class TestQuadWorkspaceRoundTrip:
    def test_quad_survives_save_load(self):
        fid = _make_synthetic_quad_file(n_per_quad=50, seed=77)
        _make_quad(fid, name="WSQuad", x_thr=500.0, y_thr=500.0, x_channel="CH1", y_channel="CH2")

        ws = build_workspace_save([fid])
        quad_defs = [g for g in ws.gates if g.type == "quad"]
        assert len(quad_defs) == 1
        assert quad_defs[0].x_threshold == 500.0
        assert quad_defs[0].y_threshold == 500.0
        # 4 child rectangles also saved
        assert len([g for g in ws.gates if g.type == "rectangle"]) == 4

        reset_gate_store()
        result = load_workspace(ws)
        assert result.gates_created == 5
        assert not result.gate_errors

        loaded = gates_service.list_gates(fid)
        quad = next(g for g in loaded if g.type == "quad")
        assert quad.x_threshold == 500.0
        assert quad.y_threshold == 500.0
        children = [g for g in loaded if g.parent_gate_id == quad.id]
        assert len(children) == 4
        assert sum(c.count for c in children) == quad.count

    def test_copy_quad_between_files(self):
        src = _make_quad_file(n_per_quad=100, seed=5, file_id="quad_src")
        dst = _make_quad_file(n_per_quad=100, seed=6, file_id="quad_dst")
        _make_quad(src, name="Quad")
        result = gates_service.copy_gates_between_files(src, [dst])
        assert result["results"][dst] == 5  # node + 4 children
        dst_gates = gates_service.list_gates(dst)
        quad = next(g for g in dst_gates if g.type == "quad")
        assert len([g for g in dst_gates if g.parent_gate_id == quad.id]) == 4


# ---------------------------------------------------------------------------
# Router level
# ---------------------------------------------------------------------------


class TestQuadRouter:
    def test_post_quad_returns_node_with_children(self, client):
        fid = _make_quad_file(file_id="router_quad")
        res = client.post("/api/gates", json={
            "file_id": fid,
            "name": "RQuad",
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "params": {"type": "quad", "x_threshold": 500.0, "y_threshold": 500.0},
        })
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["type"] == "quad"
        assert len(body["children"]) == 4

    def test_patch_quad_threshold(self, client):
        fid = _make_quad_file(file_id="router_quad_patch")
        res = client.post("/api/gates", json={
            "file_id": fid,
            "name": "PQuad",
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "params": {"type": "quad", "x_threshold": 500.0, "y_threshold": 500.0},
        })
        quad_id = res.json()["id"]
        patch = client.patch(f"/api/gates/{quad_id}", json={"x_threshold": 250.0, "y_threshold": 250.0})
        assert patch.status_code == 200, patch.text
        assert patch.json()["x_threshold"] == 250.0
        assert patch.json()["y_threshold"] == 250.0
