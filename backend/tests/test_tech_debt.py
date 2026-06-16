"""Technical-debt regression tests.

D-KI-1: _point_in_polygon must not emit a divide-by-zero RuntimeWarning for
        polygons with horizontal edges.
D-KI-2: _compute_stats must compute pct_of_parent against the parent population
        even when the parent's count cache is cold (warming it recursively).
"""

from __future__ import annotations

import os
import sys
import warnings

import numpy as np
import pytest

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from models.file_models import ChannelMetadata, FileMetadata
from models.gate_models import GateCreateRequest, RectangleGateCreate
from services import gates as gates_service
from services import storage
from services.gates import _compute_stats, _point_in_polygon, reset_gate_store


@pytest.fixture(autouse=True)
def _clean():
    reset_gate_store()
    yield
    reset_gate_store()


def _make_file(n_events: int = 1000, seed: int = 1, file_id: str = "debt_file") -> str:
    rng = np.random.default_rng(seed)
    events = rng.uniform(0, 1000, size=(n_events, 2)).astype(np.float32)
    channels = [
        ChannelMetadata(name="FSC-A", index=1, stain=None, display_name="FSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="SSC-A", index=2, stain=None, display_name="SSC-A", range=1024.0, amplification=None),
    ]
    meta = FileMetadata(id=file_id, path=f"/test/{file_id}.fcs", sample_name=file_id, event_count=n_events, channels=channels)
    storage.register_file(meta, events)
    return file_id


# ---------------------------------------------------------------------------
# D-KI-1 — polygon divide-by-zero
# ---------------------------------------------------------------------------


class TestPolygonNoDivideByZero:
    def test_axis_aligned_square_no_warning(self):
        """A square has two horizontal edges (denom == 0); evaluating it must not warn."""
        # (5,5) inside; (15,5) right of square; (5,-3) below square.
        x = np.array([5.0, 15.0, 5.0], dtype=float)
        y = np.array([5.0, 5.0, -3.0], dtype=float)
        square = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]
        with warnings.catch_warnings():
            warnings.simplefilter("error")  # any RuntimeWarning becomes an exception
            result = _point_in_polygon(x, y, square)
        np.testing.assert_array_equal(result, np.array([True, False, False]))

    def test_horizontal_edge_membership_still_correct(self):
        """Result correctness is unchanged by the horizontal-edge guard."""
        # Triangle with a horizontal base from (0,0) to (10,0), apex at (5,10).
        tri = [[0.0, 0.0], [10.0, 0.0], [5.0, 10.0]]
        # (5,1) inside near the base; (5,11) above the apex → outside;
        # (1,9) left of the left edge (which is at x=4.5 when y=9) → outside.
        x = np.array([5.0, 5.0, 1.0], dtype=float)
        y = np.array([1.0, 11.0, 9.0], dtype=float)
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            result = _point_in_polygon(x, y, tri)
        np.testing.assert_array_equal(result, np.array([True, False, False]))


# ---------------------------------------------------------------------------
# D-KI-2 — cold-cache parent count
# ---------------------------------------------------------------------------


class TestColdCacheParentCount:
    def test_compute_stats_warms_cold_parent(self):
        """_compute_stats on a child with a cold parent cache uses the parent count."""
        fid = _make_file(n_events=1000, seed=2)
        # Parent rectangle covering roughly the upper-right quadrant.
        parent = gates_service.create_gate(GateCreateRequest(
            file_id=fid, name="Parent",
            x_channel="FSC-A", y_channel="SSC-A",
            params=RectangleGateCreate(type="rectangle", x_min=500, y_min=500, x_max=1000, y_max=1000),
        ))
        child = gates_service.create_gate(GateCreateRequest(
            file_id=fid, name="Child",
            x_channel="FSC-A", y_channel="SSC-A",
            parent_gate_id=parent.id,
            params=RectangleGateCreate(type="rectangle", x_min=600, y_min=600, x_max=900, y_max=900),
        ))

        # Force a cold cache on BOTH gates, then compute the child directly.
        gates_service.invalidate_file_caches(fid)
        child_rec = gates_service._store.gates_by_id[child.id]
        parent_rec = gates_service._store.gates_by_id[parent.id]
        assert parent_rec._cached_count is None  # parent is genuinely cold

        _compute_stats(child_rec)

        # parent_count must equal the parent population, not the whole file (1000).
        assert child_rec._cached_parent_count == parent_rec._cached_count
        assert child_rec._cached_parent_count < 1000
        # pct_of_parent is relative to the parent, so strictly greater than pct_of_total.
        assert child_rec._cached_pct_of_parent >= child_rec._cached_pct_total

    def test_pct_of_parent_consistent_with_list_order(self):
        """Computing a child first (cold parent) matches the normal list_gates result."""
        fid = _make_file(n_events=800, seed=3)
        parent = gates_service.create_gate(GateCreateRequest(
            file_id=fid, name="P",
            x_channel="FSC-A", y_channel="SSC-A",
            params=RectangleGateCreate(type="rectangle", x_min=200, y_min=200, x_max=800, y_max=800),
        ))
        child = gates_service.create_gate(GateCreateRequest(
            file_id=fid, name="C",
            x_channel="FSC-A", y_channel="SSC-A",
            parent_gate_id=parent.id,
            params=RectangleGateCreate(type="rectangle", x_min=300, y_min=300, x_max=700, y_max=700),
        ))
        # Baseline via the normal parent-before-child path.
        baseline = {g.id: g.pct_of_parent for g in gates_service.list_gates(fid)}

        # Now invalidate and compute the child directly (cold parent).
        gates_service.invalidate_file_caches(fid)
        child_rec = gates_service._store.gates_by_id[child.id]
        _compute_stats(child_rec)
        # baseline pct_of_parent is rounded to 2 dp in the response; round to match.
        assert round(child_rec._cached_pct_of_parent, 2) == pytest.approx(baseline[child.id])
