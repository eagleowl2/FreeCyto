"""Phase S — S-1 (Boolean Gates expression builder), S-4 (Layout apply from snapshot), P-1 (Plate Processing).

Covers:
  S-1: Boolean gate creation via expression (backend already tested; here we test edge cases)
  S-4: Layout apply_gate_tree_to_file (snapshot-based, not live source re-read)
  P-1: Plate CRUD, well assignment, gate stats aggregation
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
from services import gates as gates_service
from services import storage
from services import plate_service


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def clean_stores():
    """Reset gate store and plate store before each test."""
    gates_service.reset_gate_store()
    plate_service.reset_plate_store()
    yield
    gates_service.reset_gate_store()
    plate_service.reset_plate_store()


@pytest.fixture
def two_file_setup():
    """Two files: source (with gates) and target (empty)."""
    rng = np.random.default_rng(7)
    n = 500
    events = rng.uniform(0, 1000, size=(n, 3)).astype(np.float32)

    for fid in ["src_file", "tgt_file"]:
        channels = [
            ChannelMetadata(name="FSC-A", index=1, stain=None, display_name="FSC-A", range=1024.0, amplification=None),
            ChannelMetadata(name="SSC-A", index=2, stain=None, display_name="SSC-A", range=1024.0, amplification=None),
            ChannelMetadata(name="FL1-A", index=3, stain=None, display_name="FL1-A", range=1024.0, amplification=None),
        ]
        meta = FileMetadata(id=fid, path=f"/test/{fid}.fcs", sample_name=fid, event_count=n, channels=channels)
        storage.register_file(meta, events)

    return "src_file", "tgt_file"


# ---------------------------------------------------------------------------
# S-1: Boolean gate backend tests (expression edge cases)
# ---------------------------------------------------------------------------

class TestBooleanGateExpressions:
    """S-1: Boolean gate expression edge cases."""

    def test_and_expression(self, client, two_file_setup):
        """AND of two gates should select events in both."""
        src, _ = two_file_setup
        # Create two rectangles that partially overlap
        r1 = client.post("/api/gates", json={
            "file_id": src,
            "name": "GateA",
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "params": {"type": "rectangle", "x_min": 0, "y_min": 0, "x_max": 600, "y_max": 600},
        })
        assert r1.status_code == 200
        r2 = client.post("/api/gates", json={
            "file_id": src,
            "name": "GateB",
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "params": {"type": "rectangle", "x_min": 400, "y_min": 400, "x_max": 1000, "y_max": 1000},
        })
        assert r2.status_code == 200
        # Boolean AND
        rb = client.post("/api/gates", json={
            "file_id": src,
            "name": "GateA_AND_B",
            "x_channel": "",
            "y_channel": "",
            "params": {"type": "boolean", "expression": "GateA AND GateB"},
        })
        assert rb.status_code == 200, rb.text
        data = rb.json()
        # AND count must be ≤ each individual gate count
        count_a = r1.json()["count"]
        count_b = r2.json()["count"]
        count_and = data["count"]
        assert count_and <= count_a
        assert count_and <= count_b

    def test_or_expression(self, client, two_file_setup):
        """OR of two non-overlapping gates = sum of both."""
        src, _ = two_file_setup
        client.post("/api/gates", json={
            "file_id": src, "name": "Left",
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "params": {"type": "rectangle", "x_min": 0, "y_min": 0, "x_max": 400, "y_max": 400},
        })
        client.post("/api/gates", json={
            "file_id": src, "name": "Right",
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "params": {"type": "rectangle", "x_min": 600, "y_min": 600, "x_max": 1000, "y_max": 1000},
        })
        rb = client.post("/api/gates", json={
            "file_id": src, "name": "LR_OR",
            "x_channel": "", "y_channel": "",
            "params": {"type": "boolean", "expression": "Left OR Right"},
        })
        assert rb.status_code == 200
        or_count = rb.json()["count"]
        left_count = gates_service.get_gate_tree(src)[0].count
        right_count = gates_service.get_gate_tree(src)[1].count
        assert or_count == left_count + right_count  # non-overlapping

    def test_not_expression(self, client, two_file_setup):
        """NOT gate should be complement within total events."""
        src, _ = two_file_setup
        r1 = client.post("/api/gates", json={
            "file_id": src, "name": "Small",
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "params": {"type": "rectangle", "x_min": 0, "y_min": 0, "x_max": 200, "y_max": 200},
        })
        assert r1.status_code == 200
        rb = client.post("/api/gates", json={
            "file_id": src, "name": "NotSmall",
            "x_channel": "", "y_channel": "",
            "params": {"type": "boolean", "expression": "NOT Small"},
        })
        assert rb.status_code == 200
        not_count = rb.json()["count"]
        small_count = r1.json()["count"]
        assert not_count == 500 - small_count  # complement

    def test_invalid_expression_returns_400(self, client, two_file_setup):
        """Syntax error in expression should return 400."""
        src, _ = two_file_setup
        rb = client.post("/api/gates", json={
            "file_id": src, "name": "BadExpr",
            "x_channel": "", "y_channel": "",
            "params": {"type": "boolean", "expression": "AND OR NOT"},
        })
        assert rb.status_code in (400, 422)

    def test_unknown_gate_in_expression_returns_error(self, client, two_file_setup):
        """Reference to non-existent gate name should fail at evaluation."""
        src, _ = two_file_setup
        rb = client.post("/api/gates", json={
            "file_id": src, "name": "Ghost",
            "x_channel": "", "y_channel": "",
            "params": {"type": "boolean", "expression": "NonExistentGate"},
        })
        # Backend may return 500 or 400 depending on when evaluation fails
        assert rb.status_code >= 400


# ---------------------------------------------------------------------------
# S-4: Layout apply from stored snapshot
# ---------------------------------------------------------------------------

class TestLayoutSnapshotApply:
    """S-4: apply_gate_tree_to_file uses the stored gate-tree snapshot."""

    def test_apply_layout_creates_gates_on_target(self, client, two_file_setup):
        """Applying a layout should create the same gates on the target file."""
        src, tgt = two_file_setup
        # Create a gate on source
        client.post("/api/gates", json={
            "file_id": src, "name": "Lymphocytes",
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "params": {"type": "rectangle", "x_min": 200, "y_min": 200, "x_max": 700, "y_max": 700},
        })
        # Save layout
        res = client.post("/api/layouts", json={"name": "My Layout", "source_file_id": src})
        assert res.status_code in (200, 201)
        layout_id = res.json()["id"]
        # Apply to target (snapshot-based: source gates irrelevant after delete)
        # First delete the source gate — layout should still apply from snapshot
        tree = gates_service.get_gate_tree(src)
        gates_service.delete_gate(tree[0].id)
        assert len(gates_service.get_gate_tree(src)) == 0  # source is now empty

        apply_res = client.post(f"/api/layouts/{layout_id}/apply?target_file_id={tgt}")
        assert apply_res.status_code == 200
        data = apply_res.json()
        assert data["gates_applied"] == 1

        # Target should have the gate
        tgt_tree = gates_service.get_gate_tree(tgt)
        assert len(tgt_tree) == 1
        assert tgt_tree[0].name == "Lymphocytes"

    def test_apply_preserves_gate_type(self, client, two_file_setup):
        """Applied layout should preserve gate types."""
        src, tgt = two_file_setup
        client.post("/api/gates", json={
            "file_id": src, "name": "EllipseGate",
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "params": {"type": "ellipse", "center_x": 500, "center_y": 500, "radius_x": 200, "radius_y": 150, "angle": 30},
        })
        res = client.post("/api/layouts", json={"name": "EllipseTpl", "source_file_id": src})
        layout_id = res.json()["id"]
        apply_res = client.post(f"/api/layouts/{layout_id}/apply?target_file_id={tgt}")
        assert apply_res.status_code == 200
        tgt_tree = gates_service.get_gate_tree(tgt)
        assert tgt_tree[0].type == "ellipse"

    def test_delete_layout(self, client, two_file_setup):
        """DELETE /api/layouts/{id} should remove the layout."""
        src, _ = two_file_setup
        client.post("/api/gates", json={
            "file_id": src, "name": "G", "x_channel": "FSC-A", "y_channel": "SSC-A",
            "params": {"type": "rectangle", "x_min": 0, "y_min": 0, "x_max": 100, "y_max": 100},
        })
        res = client.post("/api/layouts", json={"name": "ToDelete", "source_file_id": src})
        lid = res.json()["id"]
        del_res = client.delete(f"/api/layouts/{lid}")
        assert del_res.status_code in (200, 204)
        # Should be gone from list
        list_res = client.get("/api/layouts")
        ids = [l["id"] for l in list_res.json()]
        assert lid not in ids


# ---------------------------------------------------------------------------
# P-1: Plate processing
# ---------------------------------------------------------------------------

class TestPlateCreation:
    """P-1: Plate CRUD."""

    def test_create_96_well_plate(self, client):
        """Create a 96-well plate; should have 96 wells."""
        res = client.post("/api/plates", json={"name": "My Plate", "format": "96"})
        assert res.status_code == 200
        data = res.json()
        assert data["rows"] == 8
        assert data["cols"] == 12
        assert len(data["wells"]) == 96

    def test_create_24_well_plate(self, client):
        res = client.post("/api/plates", json={"name": "Small Plate", "format": "24"})
        assert res.status_code == 200
        data = res.json()
        assert data["rows"] == 4
        assert data["cols"] == 6
        assert len(data["wells"]) == 24

    def test_well_ids_format(self, client):
        """96-well plate should have well IDs A1..H12."""
        res = client.post("/api/plates", json={"name": "Format Test", "format": "96"})
        data = res.json()
        well_ids = {w["well_id"] for w in data["wells"]}
        assert "A1" in well_ids
        assert "H12" in well_ids
        assert "A12" in well_ids
        assert "H1" in well_ids

    def test_list_plates(self, client):
        client.post("/api/plates", json={"name": "P1", "format": "96"})
        client.post("/api/plates", json={"name": "P2", "format": "48"})
        res = client.get("/api/plates")
        assert res.status_code == 200
        assert len(res.json()) == 2

    def test_delete_plate(self, client):
        res = client.post("/api/plates", json={"name": "ToDelete", "format": "96"})
        pid = res.json()["id"]
        del_res = client.delete(f"/api/plates/{pid}")
        assert del_res.status_code == 200
        # Gone from list
        list_res = client.get("/api/plates")
        ids = [p["id"] for p in list_res.json()]
        assert pid not in ids

    def test_get_missing_plate_returns_404(self, client):
        res = client.get("/api/plates/nonexistent")
        assert res.status_code == 404


class TestPlateWellAssignment:
    """P-1: Well ↔ file assignment."""

    def test_assign_single_well(self, client, two_file_setup):
        src, _ = two_file_setup
        plate_res = client.post("/api/plates", json={"name": "Assignment Test", "format": "96"})
        pid = plate_res.json()["id"]
        res = client.post(
            f"/api/plates/{pid}/wells/A1",
            json={"well_id": "A1", "file_id": src, "label": "Control"},
        )
        assert res.status_code == 200
        updated = res.json()
        well_a1 = next(w for w in updated["wells"] if w["well_id"] == "A1")
        assert well_a1["file_id"] == src
        assert well_a1["label"] == "Control"

    def test_assign_invalid_well_returns_404(self, client):
        plate_res = client.post("/api/plates", json={"name": "Bad Well", "format": "96"})
        pid = plate_res.json()["id"]
        res = client.post(f"/api/plates/{pid}/wells/Z99", json={"well_id": "Z99", "file_id": None})
        assert res.status_code == 404

    def test_bulk_assign_wells(self, client, two_file_setup):
        src, tgt = two_file_setup
        plate_res = client.post("/api/plates", json={"name": "Bulk Test", "format": "96"})
        pid = plate_res.json()["id"]
        res = client.post(f"/api/plates/{pid}/wells", json={
            "assignments": [
                {"well_id": "A1", "file_id": src, "label": "Sample1"},
                {"well_id": "A2", "file_id": tgt, "label": "Sample2"},
                {"well_id": "A3", "file_id": None},
            ]
        })
        assert res.status_code == 200
        wells = {w["well_id"]: w for w in res.json()["wells"]}
        assert wells["A1"]["file_id"] == src
        assert wells["A2"]["file_id"] == tgt
        assert wells["A3"]["file_id"] is None

    def test_clear_well_by_null_file_id(self, client, two_file_setup):
        src, _ = two_file_setup
        plate_res = client.post("/api/plates", json={"name": "Clear Test", "format": "96"})
        pid = plate_res.json()["id"]
        # Assign
        client.post(f"/api/plates/{pid}/wells/B1", json={"well_id": "B1", "file_id": src})
        # Clear
        res = client.post(f"/api/plates/{pid}/wells/B1", json={"well_id": "B1", "file_id": None})
        well = next(w for w in res.json()["wells"] if w["well_id"] == "B1")
        assert well["file_id"] is None


class TestPlateStats:
    """P-1: Gate statistics aggregation across wells."""

    def test_stats_returns_all_wells(self, client, two_file_setup):
        """Stats endpoint should return a row for every well."""
        src, tgt = two_file_setup
        # Create a gate on src
        client.post("/api/gates", json={
            "file_id": src, "name": "AllEvents",
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "params": {"type": "rectangle", "x_min": 0, "y_min": 0, "x_max": 1000, "y_max": 1000},
        })
        plate_res = client.post("/api/plates", json={"name": "Stats Plate", "format": "6"})
        pid = plate_res.json()["id"]
        # Assign src to A1
        client.post(f"/api/plates/{pid}/wells/A1", json={"well_id": "A1", "file_id": src})
        res = client.get(f"/api/plates/{pid}/stats?gate_name=AllEvents")
        assert res.status_code == 200
        data = res.json()
        assert data["gate_name"] == "AllEvents"
        assert data["rows"] == 2
        assert data["cols"] == 3
        assert len(data["wells"]) == 6  # 2×3 = 6

    def test_stats_populated_well_has_count(self, client, two_file_setup):
        """Assigned well with gate should have non-zero count."""
        src, _ = two_file_setup
        # Gate that captures all events
        client.post("/api/gates", json={
            "file_id": src, "name": "All",
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "params": {"type": "rectangle", "x_min": -1, "y_min": -1, "x_max": 2000, "y_max": 2000},
        })
        plate_res = client.post("/api/plates", json={"name": "Count Plate", "format": "6"})
        pid = plate_res.json()["id"]
        client.post(f"/api/plates/{pid}/wells/A1", json={"well_id": "A1", "file_id": src})
        res = client.get(f"/api/plates/{pid}/stats?gate_name=All")
        data = res.json()
        a1 = next(w for w in data["wells"] if w["well_id"] == "A1")
        assert a1["count"] == 500  # all events
        assert a1["total_events"] == 500

    def test_stats_empty_well_has_zero_count(self, client, two_file_setup):
        """Unassigned well should have count=0."""
        src, _ = two_file_setup
        client.post("/api/gates", json={
            "file_id": src, "name": "G",
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "params": {"type": "rectangle", "x_min": 0, "y_min": 0, "x_max": 1000, "y_max": 1000},
        })
        plate_res = client.post("/api/plates", json={"name": "Empty Well Test", "format": "6"})
        pid = plate_res.json()["id"]
        # Don't assign any file to wells
        res = client.get(f"/api/plates/{pid}/stats?gate_name=G")
        data = res.json()
        for w in data["wells"]:
            assert w["count"] == 0

    def test_stats_missing_gate_returns_zero(self, client, two_file_setup):
        """Well with file assigned but gate not present → zero count."""
        src, _ = two_file_setup
        # No gates created
        plate_res = client.post("/api/plates", json={"name": "No Gate Plate", "format": "6"})
        pid = plate_res.json()["id"]
        client.post(f"/api/plates/{pid}/wells/A1", json={"well_id": "A1", "file_id": src})
        res = client.get(f"/api/plates/{pid}/stats?gate_name=NonExistent")
        assert res.status_code == 200
        a1 = next(w for w in res.json()["wells"] if w["well_id"] == "A1")
        assert a1["count"] == 0
