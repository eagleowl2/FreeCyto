"""Phase N — Ellipse gate tests.

Covers:
  - _point_in_ellipse geometry (axis-aligned and rotated)
  - create_gate with type="ellipse"
  - _get_mask evaluation
  - update_gate for ellipse fields
  - workspace save/load round-trip for ellipse gates
"""

from __future__ import annotations

import math
import os
import sys

import numpy as np
import pytest

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from models.file_models import ChannelMetadata, FileMetadata
from models.gate_models import EllipseGateCreate, GateCreateRequest, GateUpdateRequest
from services import gates as gates_service
from services import storage
from services.gates import _point_in_ellipse, reset_gate_store
from services.workspace_service import build_workspace_save, load_workspace


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_file(n_events: int = 400, seed: int = 42, file_id: str | None = None) -> str:
    rng = np.random.default_rng(seed)
    events = rng.uniform(0, 1000, size=(n_events, 3)).astype(np.float32)
    fid = file_id or f"test_n_{seed}"
    channels = [
        ChannelMetadata(name="FSC-A", index=1, stain=None, display_name="FSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="SSC-A", index=2, stain=None, display_name="SSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="FL1-A", index=3, stain=None, display_name="FL1-A", range=1024.0, amplification=None),
    ]
    meta = FileMetadata(id=fid, path=f"/test/{fid}.fcs", sample_name=fid, event_count=n_events, channels=channels)
    storage.register_file(meta, events)
    return fid


def _add_ellipse(
    file_id: str,
    name: str = "E1",
    cx: float = 500.0,
    cy: float = 500.0,
    rx: float = 200.0,
    ry: float = 150.0,
    angle: float = 0.0,
) -> str:
    req = GateCreateRequest(
        file_id=file_id,
        name=name,
        x_channel="FSC-A",
        y_channel="SSC-A",
        params=EllipseGateCreate(
            type="ellipse",
            center_x=cx,
            center_y=cy,
            radius_x=rx,
            radius_y=ry,
            angle=angle,
        ),
    )
    return gates_service.create_gate(req).id


@pytest.fixture(autouse=True)
def _clean():
    reset_gate_store()
    yield
    reset_gate_store()


# ---------------------------------------------------------------------------
# Unit tests — _point_in_ellipse geometry
# ---------------------------------------------------------------------------


class TestPointInEllipse:
    """Validate the _point_in_ellipse helper independently."""

    def _pts(self, xs, ys):
        return np.array(xs, dtype=float), np.array(ys, dtype=float)

    def test_centre_always_inside(self):
        x, y = self._pts([0.0], [0.0])
        assert _point_in_ellipse(x, y, 0.0, 0.0, 2.0, 1.0)[0]

    def test_point_outside(self):
        x, y = self._pts([3.0], [0.0])
        assert not _point_in_ellipse(x, y, 0.0, 0.0, 2.0, 1.0)[0]

    def test_exact_boundary_x_axis_inside(self):
        """Point at (rx, 0) from centre is exactly on the boundary — should be inside."""
        x, y = self._pts([2.0], [0.0])
        assert _point_in_ellipse(x, y, 0.0, 0.0, 2.0, 1.0)[0]

    def test_exact_boundary_y_axis_inside(self):
        """Point at (0, ry) from centre is exactly on the boundary."""
        x, y = self._pts([0.0], [1.0])
        assert _point_in_ellipse(x, y, 0.0, 0.0, 2.0, 1.0)[0]

    def test_nonzero_centre(self):
        """Ellipse centred away from origin."""
        x, y = self._pts([500.5], [300.2])
        assert _point_in_ellipse(x, y, 500.0, 300.0, 2.0, 1.0)[0]

    def test_rotated_90_degrees(self):
        """After 90° CCW rotation, long axis (rx) now points in the Y direction."""
        # Ellipse: cx=0, cy=0, rx=3 (long), ry=1 (short), angle=90°
        # Long axis now along Y → point (0, 2.9) should be inside
        x_in, y_in = self._pts([0.0], [2.9])
        assert _point_in_ellipse(x_in, y_in, 0.0, 0.0, 3.0, 1.0, angle_deg=90.0)[0]
        # And point (2.9, 0) should be outside (short axis now points along X)
        x_out, y_out = self._pts([2.9], [0.0])
        assert not _point_in_ellipse(x_out, y_out, 0.0, 0.0, 3.0, 1.0, angle_deg=90.0)[0]

    def test_rotated_45_degrees_symmetric(self):
        """Points equidistant from centre along 45° and 135° lines."""
        # Ellipse rx=4, ry=1, angle=45°
        # A point on the 45° line at distance 1 should be inside both rx and ry limits.
        d = 0.7
        x, y = self._pts([d], [d])  # along 45° from origin
        result = _point_in_ellipse(x, y, 0.0, 0.0, 4.0, 1.0, angle_deg=45.0)
        assert result[0]

    def test_zero_radius_returns_all_outside(self):
        x, y = self._pts([0.0, 0.0], [0.0, 0.0])
        assert not _point_in_ellipse(x, y, 0.0, 0.0, 0.0, 1.0).any()

    def test_batch_mixed(self):
        """Batch test: some inside, some outside."""
        xs = np.array([0.0, 1.9, 2.1, -1.9, 0.0, 0.0], dtype=float)
        ys = np.array([0.0, 0.0, 0.0,  0.0, 0.9, 1.1], dtype=float)
        result = _point_in_ellipse(xs, ys, 0.0, 0.0, 2.0, 1.0)
        expected = np.array([True, True, False, True, True, False])
        np.testing.assert_array_equal(result, expected)


# ---------------------------------------------------------------------------
# create_gate / mask evaluation
# ---------------------------------------------------------------------------


class TestCreateEllipseGate:
    def test_basic_create_returns_response(self):
        fid = _make_file()
        resp = gates_service.create_gate(GateCreateRequest(
            file_id=fid, name="Basic",
            x_channel="FSC-A", y_channel="SSC-A",
            params=EllipseGateCreate(type="ellipse", center_x=500, center_y=500, radius_x=200, radius_y=150),
        ))
        assert resp.type == "ellipse"
        assert resp.center_x == 500.0
        assert resp.center_y == 500.0
        assert resp.radius_x == 200.0
        assert resp.radius_y == 150.0
        assert resp.angle == 0.0

    def test_gate_count_positive(self):
        """A gate covering the middle of a uniform distribution should select some events."""
        fid = _make_file(n_events=1000, seed=7)
        gid = _add_ellipse(fid, cx=500, cy=500, rx=300, ry=300)
        gates = {g.id: g for g in gates_service.list_gates(fid)}
        assert gates[gid].count > 0

    def test_gate_count_less_than_total(self):
        """Ellipse that doesn't span the full range should contain fewer events than total."""
        fid = _make_file(n_events=500, seed=8)
        gid = _add_ellipse(fid, cx=500, cy=500, rx=100, ry=100)
        gates = {g.id: g for g in gates_service.list_gates(fid)}
        assert gates[gid].count < 500

    def test_full_coverage_ellipse(self):
        """Ellipse large enough to contain all events → count == total."""
        fid = _make_file(n_events=200, seed=9)
        gid = _add_ellipse(fid, cx=500, cy=500, rx=800, ry=800)
        gates = {g.id: g for g in gates_service.list_gates(fid)}
        assert gates[gid].count == 200

    def test_ellipse_inscribed_le_bounding_rect(self):
        """Ellipse inscribed in a rectangle selects ≤ events than the same bounding rectangle."""
        from models.gate_models import GateCreateRequest as GCR, RectangleGateCreate
        fid = _make_file(n_events=500, seed=10)
        cx, cy, rx, ry = 500.0, 500.0, 200.0, 150.0
        # Ellipse gate
        ellipse_id = _add_ellipse(fid, cx=cx, cy=cy, rx=rx, ry=ry)
        # Bounding rectangle
        rect_id = gates_service.create_gate(GCR(
            file_id=fid, name="BoundingRect",
            x_channel="FSC-A", y_channel="SSC-A",
            params=RectangleGateCreate(type="rectangle",
                x_min=cx - rx, y_min=cy - ry, x_max=cx + rx, y_max=cy + ry),
        )).id
        gates = {g.id: g for g in gates_service.list_gates(fid)}
        assert gates[ellipse_id].count <= gates[rect_id].count

    def test_rotated_vs_axis_aligned_differ(self):
        """For non-circular ellipse, rotating by 90° changes which events are selected."""
        fid1 = _make_file(n_events=1000, seed=11)
        fid2 = _make_file(n_events=1000, seed=11, file_id="test_n_11b")
        gid0 = _add_ellipse(fid1, cx=500, cy=500, rx=300, ry=100, angle=0.0)
        gid90 = _add_ellipse(fid2, cx=500, cy=500, rx=300, ry=100, angle=90.0)
        g0 = next(g for g in gates_service.list_gates(fid1) if g.id == gid0)
        g90 = next(g for g in gates_service.list_gates(fid2) if g.id == gid90)
        # Both should have events, and their counts should differ (different orientation)
        assert g0.count > 0
        assert g90.count > 0
        assert g0.count != g90.count

    def test_pct_of_total_in_range(self):
        fid = _make_file(n_events=200, seed=12)
        gid = _add_ellipse(fid, cx=500, cy=500, rx=200, ry=150)
        g = next(g for g in gates_service.list_gates(fid) if g.id == gid)
        assert 0.0 <= g.pct_of_total <= 100.0

    def test_name_collision_raises(self):
        fid = _make_file(seed=13)
        _add_ellipse(fid, name="Lymph")
        from services.gates import GateNameExistsError
        with pytest.raises(GateNameExistsError):
            _add_ellipse(fid, name="Lymph")


# ---------------------------------------------------------------------------
# update_gate for ellipse
# ---------------------------------------------------------------------------


class TestUpdateEllipseGate:
    def test_update_center_changes_count(self):
        """Moving the centre to a corner of the data space changes the count."""
        fid = _make_file(n_events=500, seed=20)
        gid = _add_ellipse(fid, cx=500, cy=500, rx=200, ry=200)
        before = next(g for g in gates_service.list_gates(fid) if g.id == gid).count
        # Move to corner where few points are
        gates_service.update_gate(gid, GateUpdateRequest(center_x=950.0, center_y=950.0))
        after = next(g for g in gates_service.list_gates(fid) if g.id == gid).count
        assert before != after

    def test_update_radii_changes_count(self):
        fid = _make_file(n_events=500, seed=21)
        gid = _add_ellipse(fid, cx=500, cy=500, rx=50, ry=50)
        before = next(g for g in gates_service.list_gates(fid) if g.id == gid).count
        gates_service.update_gate(gid, GateUpdateRequest(radius_x=400.0, radius_y=400.0))
        after = next(g for g in gates_service.list_gates(fid) if g.id == gid).count
        assert after > before

    def test_update_angle_changes_count(self):
        """Rotating an asymmetric ellipse selects a different population."""
        fid1 = _make_file(n_events=500, seed=22)
        gid = _add_ellipse(fid1, cx=500, cy=500, rx=300, ry=80, angle=0.0)
        count_0 = next(g for g in gates_service.list_gates(fid1) if g.id == gid).count
        gates_service.update_gate(gid, GateUpdateRequest(angle=90.0))
        count_90 = next(g for g in gates_service.list_gates(fid1) if g.id == gid).count
        assert count_0 != count_90

    def test_update_negative_radius_raises(self):
        fid = _make_file(seed=23)
        gid = _add_ellipse(fid)
        with pytest.raises(ValueError, match="radius_x"):
            gates_service.update_gate(gid, GateUpdateRequest(radius_x=-1.0))

    def test_update_zero_radius_raises(self):
        fid = _make_file(seed=24)
        gid = _add_ellipse(fid)
        with pytest.raises(ValueError, match="radius_y"):
            gates_service.update_gate(gid, GateUpdateRequest(radius_y=0.0))

    def test_update_returns_updated_fields(self):
        fid = _make_file(seed=25)
        gid = _add_ellipse(fid, cx=500, cy=500, rx=200, ry=150, angle=0.0)
        resp = gates_service.update_gate(gid, GateUpdateRequest(center_x=600.0, radius_x=100.0, angle=45.0))
        assert resp.center_x == 600.0
        assert resp.radius_x == 100.0
        assert resp.angle == 45.0
        # Unchanged fields
        assert resp.center_y == 500.0
        assert resp.radius_y == 150.0

    def test_update_nonexistent_raises(self):
        with pytest.raises(KeyError):
            gates_service.update_gate("no-such-gate", GateUpdateRequest(center_x=500.0))


# ---------------------------------------------------------------------------
# Hierarchical ellipse gate (child of a rectangle)
# ---------------------------------------------------------------------------


class TestEllipseHierarchy:
    def test_child_ellipse_count_le_parent_count(self):
        """Child ellipse cannot contain more events than its parent rectangle."""
        from models.gate_models import GateCreateRequest as GCR, RectangleGateCreate
        fid = _make_file(n_events=500, seed=30)
        parent_id = gates_service.create_gate(GCR(
            file_id=fid, name="Rect",
            x_channel="FSC-A", y_channel="SSC-A",
            params=RectangleGateCreate(type="rectangle",
                x_min=200, y_min=200, x_max=800, y_max=800),
        )).id
        child_id = _add_ellipse(fid, name="InnerEllipse", cx=500, cy=500, rx=200, ry=200)
        # Create child properly
        gid_child = gates_service.create_gate(GateCreateRequest(
            file_id=fid, name="EllipseChild",
            x_channel="FSC-A", y_channel="SSC-A",
            parent_gate_id=parent_id,
            params=EllipseGateCreate(type="ellipse", center_x=500, center_y=500, radius_x=150, radius_y=150),
        )).id
        gates = {g.id: g for g in gates_service.list_gates(fid)}
        assert gates[gid_child].count <= gates[parent_id].count


# ---------------------------------------------------------------------------
# Workspace round-trip
# ---------------------------------------------------------------------------


def _make_synthetic_file(n_events: int, seed: int) -> str:
    """Create a synthetic file using the workspace-compatible id/path/channel convention.

    Channel names must match what workspace_service generates on reload (CH1, CH2, …).
    """
    fid = f"synthetic_{n_events}_{seed}"
    rng = np.random.default_rng(seed)
    events = rng.uniform(0, 1000, size=(n_events, 3)).astype(np.float32)
    # Use generic CH names so they survive workspace reload (the reload generates CH1/CH2/CH3)
    channels = [
        ChannelMetadata(name="CH1", index=1, stain=None, display_name="CH1", range=1024.0, amplification=None),
        ChannelMetadata(name="CH2", index=2, stain=None, display_name="CH2", range=1024.0, amplification=None),
        ChannelMetadata(name="CH3", index=3, stain=None, display_name="CH3", range=1024.0, amplification=None),
    ]
    meta = FileMetadata(
        id=fid,
        path=f"/synthetic/{n_events}_{seed}.fcs",  # workspace loader recognises this prefix
        sample_name="synthetic",
        event_count=n_events,
        channels=channels,
    )
    storage.register_file(meta, events)
    return fid


class TestWorkspaceRoundTripEllipse:
    def test_ellipse_survives_save_load(self):
        """Ellipse gate params are preserved through workspace save/load."""
        fid = _make_synthetic_file(n_events=100, seed=77)
        # Use CH1/CH2 so channels survive the synthetic-file reload (workspace creates CH1…)
        req = GateCreateRequest(
            file_id=fid, name="EllipseWS",
            x_channel="CH1", y_channel="CH2",
            params=EllipseGateCreate(type="ellipse", center_x=400.0, center_y=600.0,
                                     radius_x=120.0, radius_y=80.0, angle=30.0),
        )
        gates_service.create_gate(req)

        ws = build_workspace_save([fid])
        # Verify the gate def was saved
        ellipse_defs = [g for g in ws.gates if g.type == "ellipse"]
        assert len(ellipse_defs) == 1
        gdef = ellipse_defs[0]
        assert gdef.center_x == 400.0
        assert gdef.center_y == 600.0
        assert gdef.radius_x == 120.0
        assert gdef.radius_y == 80.0
        assert gdef.angle == 30.0

        # Load into fresh state
        reset_gate_store()
        result = load_workspace(ws)
        assert result.gates_created == 1
        assert not result.gate_errors

        loaded_gates = gates_service.list_gates(fid)
        assert len(loaded_gates) == 1
        eg = loaded_gates[0]
        assert eg.type == "ellipse"
        assert eg.center_x == 400.0
        assert eg.center_y == 600.0
        assert eg.radius_x == 120.0
        assert eg.radius_y == 80.0
        assert eg.angle == 30.0
        assert eg.count > 0

    def test_ellipse_count_matches_after_reload(self):
        """Event count after reload equals the original count."""
        fid = _make_synthetic_file(n_events=200, seed=88)
        gates_service.create_gate(GateCreateRequest(
            file_id=fid, name="EllipseCount",
            x_channel="CH1", y_channel="CH2",
            params=EllipseGateCreate(type="ellipse", center_x=500, center_y=500, radius_x=200, radius_y=150),
        ))
        original_count = gates_service.list_gates(fid)[0].count

        ws = build_workspace_save([fid])
        reset_gate_store()
        load_workspace(ws)

        reloaded_count = gates_service.list_gates(fid)[0].count
        assert reloaded_count == original_count
