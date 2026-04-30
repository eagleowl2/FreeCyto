"""Phase P — Gate population CSV export tests (P-1).

Covers:
  - export_gate_csv_stream: header row has channel display names
  - row count == gate event count
  - empty gate yields header-only CSV
  - max_events limits the output row count
  - all-events gate (no parent restriction) = total event count
  - non-existent gate raises KeyError
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
from models.gate_models import GateCreateRequest, RectangleGateCreate
from services import gates as gates_service
from services import storage
from services.gates import export_gate_csv_stream, reset_gate_store


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_file(n_events: int = 300, seed: int = 42, file_id: str | None = None) -> str:
    rng = np.random.default_rng(seed)
    events = rng.uniform(0, 1000, size=(n_events, 3)).astype(np.float32)
    fid = file_id or f"test_p_{seed}"
    channels = [
        ChannelMetadata(name="FSC-A", index=1, stain=None, display_name="FSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="SSC-A", index=2, stain=None, display_name="SSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="FL1-A", index=3, stain=None, display_name="CD3 FITC", range=1024.0, amplification=None),
    ]
    meta = FileMetadata(id=fid, path=f"/test/{fid}.fcs", sample_name=fid, event_count=n_events, channels=channels)
    storage.register_file(meta, events)
    return fid


def _rect_gate(
    fid: str,
    name: str = "G",
    x_min: float = 200.0,
    y_min: float = 200.0,
    x_max: float = 800.0,
    y_max: float = 800.0,
    parent_gate_id: str | None = None,
) -> str:
    req = GateCreateRequest(
        file_id=fid,
        name=name,
        x_channel="FSC-A",
        y_channel="SSC-A",
        parent_gate_id=parent_gate_id,
        params=RectangleGateCreate(type="rectangle", x_min=x_min, y_min=y_min, x_max=x_max, y_max=y_max),
    )
    return gates_service.create_gate(req).id


def _collect_csv(gate_id: str, **kwargs) -> list[list[str]]:
    """Run export_gate_csv_stream and return parsed rows (header + data)."""
    rows_iter, _filename, _count = export_gate_csv_stream(gate_id, **kwargs)
    rows = []
    for line in rows_iter:
        stripped = line.rstrip("\n")
        if stripped:
            rows.append(stripped.split(","))
    return rows


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean():
    reset_gate_store()
    yield
    reset_gate_store()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestExportGateCsvStream:
    def test_header_contains_display_names(self):
        fid = _make_file()
        gid = _rect_gate(fid, "G1")
        rows = _collect_csv(gid)
        # First row is header
        assert len(rows) >= 1
        header = rows[0]
        # Display names: FSC-A, SSC-A, CD3 FITC
        assert header == ["FSC-A", "SSC-A", "CD3 FITC"]

    def test_row_count_matches_gate_count(self):
        fid = _make_file(n_events=300, seed=1)
        gid = _rect_gate(fid, "G1", x_min=200.0, y_min=200.0, x_max=800.0, y_max=800.0)
        rows, _fname, count = export_gate_csv_stream(gid)
        data_lines = [r for r in rows if r.strip()]
        all_lines = list(data_lines)
        # count should be header (1) + data rows
        # Reconstruct from returned count
        assert count >= 0
        # Rebuild via _collect_csv
        parsed = _collect_csv(gid)
        assert len(parsed) == count + 1  # header + count data rows

    def test_empty_gate_yields_header_only(self):
        """A gate that captures zero events should produce only the header row."""
        fid = _make_file(n_events=200, seed=2)
        # Impossible bounds → zero events
        gid = _rect_gate(fid, "Empty", x_min=1001.0, y_min=1001.0, x_max=2000.0, y_max=2000.0)
        rows_iter, _fname, count = export_gate_csv_stream(gid)
        all_lines = [l.rstrip("\n") for l in rows_iter if l.strip()]
        assert count == 0
        assert len(all_lines) == 1  # header only

    def test_max_events_limits_output(self):
        """max_events > 0 must cap the number of exported rows."""
        fid = _make_file(n_events=500, seed=3)
        # Wide gate captures almost everything
        gid = _rect_gate(fid, "Wide", x_min=0.0, y_min=0.0, x_max=10000.0, y_max=10000.0)
        _rows_iter, _fname, count_full = export_gate_csv_stream(gid, max_events=0)
        assert count_full > 50, "Expected more than 50 events in wide gate"

        _rows_iter2, _fname2, count_limited = export_gate_csv_stream(gid, max_events=50)
        assert count_limited == 50

    def test_no_limit_exports_all_events(self):
        """max_events=0 (default) must export all events in the gate."""
        fid = _make_file(n_events=200, seed=4)
        gid = _rect_gate(fid, "All", x_min=0.0, y_min=0.0, x_max=10000.0, y_max=10000.0)
        _rows_iter, _fname, count = export_gate_csv_stream(gid, max_events=0)
        # All 200 events should pass the wide gate
        assert count == 200

    def test_filename_derived_from_gate_name(self):
        fid = _make_file(seed=5)
        gid = _rect_gate(fid, "Lymphocytes")
        _rows, fname, _count = export_gate_csv_stream(gid)
        assert "Lymphocytes" in fname
        assert fname.endswith(".csv")

    def test_data_rows_have_correct_column_count(self):
        """Each data row must have the same number of columns as the header."""
        fid = _make_file(n_events=100, seed=6)
        gid = _rect_gate(fid, "G1", x_min=0.0, y_min=0.0, x_max=10000.0, y_max=10000.0)
        parsed = _collect_csv(gid)
        assert len(parsed) > 1
        n_cols = len(parsed[0])  # header column count
        for row in parsed[1:]:
            assert len(row) == n_cols

    def test_nonexistent_gate_raises_key_error(self):
        with pytest.raises(KeyError):
            export_gate_csv_stream("does-not-exist")

    def test_child_gate_exports_only_child_events(self):
        """A child gate's CSV must contain ≤ parent event count rows."""
        fid = _make_file(n_events=300, seed=7)
        parent_id = _rect_gate(fid, "Parent", x_min=100.0, y_min=100.0, x_max=900.0, y_max=900.0)
        child_id = _rect_gate(
            fid, "Child", x_min=300.0, y_min=300.0, x_max=700.0, y_max=700.0,
            parent_gate_id=parent_id,
        )
        _rows_p, _fn_p, count_parent = export_gate_csv_stream(parent_id)
        _rows_c, _fn_c, count_child = export_gate_csv_stream(child_id)
        assert count_child <= count_parent
