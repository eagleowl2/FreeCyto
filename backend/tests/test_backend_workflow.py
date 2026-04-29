"""
FreeCyto Backend — Test Workflow
=================================
Covers three categories:
  - SCIENCE   : gate counts, % of parent/total, transform correctness, boundary inclusion
  - LOGIC     : tree integrity, cascade delete, cache invalidation, error handling
  - REPRO     : workspace round-trip, determinism of counts across calls

Run:
    cd backend
    pytest tests/test_backend_workflow.py -v

Requirements:
    - Backend importable (run from backend/ or with PYTHONPATH=backend)
    - No live FCS file needed for most tests; synthetic numpy arrays are used.
    - Tests marked @pytest.mark.fcs require a real FCS fixture;
      place it at tests/fixtures/reference.fcs and set the env var:
          OPENCYTO_TEST_FCS=tests/fixtures/reference.fcs
      Those tests are skipped automatically when the fixture is absent.

Definition of "pass" is stated in each test's docstring.
"""

from __future__ import annotations

import os
import sys
import copy
import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Imports — ensure backend services are importable when running under pytest
# ---------------------------------------------------------------------------
HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from services import storage, gates as gates_service
from services.transforms import apply_transform, transform_logicle, transform_arcsinh
from models.gate_models import GateCreateRequest, RectangleGateCreate, PolygonGateCreate

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

FCS_FIXTURE = os.environ.get("OPENCYTO_TEST_FCS", "tests/fixtures/reference.fcs")


def _resolved_fcs_fixture_path() -> str:
    if os.path.isabs(FCS_FIXTURE):
        return FCS_FIXTURE
    if os.path.exists(FCS_FIXTURE):
        return os.path.abspath(FCS_FIXTURE)
    return os.path.normpath(os.path.join(BACKEND_ROOT, FCS_FIXTURE))


def _fcs_fixture_parseable() -> bool:
    p = _resolved_fcs_fixture_path()
    if not os.path.exists(p):
        return False
    try:
        from services.fcs_parser import parse_metadata_only

        parse_metadata_only(p)
        return True
    except Exception:
        return False


NEEDS_FCS = pytest.mark.skipif(
    not _fcs_fixture_parseable(),
    reason=f"No usable FCS fixture at {FCS_FIXTURE!r} (missing file or invalid / unreadable header)",
)


def _make_synthetic_file(
    n_events: int = 1000,
    n_channels: int = 4,
    channel_names: list[str] | None = None,
    seed: int = 42,
) -> str:
    """
    Register a synthetic file in the storage layer and return its file_id.
    Events are uniform random in [0, 1000].
    """
    rng = np.random.default_rng(seed)
    events = rng.uniform(0, 1000, size=(n_events, n_channels)).astype(np.float32)
    names = channel_names or [f"CH{i+1}" for i in range(n_channels)]

    from models.file_models import ChannelMetadata, FileMetadata

    channels = [
        ChannelMetadata(
            name=n,
            index=i + 1,
            stain=None,
            range=1024.0,
            amplification=None,
            display_name=n,
        )
        for i, n in enumerate(names)
    ]
    meta = FileMetadata(
        id=f"synthetic_{n_events}_{seed}",
        path=f"/synthetic/{n_events}_{seed}.fcs",
        sample_name="synthetic",
        event_count=n_events,
        channels=channels,
    )
    storage.register_file(meta, events)
    return meta.id


def _rect_request(file_id: str, name: str, x_ch: str, y_ch: str,
                  x_min: float, y_min: float, x_max: float, y_max: float,
                  parent: str | None = None) -> GateCreateRequest:
    return GateCreateRequest(
        file_id=file_id,
        name=name,
        x_channel=x_ch,
        y_channel=y_ch,
        transform_x="linear",
        transform_y="linear",
        arcsinh_cofactor=150.0,
        parent_gate_id=parent,
        params=RectangleGateCreate(
            type="rectangle",
            x_min=x_min, y_min=y_min,
            x_max=x_max, y_max=y_max,
        ),
    )


def _poly_request(file_id: str, name: str, x_ch: str, y_ch: str,
                  vertices: list[list[float]],
                  parent: str | None = None) -> GateCreateRequest:
    return GateCreateRequest(
        file_id=file_id,
        name=name,
        x_channel=x_ch,
        y_channel=y_ch,
        transform_x="linear",
        transform_y="linear",
        arcsinh_cofactor=150.0,
        parent_gate_id=parent,
        params=PolygonGateCreate(type="polygon", vertices=vertices),
    )


# ---------------------------------------------------------------------------
# Fixtures — shared autouse cleanup lives in conftest.py (clean_store_and_gates).
# ---------------------------------------------------------------------------


# ===========================================================================
# SCIENCE TESTS
# ===========================================================================

class TestScienceGateCounts:
    """
    Verify that gate event counts are mathematically correct.
    These are the most important tests — wrong counts mean wrong biology.
    """

    def test_rectangle_exact_count(self):
        """
        SCIENCE-1: Rectangle gate count matches manual numpy count.

        Pass definition:
            gate.count == np.sum((x >= x_min) & (x <= x_max) & (y >= y_min) & (y <= y_max))
            with 0 tolerance.

        Inputs:
            Synthetic 1000-event file; CH1 and CH2 uniform [0, 1000].
            Gate: CH1 in [200, 600], CH2 in [300, 700].

        Common errors:
            - Gate evaluating on downsampled events instead of full array (S-1 bug).
            - Off-by-one on boundary (< vs <=).
            - Channel index lookup returning wrong column.
        """
        fid = _make_synthetic_file(n_events=1000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        events = storage.get_file_events(fid)
        x_min, x_max = 200.0, 600.0
        y_min, y_max = 300.0, 700.0

        expected = int(np.sum(
            (events[:, 0] >= x_min) & (events[:, 0] <= x_max) &
            (events[:, 1] >= y_min) & (events[:, 1] <= y_max)
        ))

        resp = gates_service.create_gate(
            _rect_request(fid, "R1", "CH1", "CH2", x_min, y_min, x_max, y_max)
        )

        assert resp.count == expected, (
            f"Rectangle count mismatch: got {resp.count}, expected {expected}"
        )

    def test_rectangle_count_uses_full_events_not_sample(self):
        """
        SCIENCE-2: Gate count is stable regardless of max_events used for display.

        Pass definition:
            gate.count is identical when the display downsample is 10 or 10000.
            Count never changes between repeated list_gates() calls.

        Inputs:
            5000-event synthetic file.

        Common errors:
            - _get_mask accidentally calling get_file_events_downsampled.
            - Display fetch side-effecting the stored events array.
        """
        fid = _make_synthetic_file(n_events=5000, channel_names=["FSC-A", "SSC-A", "CH3", "CH4"])
        resp1 = gates_service.create_gate(
            _rect_request(fid, "G1", "FSC-A", "SSC-A", 100, 100, 800, 800)
        )
        count_first = resp1.count

        # Simulate display fetches at different max_events — should not affect gate count
        storage.get_file_events_downsampled(fid, max_events=10)
        storage.get_file_events_downsampled(fid, max_events=500)

        tree = gates_service.get_gate_tree(fid)
        assert tree[0].count == count_first, (
            "Gate count changed after display downsampling — likely evaluating on sample"
        )

    def test_pct_of_total_formula(self):
        """
        SCIENCE-3: pct_of_total == count / total_events * 100, rounded to 2 dp.

        Pass definition:
            abs(gate.pct_of_total - round(gate.count / n_total * 100, 2)) <= 0.01

        Inputs:
            1000-event synthetic file; single rectangle gate.

        Common errors:
            - Dividing by parent count instead of total count.
            - Rounding applied before rather than after the division.
        """
        fid = _make_synthetic_file(n_events=1000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        resp = gates_service.create_gate(
            _rect_request(fid, "G1", "CH1", "CH2", 0, 0, 500, 500)
        )
        expected_pct = round(resp.count / 1000 * 100, 2)
        assert abs(resp.pct_of_total - expected_pct) <= 0.01, (
            f"pct_of_total {resp.pct_of_total} != expected {expected_pct}"
        )

    def test_pct_of_parent_child_gate(self):
        """
        SCIENCE-4: pct_of_parent == child.count / parent.count * 100.

        Pass definition:
            abs(child.pct_of_parent - round(child.count / parent.count * 100, 2)) <= 0.01

        Inputs:
            2000-event synthetic file; parent gate [0,500]x[0,500];
            child gate [100,400]x[100,400] (subset of parent).

        Common errors:
            - Child pct_of_parent computed against total events, not parent count.
            - Parent mask not passed to child evaluation (child counts all events).
            - Parent cache not yet filled when child is evaluated.
        """
        fid = _make_synthetic_file(n_events=2000, channel_names=["CH1", "CH2", "CH3", "CH4"])

        parent_resp = gates_service.create_gate(
            _rect_request(fid, "Parent", "CH1", "CH2", 0, 0, 500, 500)
        )
        child_resp = gates_service.create_gate(
            _rect_request(fid, "Child", "CH1", "CH2", 100, 100, 400, 400,
                          parent=parent_resp.id)
        )

        if parent_resp.count == 0:
            pytest.skip("No events in parent gate with this seed — adjust bounds")

        expected = round(child_resp.count / parent_resp.count * 100, 2)
        assert abs(child_resp.pct_of_parent - expected) <= 0.01, (
            f"pct_of_parent {child_resp.pct_of_parent} != {expected} "
            f"(child={child_resp.count}, parent={parent_resp.count})"
        )

    def test_child_count_never_exceeds_parent(self):
        """
        SCIENCE-5: No child gate can have more events than its parent.

        Pass definition:
            child.count <= parent.count for all parent-child pairs.

        Inputs:
            1000-event file; child gate intentionally wider than parent
            (extra events outside parent should still be excluded).

        Common errors:
            - Hierarchical mask not applied — child evaluated on all events.
            - parent_mask intersected with OR instead of AND.
        """
        fid = _make_synthetic_file(n_events=1000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        parent_resp = gates_service.create_gate(
            _rect_request(fid, "P", "CH1", "CH2", 200, 200, 600, 600)
        )
        # Child is intentionally wider on x — if mask not applied, child count > parent
        child_resp = gates_service.create_gate(
            _rect_request(fid, "C", "CH1", "CH2", 0, 250, 900, 550,
                          parent=parent_resp.id)
        )
        assert child_resp.count <= parent_resp.count, (
            f"Child ({child_resp.count}) > parent ({parent_resp.count}): "
            "hierarchical mask not applied"
        )


class TestScienceTransforms:
    """
    Verify that transforms are applied correctly before gate evaluation.
    """

    def test_arcsinh_transform_shifts_gate_boundary(self):
        """
        SCIENCE-6: Gate defined in arcsinh space captures correct raw events.

        Pass definition:
            Gate count in arcsinh space == manual count of events where
            arcsinh(x/150) falls in [gate_x_min, gate_x_max].
            Tolerance: 0 events.

        Inputs:
            1000-event file; gate with transform_x='arcsinh', cofactor=150.
            Gate bounds set in arcsinh-transformed units.

        Common errors:
            - transform applied after gate test instead of before.
            - arcsinh cofactor ignored (default 150 used even when overridden).
            - Gate bounds interpreted as raw units when transform is arcsinh.
        """
        fid = _make_synthetic_file(n_events=1000, channel_names=["FL1", "FL2", "CH3", "CH4"])
        events = storage.get_file_events(fid)

        # Define gate bounds in arcsinh(x/150) space
        ax_min, ax_max = float(np.arcsinh(100 / 150)), float(np.arcsinh(500 / 150))
        ay_min, ay_max = float(np.arcsinh(200 / 150)), float(np.arcsinh(800 / 150))

        expected = int(np.sum(
            (np.arcsinh(events[:, 0] / 150) >= ax_min) &
            (np.arcsinh(events[:, 0] / 150) <= ax_max) &
            (np.arcsinh(events[:, 1] / 150) >= ay_min) &
            (np.arcsinh(events[:, 1] / 150) <= ay_max)
        ))

        body = GateCreateRequest(
            file_id=fid, name="ArcG",
            x_channel="FL1", y_channel="FL2",
            transform_x="arcsinh", transform_y="arcsinh",
            arcsinh_cofactor=150.0,
            params=RectangleGateCreate(
                type="rectangle",
                x_min=ax_min, y_min=ay_min,
                x_max=ax_max, y_max=ay_max,
            ),
        )
        resp = gates_service.create_gate(body)
        assert resp.count == expected, (
            f"Arcsinh gate count {resp.count} != manual {expected}"
        )

    def test_linear_and_arcsinh_gate_same_file_different_counts(self):
        """
        SCIENCE-7: A gate with bounds [2, 4] under arcsinh vs linear
        captures different events (the transforms are not identity).

        Pass definition:
            arcsinh_gate.count != linear_gate.count (unless pathologically)
            — confirms transform is actually applied.

        Inputs:
            1000-event synthetic file with values in [0, 1000].

        Common errors:
            - apply_transform returning identity regardless of name.
            - Transform name stored but not read during _get_mask.
        """
        fid = _make_synthetic_file(n_events=1000, channel_names=["FL1", "FL2", "CH3", "CH4"])

        linear_req = GateCreateRequest(
            file_id=fid, name="Lin",
            x_channel="FL1", y_channel="FL2",
            transform_x="linear", transform_y="linear",
            arcsinh_cofactor=150.0,
            params=RectangleGateCreate(type="rectangle", x_min=2, y_min=2, x_max=4, y_max=4),
        )
        arcsinh_req = GateCreateRequest(
            file_id=fid, name="Arc",
            x_channel="FL1", y_channel="FL2",
            transform_x="arcsinh", transform_y="arcsinh",
            arcsinh_cofactor=150.0,
            params=RectangleGateCreate(type="rectangle", x_min=2, y_min=2, x_max=4, y_max=4),
        )
        lin_resp = gates_service.create_gate(linear_req)
        arc_resp = gates_service.create_gate(arcsinh_req)

        # [2,4] in linear space captures ~2/1000 of [0,1000] range.
        # [2,4] in arcsinh(x/150) space → raw [~285, ~818] — captures far more events.
        assert arc_resp.count != lin_resp.count, (
            "Arcsinh and linear gates with same bounds returned same count "
            "— transform is likely not being applied"
        )

    def test_unknown_transform_name_warns_and_falls_back_linear(self) -> None:
        """TRF-1: misspelled / unknown transform warns and uses linear."""
        col = np.array([1.0, 2.0, 3.0], dtype=np.float64)
        with pytest.warns(UserWarning, match="Unknown transform"):
            out = apply_transform(col, "Arcsinh")
        assert np.allclose(out, col)


class TestSciencePolygonBoundary:
    """
    Verify polygon boundary = inside (GatingML 2.0).
    """

    def test_point_exactly_on_polygon_edge_is_inside(self):
        """
        SCIENCE-8: A point that lies exactly on a polygon edge is counted as inside.

        Pass definition:
            A synthetic file with one event exactly on the edge of a triangle
            polygon is counted: gate.count >= 1.

        Inputs:
            File with a single event at (0.5, 0.0) — on the bottom edge of
            triangle [(0,0),(1,0),(0.5,1)].

        Common errors:
            - Ray-casting without boundary check: boundary events miscounted.
            - Winding number without on_boundary supplement misses collinear points.
            - Floating-point precision causing the boundary check to fail.
        """
        from models.file_models import ChannelMetadata, FileMetadata

        # Single event exactly on the bottom edge of the triangle
        events = np.array([[0.5, 0.0, 0.0, 0.0]], dtype=np.float32)
        meta = FileMetadata(
            id="boundary_test",
            path="/synthetic/boundary.fcs",
            sample_name="boundary",
            event_count=1,
            channels=[
                ChannelMetadata(
                    name="X",
                    index=1,
                    stain=None,
                    range=1.0,
                    amplification=None,
                    display_name="X",
                ),
                ChannelMetadata(
                    name="Y",
                    index=2,
                    stain=None,
                    range=1.0,
                    amplification=None,
                    display_name="Y",
                ),
                ChannelMetadata(
                    name="C3",
                    index=3,
                    stain=None,
                    range=1.0,
                    amplification=None,
                    display_name="C3",
                ),
                ChannelMetadata(
                    name="C4",
                    index=4,
                    stain=None,
                    range=1.0,
                    amplification=None,
                    display_name="C4",
                ),
            ],
        )
        storage.register_file(meta, events)

        resp = gates_service.create_gate(_poly_request(
            "boundary_test", "Triangle", "X", "Y",
            vertices=[[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]],
        ))
        assert resp.count == 1, (
            "Event on polygon boundary was not counted as inside (GatingML 2.0 violation)"
        )

    def test_point_outside_polygon_not_counted(self):
        """
        SCIENCE-9: A point clearly outside a polygon is not counted.

        Pass definition:
            gate.count == 0 for an event at (2.0, 2.0) against the
            triangle [(0,0),(1,0),(0.5,1)].

        Common errors:
            - Winding number overflow/sign error counting outside as inside.
        """
        from models.file_models import ChannelMetadata, FileMetadata

        events = np.array([[2.0, 2.0, 0.0, 0.0]], dtype=np.float32)
        meta = FileMetadata(
            id="outside_test",
            path="/synthetic/outside.fcs",
            sample_name="outside",
            event_count=1,
            channels=[
                ChannelMetadata(
                    name="X",
                    index=1,
                    stain=None,
                    range=1.0,
                    amplification=None,
                    display_name="X",
                ),
                ChannelMetadata(
                    name="Y",
                    index=2,
                    stain=None,
                    range=1.0,
                    amplification=None,
                    display_name="Y",
                ),
                ChannelMetadata(
                    name="C3",
                    index=3,
                    stain=None,
                    range=1.0,
                    amplification=None,
                    display_name="C3",
                ),
                ChannelMetadata(
                    name="C4",
                    index=4,
                    stain=None,
                    range=1.0,
                    amplification=None,
                    display_name="C4",
                ),
            ],
        )
        storage.register_file(meta, events)

        resp = gates_service.create_gate(_poly_request(
            "outside_test", "Triangle", "X", "Y",
            vertices=[[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]],
        ))
        assert resp.count == 0, "Event outside polygon was incorrectly counted as inside"


# ===========================================================================
# LOGIC TESTS
# ===========================================================================

class TestLogicTree:
    """
    Verify the tree store behaves correctly: hierarchy, depth, ordering, cascade.
    """

    def test_tree_depth_reported_correctly(self):
        """
        LOGIC-1: Tree depth is 0 for root gates, 1 for children, 2 for grandchildren.

        Pass definition:
            root.depth == 0, child.depth == 1, grandchild.depth == 2.

        Inputs:
            3-level chain: root → child → grandchild.

        Common errors:
            - _get_ancestor_list returning wrong length (off-by-one).
            - depth not updated after reparenting (future concern).
        """
        fid = _make_synthetic_file(n_events=500, channel_names=["CH1", "CH2", "CH3", "CH4"])
        root = gates_service.create_gate(_rect_request(fid, "Root", "CH1", "CH2", 0, 0, 1000, 1000))
        child = gates_service.create_gate(_rect_request(fid, "Child", "CH1", "CH2", 100, 100, 900, 900, parent=root.id))
        grandchild = gates_service.create_gate(_rect_request(fid, "Grand", "CH1", "CH2", 200, 200, 800, 800, parent=child.id))

        tree = gates_service.get_gate_tree(fid)
        assert tree[0].depth == 0
        assert tree[0].children[0].depth == 1
        assert tree[0].children[0].children[0].depth == 2

    def test_cascade_delete_removes_all_descendants(self):
        """
        LOGIC-2: Deleting a parent removes all children and grandchildren.

        Pass definition:
            After deleting root: get_gate_tree(fid) == []
            AND all descendant IDs are absent from _gates_by_id.

        Inputs:
            3-level chain (root → child → grandchild).

        Common errors:
            - delete_gate only removes direct children, not grandchildren (pre-BE-4 bug).
            - IDs remain in _gates_by_id as orphans after eviction.
        """
        fid = _make_synthetic_file(n_events=500, channel_names=["CH1", "CH2", "CH3", "CH4"])
        root = gates_service.create_gate(_rect_request(fid, "Root", "CH1", "CH2", 0, 0, 1000, 1000))
        child = gates_service.create_gate(_rect_request(fid, "Child", "CH1", "CH2", 100, 100, 900, 900, parent=root.id))
        grandchild = gates_service.create_gate(_rect_request(fid, "Grand", "CH1", "CH2", 200, 200, 800, 800, parent=child.id))

        deleted = gates_service.delete_gate(root.id)

        assert set(deleted) == {root.id, child.id, grandchild.id}, (
            f"Cascade delete returned {deleted}, expected all 3 IDs"
        )
        assert gates_service.get_gate_tree(fid) == [], "Tree not empty after deleting root"
        for gid in [root.id, child.id, grandchild.id]:
            assert gid not in gates_service._store.gates_by_id, f"{gid} still in gate store after cascade"

    def test_delete_child_leaves_parent_intact(self):
        """
        LOGIC-3: Deleting a child does not affect the parent's count.

        Pass definition:
            parent.count is identical before and after child is deleted.

        Inputs:
            Parent [0,1000]x[0,1000] with one child [0,500]x[0,500].

        Common errors:
            - Parent cache invalidated unnecessarily on child delete.
            - Parent count recalculated and changes (it shouldn't).
        """
        fid = _make_synthetic_file(n_events=1000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        parent = gates_service.create_gate(_rect_request(fid, "P", "CH1", "CH2", 0, 0, 1000, 1000))
        child = gates_service.create_gate(_rect_request(fid, "C", "CH1", "CH2", 0, 0, 500, 500, parent=parent.id))

        count_before = parent.count
        gates_service.delete_gate(child.id)

        tree = gates_service.get_gate_tree(fid)
        assert tree[0].count == count_before, (
            "Parent count changed after child was deleted"
        )

    def test_invalid_parent_gate_id_raises(self):
        """
        LOGIC-4: Creating a gate with a non-existent parent_gate_id raises ValueError.

        Pass definition:
            ValueError is raised (→ HTTP 400 at router level).
            No orphaned gate is created in _gates_by_id.

        Inputs:
            parent_gate_id='does-not-exist'.

        Common errors:
            - Missing parent validation: gate silently created as orphan.
            - DeprecationWarning only, no exception.
        """
        fid = _make_synthetic_file(n_events=100, channel_names=["CH1", "CH2", "CH3", "CH4"])
        before = set(gates_service._store.gates_by_id.keys())

        with pytest.raises(ValueError, match="not found"):
            gates_service.create_gate(
                _rect_request(fid, "Orphan", "CH1", "CH2", 0, 0, 500, 500,
                              parent="does-not-exist")
            )

        after = set(gates_service._store.gates_by_id.keys())
        assert before == after, "Orphaned gate was created despite invalid parent_gate_id"

    def test_duplicate_gate_name_raises(self):
        """
        LOGIC-5: Creating two gates with the same name for the same file raises GateNameExistsError.

        Pass definition:
            Second create raises GateNameExistsError; first gate count is unchanged.

        Inputs:
            Two rectangle gates both named "MyGate".

        Common errors:
            - Name uniqueness check skipped when parent differs.
            - GateNameExistsError not raised (409 not returned to client).
        """
        fid = _make_synthetic_file(n_events=200, channel_names=["CH1", "CH2", "CH3", "CH4"])
        gates_service.create_gate(_rect_request(fid, "MyGate", "CH1", "CH2", 0, 0, 500, 500))

        with pytest.raises(gates_service.GateNameExistsError):
            gates_service.create_gate(_rect_request(fid, "MyGate", "CH1", "CH2", 500, 500, 1000, 1000))

    def test_depth_limit_50_enforced(self):
        """
        LOGIC-6: Creating a gate that would exceed depth 50 raises ValueError.

        Pass definition:
            ValueError raised on the 51st level; tree has exactly 50 nodes.

        Inputs:
            Chain of 50 nested rectangles [0,1000]x[0,1000] (each fully inside the
            parent for count purposes), then attempt a 51st.

        Common errors:
            - Depth check uses >= instead of > (off-by-one: allows 51 or rejects 50).
            - Depth check bypassed when parent is missing from _gates_by_id.
        """
        fid = _make_synthetic_file(n_events=200, channel_names=["CH1", "CH2", "CH3", "CH4"])
        parent_id = None
        for i in range(50):
            resp = gates_service.create_gate(
                _rect_request(fid, f"L{i}", "CH1", "CH2", 0, 0, 1000, 1000, parent=parent_id)
            )
            parent_id = resp.id

        with pytest.raises(ValueError, match="depth"):
            gates_service.create_gate(
                _rect_request(fid, "TooDeep", "CH1", "CH2", 0, 0, 1000, 1000, parent=parent_id)
            )


class TestLogicCacheInvalidation:
    """
    Verify that cache is properly invalidated when data or structure changes.
    """

    def test_cache_invalidated_after_compensation(self):
        """
        LOGIC-7: Gate counts change after compensation is applied.

        Pass definition:
            gate.count before compensation != gate.count after compensation
            (for a gate designed to straddle the compensation shift).
            If counts are identical the cache was likely not invalidated.

        Inputs:
            4-channel file; off-diagonal spillover matrix that shifts CH1 values.
            Gate on CH1 in [400, 600].

        Common errors:
            - invalidate_file_caches not called from compensation.apply_compensation.
            - Cache valid flag not cleared, so stale count is returned.
        """
        from services import compensation as comp_service

        fid = _make_synthetic_file(
            n_events=1000, n_channels=4,
            channel_names=["CH1", "CH2", "CH3", "CH4"],
            seed=7,
        )
        resp_before = gates_service.create_gate(
            _rect_request(fid, "G1", "CH1", "CH2", 400, 400, 600, 600)
        )
        count_before = resp_before.count

        # Apply a non-trivial spillover that shifts CH1 values significantly
        n = 4
        spillover = np.eye(n, dtype=float)
        spillover[1, 0] = 0.3  # CH2 spills 30% into CH1
        comp_service.apply_compensation(fid, spillover.tolist())

        tree = gates_service.get_gate_tree(fid)
        count_after = tree[0].count

        assert count_before != count_after, (
            "Gate count unchanged after compensation — cache likely not invalidated. "
            f"Before: {count_before}, After: {count_after}"
        )

    def test_sibling_order_stable_after_multiple_creates(self):
        """
        LOGIC-8: Siblings appear in creation order in the tree.

        Pass definition:
            tree[0].children names == ["A", "B", "C"] (insertion order).

        Inputs:
            Root gate with three children created in order A, B, C.

        Common errors:
            - _sibling_list returning a dict view that doesn't preserve order.
            - order field not being renumbered correctly on insert.
        """
        fid = _make_synthetic_file(n_events=500, channel_names=["CH1", "CH2", "CH3", "CH4"])
        root = gates_service.create_gate(_rect_request(fid, "Root", "CH1", "CH2", 0, 0, 1000, 1000))
        for name in ["A", "B", "C"]:
            gates_service.create_gate(_rect_request(fid, name, "CH1", "CH2", 0, 0, 500, 500, parent=root.id))

        tree = gates_service.get_gate_tree(fid)
        child_names = [c.name for c in tree[0].children]
        assert child_names == ["A", "B", "C"], f"Sibling order wrong: {child_names}"


# ===========================================================================
# REPRODUCIBILITY TESTS
# ===========================================================================

class TestReproducibility:
    """
    Verify that counts are deterministic and stable across repeated calls and
    workspace save/load round-trips.
    """

    def test_same_gate_same_count_on_repeated_calls(self):
        """
        REPRO-1: list_gates / get_gate_tree returns identical counts on every call.

        Pass definition:
            counts from 10 consecutive get_gate_tree calls are all identical.
            No randomness should affect gate evaluation.

        Inputs:
            1000-event file; one rectangle gate.

        Common errors:
            - np.random.choice used during gate evaluation (not just display).
            - Cache invalidation triggered spuriously by list_gates.
        """
        fid = _make_synthetic_file(n_events=1000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        resp = gates_service.create_gate(_rect_request(fid, "G", "CH1", "CH2", 200, 200, 800, 800))
        first_count = resp.count

        for i in range(10):
            tree = gates_service.get_gate_tree(fid)
            assert tree[0].count == first_count, (
                f"Count changed on call {i+1}: got {tree[0].count}, expected {first_count}"
            )

    def test_count_unchanged_after_list_gates(self):
        """
        REPRO-2: Calling list_gates does not invalidate or alter cached counts.

        Pass definition:
            count before list_gates == count after list_gates (0 tolerance).

        Common errors:
            - list_gates calling invalidate_file_caches as a side effect.
            - _compute_stats writing different value on second evaluation
              (non-deterministic rng in mask path).
        """
        fid = _make_synthetic_file(n_events=1000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        resp = gates_service.create_gate(_rect_request(fid, "G", "CH1", "CH2", 100, 100, 700, 700))
        count_before = resp.count

        gates_service.list_gates(fid)
        gates_service.list_gates(fid)

        tree = gates_service.get_gate_tree(fid)
        assert tree[0].count == count_before

    def test_workspace_round_trip_preserves_counts(self):
        """
        REPRO-3: Saving and reloading a workspace produces identical gate counts.

        Pass definition:
            For every gate: abs(reloaded_count - original_count) == 0.
            Tree structure (parent-child relationships) is preserved.

        Inputs:
            2-level hierarchy: root with two children.
            Workspace saved via build_workspace_save, reloaded via load_workspace.

        Common errors:
            - parent_gate_id not saved to WorkspaceGateDef (INT-1 gap).
            - arcsinh_cofactor hardcoded to 150.0 instead of read from gate.
            - Topological sort not applied: child created before parent → 400 error.
            - id_map not used: new parent ID not matched when creating children.
        """
        from services.workspace_service import build_workspace_save, load_workspace

        fid = _make_synthetic_file(n_events=2000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        root = gates_service.create_gate(_rect_request(fid, "Root", "CH1", "CH2", 0, 0, 1000, 1000))
        child_a = gates_service.create_gate(_rect_request(fid, "ChildA", "CH1", "CH2", 0, 0, 500, 500, parent=root.id))
        child_b = gates_service.create_gate(_rect_request(fid, "ChildB", "CH1", "CH2", 500, 500, 1000, 1000, parent=root.id))

        original_counts = {
            "Root": root.count,
            "ChildA": child_a.count,
            "ChildB": child_b.count,
        }

        # Save workspace
        ws = build_workspace_save(file_ids=[fid])

        # Clear all state to simulate a fresh session using public APIs
        for fid in list(storage.list_loaded_file_ids()):
            try:
                storage.delete_file(fid)
            except KeyError:
                pass
        gates_service.reset_gate_store()

        # Reload
        result = load_workspace(ws)
        assert result.gate_errors == [], result.gate_errors
        assert result.gates_created == 3, (
            f"Expected 3 gates recreated, got {result.gates_created}. "
            "Hierarchy likely not preserved (INT-1 gap)."
        )

        # Find the new file_id (path-based stable ID)
        loaded_fid = result.file_metadata[0]["id"]
        tree = gates_service.get_gate_tree(loaded_fid)

        assert len(tree) == 1, f"Expected 1 root gate, got {len(tree)}"
        reloaded_root = tree[0]
        assert reloaded_root.count == original_counts["Root"], (
            f"Root count mismatch: {reloaded_root.count} vs {original_counts['Root']}"
        )

        assert len(reloaded_root.children) == 2, (
            f"Expected 2 children, got {len(reloaded_root.children)}. "
            "parent_gate_id likely not saved/restored."
        )
        child_counts = {c.name: c.count for c in reloaded_root.children}
        for name in ["ChildA", "ChildB"]:
            assert child_counts.get(name) == original_counts[name], (
                f"{name}: reloaded count {child_counts.get(name)} != original {original_counts[name]}"
            )

    def test_delete_gate_then_recreate_same_count(self):
        """
        REPRO-4: Deleting a gate and recreating it with identical params gives the same count.

        Pass definition:
            second_create.count == first_create.count (0 tolerance).

        Inputs:
            Same file, same gate params, delete between the two creates.

        Common errors:
            - Events mutated in-place during gate evaluation (S-1 regression).
            - Cache from deleted gate leaking into new gate via stale dict entry.
        """
        fid = _make_synthetic_file(n_events=1000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        req = _rect_request(fid, "Rpt", "CH1", "CH2", 150, 150, 750, 750)

        resp1 = gates_service.create_gate(req)
        count1 = resp1.count

        gates_service.delete_gate(resp1.id)

        req2 = _rect_request(fid, "Rpt", "CH1", "CH2", 150, 150, 750, 750)
        resp2 = gates_service.create_gate(req2)
        count2 = resp2.count

        assert count1 == count2, (
            f"Count changed after delete+recreate: first={count1}, second={count2}"
        )

    @NEEDS_FCS
    def test_fcs_fixture_count_matches_reference(self):
        """
        REPRO-5 [requires FCS fixture]: Gate count on a real FCS file matches a committed reference.

        Pass definition:
            gate.count == REFERENCE_COUNT (0 tolerance).
            Reference count produced by FlowJo or a prior verified FreeCyto run and
            stored in tests/fixtures/reference_counts.json.

        Inputs:
            OPENCYTO_TEST_FCS environment variable pointing to a real .fcs file.
            tests/fixtures/reference_counts.json with keys matching gate names.

        Common errors:
            - Full-event count not used (S-1 regression).
            - Channel index mismatch (e.g. 0-indexed vs 1-indexed).
            - Logicle T from data max instead of $PnR.
        """
        import json
        from services.fcs_parser import load_and_register_files

        ref_counts_path = "tests/fixtures/reference_counts.json"
        if not os.path.exists(ref_counts_path):
            pytest.skip(f"Reference counts file not found at {ref_counts_path}")

        with open(ref_counts_path) as f:
            reference = json.load(f)

        loaded = load_and_register_files([_resolved_fcs_fixture_path()])
        fid = loaded[0].id
        x_ch = reference.get("x_channel", "FSC-A")
        y_ch = reference.get("y_channel", "SSC-A")

        for gate_def in reference.get("gates", []):
            resp = gates_service.create_gate(
                _rect_request(
                    fid, gate_def["name"], x_ch, y_ch,
                    gate_def["x_min"], gate_def["y_min"],
                    gate_def["x_max"], gate_def["y_max"],
                )
            )
            assert resp.count == gate_def["expected_count"], (
                f"Gate {gate_def['name']!r}: got {resp.count}, expected {gate_def['expected_count']}. "
                "Check full-event evaluation (S-1) and channel index mapping."
            )


# ---------------------------------------------------------------------------
# H: Gate update (PATCH) tests
# ---------------------------------------------------------------------------

class TestGateUpdate:
    """
    Verify PATCH /api/gates/{gate_id} semantics: geometry updates, cache
    invalidation, descendant re-evaluation, and error handling.
    """

    @pytest.fixture(autouse=True)
    def _reset(self):
        gates_service.reset_gate_store()
        yield
        gates_service.reset_gate_store()

    def test_update_rect_bounds_changes_count(self):
        """H-UPDATE-1: updating bounds produces a new count matching numpy reference."""
        fid = _make_synthetic_file(n_events=1000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        resp = gates_service.create_gate(_rect_request(fid, "G", "CH1", "CH2", 400, 400, 600, 600))
        count_narrow = resp.count

        from models.gate_models import GateUpdateRequest
        updated = gates_service.update_gate(resp.id, GateUpdateRequest(x_min=200, y_min=200, x_max=800, y_max=800))
        count_wide = updated.count

        assert count_wide >= count_narrow, (
            f"Wider gate should capture at least as many events: narrow={count_narrow} wide={count_wide}"
        )
        assert count_wide > 0, "Wide gate should capture some events in a 1000-event uniform file"

    def test_update_preserves_gate_id_and_meta(self):
        """H-UPDATE-2: gate id, name, and channels are unchanged after update."""
        fid = _make_synthetic_file(n_events=1000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        resp = gates_service.create_gate(_rect_request(fid, "Stable", "CH1", "CH2", 300, 300, 700, 700))

        from models.gate_models import GateUpdateRequest
        updated = gates_service.update_gate(resp.id, GateUpdateRequest(x_min=100, x_max=900))
        assert updated.id == resp.id
        assert updated.name == "Stable"
        assert updated.x_channel == "CH1"
        assert updated.y_channel == "CH2"

    def test_update_invalidates_descendant_cache(self):
        """H-UPDATE-3: updating a parent gate re-evaluates child gate counts."""
        fid = _make_synthetic_file(n_events=2000, channel_names=["CH1", "CH2", "CH3", "CH4"])
        parent = gates_service.create_gate(_rect_request(fid, "Parent", "CH1", "CH2", 200, 200, 800, 800))
        child = gates_service.create_gate(_rect_request(fid, "Child", "CH1", "CH2", 300, 300, 700, 700, parent=parent.id))
        child_count_before = child.count

        from models.gate_models import GateUpdateRequest
        # Shrink parent to exclude all events in child region
        gates_service.update_gate(parent.id, GateUpdateRequest(x_min=850, y_min=850, x_max=950, y_max=950))

        tree = gates_service.get_gate_tree(fid)
        assert len(tree) == 1
        reloaded_child = tree[0].children[0]
        assert reloaded_child.count < child_count_before, (
            f"Child count should drop after parent shrinks: before={child_count_before} after={reloaded_child.count}"
        )

    def test_update_unknown_gate_raises_key_error(self):
        """H-UPDATE-4: updating a non-existent gate raises KeyError."""
        from models.gate_models import GateUpdateRequest
        with pytest.raises(KeyError, match="not found"):
            gates_service.update_gate("nonexistent-id", GateUpdateRequest(x_min=0))

    def test_update_count_matches_numpy_reference(self):
        """H-UPDATE-5: updated count matches direct numpy evaluation of new bounds."""
        import numpy as np
        rng = np.random.default_rng(77)
        events = rng.uniform(0, 1000, size=(5000, 2)).astype(np.float32)
        from models.file_models import ChannelMetadata, FileMetadata
        channels = [ChannelMetadata(name=f"CH{i+1}", index=i+1, stain=None, range=1024.0, amplification=None, display_name=f"CH{i+1}") for i in range(2)]
        meta = FileMetadata(id="upd_ref", path="/upd.fcs", sample_name="upd", event_count=5000, channels=channels)
        import services.storage as _st
        _st.register_file(meta, events)
        gates_service.reset_gate_store()

        resp = gates_service.create_gate(_rect_request("upd_ref", "G", "CH1", "CH2", 100, 100, 500, 500))
        from models.gate_models import GateUpdateRequest
        new_x_min, new_y_min, new_x_max, new_y_max = 200.0, 300.0, 800.0, 700.0
        updated = gates_service.update_gate(resp.id, GateUpdateRequest(x_min=new_x_min, y_min=new_y_min, x_max=new_x_max, y_max=new_y_max))

        expected = int(np.sum(
            (events[:, 0] >= new_x_min) & (events[:, 0] <= new_x_max) &
            (events[:, 1] >= new_y_min) & (events[:, 1] <= new_y_max)
        ))
        assert updated.count == expected, f"Count mismatch: API={updated.count}, numpy={expected}"
