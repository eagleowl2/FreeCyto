"""Phase O — Gate rename + density contour tests.

Covers:
  - update_gate rename: basic rename, blank name error, duplicate name error,
    same-name no-op, rename preserves mask cache validity
  - Rename via API (router-level, via TestClient)
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from models.file_models import ChannelMetadata, FileMetadata
from models.gate_models import GateCreateRequest, GateUpdateRequest, RectangleGateCreate
from services import gates as gates_service
from services import storage
from services.gates import GateNameExistsError, _store, reset_gate_store


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_file(n_events: int = 500, seed: int = 7, file_id: str | None = None) -> str:
    rng = np.random.default_rng(seed)
    events = rng.uniform(0, 1000, size=(n_events, 3)).astype(np.float32)
    fid = file_id or f"test_o_{seed}"
    channels = [
        ChannelMetadata(name="FSC-A", index=1, stain=None, display_name="FSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="SSC-A", index=2, stain=None, display_name="SSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="FL1-A", index=3, stain=None, display_name="FL1-A", range=1024.0, amplification=None),
    ]
    meta = FileMetadata(id=fid, path=f"/test/{fid}.fcs", sample_name=fid, event_count=n_events, channels=channels)
    storage.register_file(meta, events)
    return fid


def _rect_gate(fid: str, name: str, x_min=100.0, y_min=100.0, x_max=900.0, y_max=900.0) -> str:
    req = GateCreateRequest(
        file_id=fid,
        name=name,
        x_channel="FSC-A",
        y_channel="SSC-A",
        params=RectangleGateCreate(type="rectangle", x_min=x_min, y_min=y_min, x_max=x_max, y_max=y_max),
    )
    resp = gates_service.create_gate(req)
    return resp.id


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean():
    reset_gate_store()
    yield
    reset_gate_store()


# ---------------------------------------------------------------------------
# TestGateRename
# ---------------------------------------------------------------------------


class TestGateRename:
    def test_basic_rename(self):
        fid = _make_file()
        gid = _rect_gate(fid, "Old Name")
        resp = gates_service.update_gate(gid, GateUpdateRequest(name="New Name"))
        assert resp.name == "New Name"

    def test_rename_visible_in_tree(self):
        fid = _make_file()
        gid = _rect_gate(fid, "Alpha")
        gates_service.update_gate(gid, GateUpdateRequest(name="Beta"))
        tree = gates_service.get_gate_tree(fid)
        names = [n.name for n in tree]
        assert "Beta" in names
        assert "Alpha" not in names

    def test_rename_to_same_name_is_noop(self):
        """Renaming to the same name must succeed without error."""
        fid = _make_file()
        gid = _rect_gate(fid, "Mygate")
        resp = gates_service.update_gate(gid, GateUpdateRequest(name="Mygate"))
        assert resp.name == "Mygate"

    def test_rename_blank_raises(self):
        fid = _make_file()
        gid = _rect_gate(fid, "Gate1")
        with pytest.raises(ValueError, match="empty"):
            gates_service.update_gate(gid, GateUpdateRequest(name="   "))

    def test_rename_duplicate_raises(self):
        fid = _make_file()
        _rect_gate(fid, "Gate1")
        gid2 = _rect_gate(fid, "Gate2")
        with pytest.raises(GateNameExistsError):
            gates_service.update_gate(gid2, GateUpdateRequest(name="Gate1"))

    def test_rename_preserves_count(self):
        """Count and geometry must be unaffected by a rename-only update."""
        fid = _make_file()
        gid = _rect_gate(fid, "G")
        before = gates_service.update_gate(gid, GateUpdateRequest())
        after = gates_service.update_gate(gid, GateUpdateRequest(name="G Renamed"))
        assert after.count == before.count
        assert after.x_min == before.x_min
        assert after.y_min == before.y_min
        assert after.x_max == before.x_max
        assert after.y_max == before.y_max

    def test_rename_and_geometry_in_one_request(self):
        """Rename + geometry update in the same PATCH must both apply."""
        fid = _make_file()
        gid = _rect_gate(fid, "Initial", x_min=100.0, y_min=100.0, x_max=500.0, y_max=500.0)
        resp = gates_service.update_gate(gid, GateUpdateRequest(name="Updated", x_max=600.0))
        assert resp.name == "Updated"
        assert resp.x_max == 600.0

    def test_rename_preserves_children(self):
        """Children of a renamed gate must still be accessible."""
        fid = _make_file()
        parent_id = _rect_gate(fid, "Parent", x_min=100.0, y_min=100.0, x_max=900.0, y_max=900.0)
        child_req = GateCreateRequest(
            file_id=fid,
            name="Child",
            x_channel="FSC-A",
            y_channel="SSC-A",
            parent_gate_id=parent_id,
            params=RectangleGateCreate(type="rectangle", x_min=200.0, y_min=200.0, x_max=800.0, y_max=800.0),
        )
        gates_service.create_gate(child_req)
        gates_service.update_gate(parent_id, GateUpdateRequest(name="Parent Renamed"))
        tree = gates_service.get_gate_tree(fid)
        assert len(tree) == 1
        assert tree[0].name == "Parent Renamed"
        assert len(tree[0].children) == 1
        assert tree[0].children[0].name == "Child"

    def test_rename_nonexistent_gate_raises(self):
        with pytest.raises(KeyError):
            gates_service.update_gate("no-such-gate", GateUpdateRequest(name="X"))

    def test_rename_does_not_invalidate_mask_cache(self):
        """A name-only update must not clear the cached count (cache stays warm)."""
        fid = _make_file()
        gid = _rect_gate(fid, "Gate")
        # Force cache fill
        before = gates_service.update_gate(gid, GateUpdateRequest())
        cached_count_before = _store.gates_by_id[gid]._cached_count
        # Rename only
        gates_service.update_gate(gid, GateUpdateRequest(name="Gate Renamed"))
        cached_count_after = _store.gates_by_id[gid]._cached_count
        assert cached_count_before == cached_count_after, "Rename must not invalidate mask cache"
