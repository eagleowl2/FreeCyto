"""Phase M — overlay histogram and gated FCS export tests."""

from __future__ import annotations

import os
import struct
import sys

import numpy as np
import pytest

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from models.file_models import ChannelMetadata, FileMetadata
from models.gate_models import GateCreateRequest, RectangleGateCreate
from services import fcs_export as fcs_export_service
from services import gates as gates_service
from services import storage


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_file(n_events: int = 200, seed: int = 1, file_id: str | None = None) -> str:
    rng = np.random.default_rng(seed)
    events = rng.uniform(0, 1000, size=(n_events, 3)).astype(np.float32)
    fid = file_id or f"test_m_{seed}"
    channels = [
        ChannelMetadata(name="FSC-A", index=1, stain=None, display_name="FSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="SSC-A", index=2, stain=None, display_name="SSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="FL1-A", index=3, stain=None, display_name="FL1-A", range=1024.0, amplification=None),
    ]
    meta = FileMetadata(id=fid, path=f"/test/{fid}.fcs", sample_name=fid, event_count=n_events, channels=channels)
    storage.register_file(meta, events)
    return fid


def _add_rect_gate(file_id: str, name: str, x_min=200.0, y_min=200.0, x_max=800.0, y_max=800.0) -> str:
    req = GateCreateRequest(
        file_id=file_id, name=name,
        x_channel="FSC-A", y_channel="SSC-A",
        params=RectangleGateCreate(type="rectangle", x_min=x_min, y_min=y_min, x_max=x_max, y_max=y_max),
    )
    return gates_service.create_gate(req).id


# ---------------------------------------------------------------------------
# FCS export core unit tests
# ---------------------------------------------------------------------------


class TestExportEventsAsFcs:
    """Validate the raw FCS bytes produced by export_events_as_fcs."""

    def _make_events(self, n: int = 50) -> np.ndarray:
        rng = np.random.default_rng(42)
        return rng.uniform(0, 1000, size=(n, 3)).astype(np.float32)

    def test_header_length(self):
        events = self._make_events(10)
        fcs = fcs_export_service.export_events_as_fcs(events, ["FSC-A", "SSC-A", "FL1-A"], [1024.0, 1024.0, 1024.0])
        assert len(fcs) >= 58

    def test_header_version(self):
        events = self._make_events(10)
        fcs = fcs_export_service.export_events_as_fcs(events, ["FSC-A", "SSC-A", "FL1-A"], [1024.0, 1024.0, 1024.0])
        assert fcs[:6] == b"FCS3.1"

    def test_header_text_offsets_consistent(self):
        """TEXT segment starts and ends at the offsets declared in the header."""
        events = self._make_events(30)
        fcs = fcs_export_service.export_events_as_fcs(events, ["A", "B", "C"], [1024.0, 1024.0, 1024.0])
        # Parse header offsets (right-justified 8-char ASCII integers)
        text_start = int(fcs[10:18].strip())
        text_end   = int(fcs[18:26].strip())
        data_start = int(fcs[26:34].strip())
        data_end   = int(fcs[34:42].strip())

        assert text_start == 256, "TEXT should start at 256"
        assert text_end >= text_start, "TEXT end >= start"
        # TEXT should contain the delimiter as first byte
        assert chr(fcs[text_start]) in "/@|!", "First TEXT byte should be delimiter"
        # DATA offsets
        assert data_start > text_end, "DATA must come after TEXT"
        assert data_end == data_start + 30 * 3 * 4 - 1, "DATA length = N_events * N_ch * 4"

    def test_data_segment_values(self):
        """Round-trip: write events, read them back from DATA segment."""
        rng = np.random.default_rng(7)
        events_f32 = rng.uniform(0, 500, size=(20, 2)).astype(np.float32)
        fcs = fcs_export_service.export_events_as_fcs(events_f32, ["CH1", "CH2"], [512.0, 512.0])

        data_start = int(fcs[26:34].strip())
        n_bytes = 20 * 2 * 4
        raw = fcs[data_start: data_start + n_bytes]
        recovered = np.frombuffer(raw, dtype="<f4").reshape(20, 2)
        np.testing.assert_array_equal(recovered, events_f32)

    def test_text_contains_par_and_tot(self):
        """$PAR and $TOT appear in the TEXT segment."""
        events = self._make_events(15)
        fcs = fcs_export_service.export_events_as_fcs(events, ["A", "B", "C"], [1.0, 1.0, 1.0])
        text_start = int(fcs[10:18].strip())
        text_end   = int(fcs[18:26].strip())
        text = fcs[text_start: text_end + 1].decode("latin-1")
        assert "$PAR" in text
        assert "$TOT" in text
        assert "15" in text   # $TOT value
        assert "3" in text    # $PAR value

    def test_channel_names_in_text(self):
        """$P1N through $P3N reflect the provided channel names."""
        events = self._make_events(5)
        fcs = fcs_export_service.export_events_as_fcs(events, ["FSC-A", "SSC-A", "FL1-A"], [1024.0, 1024.0, 1024.0])
        text_start = int(fcs[10:18].strip())
        text_end   = int(fcs[18:26].strip())
        text = fcs[text_start: text_end + 1].decode("latin-1")
        assert "FSC-A" in text
        assert "SSC-A" in text
        assert "FL1-A" in text

    def test_zero_events(self):
        """Empty event array is handled gracefully."""
        events = np.zeros((0, 2), dtype=np.float32)
        fcs = fcs_export_service.export_events_as_fcs(events, ["A", "B"], [1024.0, 1024.0])
        text_start = int(fcs[10:18].strip())
        text_end   = int(fcs[18:26].strip())
        text = fcs[text_start: text_end + 1].decode("latin-1")
        assert "$TOT" in text
        # $TOT = 0 should appear in the text
        assert "/0/" in text or "TOT/0/" in text or "\x2f0\x2f" in fcs[text_start:text_end+1].tobytes().decode("latin-1", errors="ignore")

    def test_data_start_aligned_512(self):
        """DATA segment starts on a 512-byte boundary."""
        events = self._make_events(100)
        fcs = fcs_export_service.export_events_as_fcs(events, ["A", "B", "C"], [1024.0] * 3)
        data_start = int(fcs[26:34].strip())
        assert data_start % 512 == 0, f"DATA_START {data_start} is not 512-aligned"

    def test_large_event_count(self):
        """Export works with a large number of events (stress-test offsets)."""
        rng = np.random.default_rng(99)
        events = rng.uniform(0, 1000, size=(10_000, 4)).astype(np.float32)
        fcs = fcs_export_service.export_events_as_fcs(events, ["A", "B", "C", "D"], [1024.0] * 4)
        data_start = int(fcs[26:34].strip())
        data_end   = int(fcs[34:42].strip())
        expected_data_len = 10_000 * 4 * 4
        assert data_end - data_start + 1 == expected_data_len


# ---------------------------------------------------------------------------
# High-level gate/file export helpers
# ---------------------------------------------------------------------------


class TestExportGateFcs:
    def test_gated_event_count_less_than_total(self):
        """Exporting a non-trivial gate produces fewer events than the full file."""
        fid = _make_file(n_events=500, seed=20)
        _add_rect_gate(fid, "G1", x_min=200, y_min=200, x_max=700, y_max=700)
        gates = {g.name: g for g in gates_service.list_gates(fid)}
        gate_count = gates["G1"].count

        fcs_bytes, filename = fcs_export_service.export_gate_fcs(gates_service._store.root_children[fid][0])
        data_start = int(fcs_bytes[26:34].strip())
        # Deduce event count from DATA length
        exported_n_events = (len(fcs_bytes) - data_start) // (3 * 4)  # 3 channels, float32

        assert exported_n_events == gate_count
        assert filename.endswith(".fcs")

    def test_export_gate_filename_contains_gate_name(self):
        fid = _make_file(seed=21)
        _add_rect_gate(fid, "Lymphocytes")
        gid = gates_service._store.root_children[fid][0]
        _, filename = fcs_export_service.export_gate_fcs(gid)
        assert "Lymphocytes" in filename

    def test_export_gate_not_found_raises(self):
        with pytest.raises(KeyError):
            fcs_export_service.export_gate_fcs("nonexistent-gate-id")

    def test_export_file_fcs_event_count(self):
        """export_file_fcs contains all file events."""
        fid = _make_file(n_events=150, seed=22)
        fcs_bytes, filename = fcs_export_service.export_file_fcs(fid)
        data_start = int(fcs_bytes[26:34].strip())
        exported_n = (len(fcs_bytes) - data_start) // (3 * 4)
        assert exported_n == 150

    def test_export_file_fcs_values_match_stored(self):
        """Exported values round-trip through float32 correctly."""
        fid = _make_file(n_events=20, seed=23)
        fcs_bytes, _ = fcs_export_service.export_file_fcs(fid)
        data_start = int(fcs_bytes[26:34].strip())
        raw = fcs_bytes[data_start: data_start + 20 * 3 * 4]
        exported = np.frombuffer(raw, dtype="<f4").reshape(20, 3)
        stored = storage.get_file_events(fid).astype(np.float32)
        np.testing.assert_array_equal(exported, stored)

    def test_export_file_fcs_not_found_raises(self):
        with pytest.raises(KeyError):
            fcs_export_service.export_file_fcs("no-such-file")


# ---------------------------------------------------------------------------
# Router integration (via service calls — no ASGI needed)
# ---------------------------------------------------------------------------


class TestExportRouterIntegration:
    """Verify the router functions reach the correct service layer."""

    def test_gate_export_endpoint(self):
        """Simulate what the gate export endpoint does and verify the bytes."""
        import asyncio
        from routers.gates import export_gate_fcs as endpoint_fn

        fid = _make_file(n_events=100, seed=30)
        _add_rect_gate(fid, "TestGate")
        gid = gates_service._store.root_children[fid][0]

        async def _run():
            resp = await endpoint_fn(gid)
            chunks = []
            async for chunk in resp.body_iterator:
                chunks.append(chunk if isinstance(chunk, bytes) else chunk.encode())
            return b"".join(chunks)

        data = asyncio.run(_run())
        assert data[:6] == b"FCS3.1"

    def test_file_export_endpoint(self):
        """Simulate what the file export endpoint does and verify the bytes."""
        import asyncio
        from routers.files import export_file_fcs as endpoint_fn

        fid = _make_file(n_events=80, seed=31)

        async def _run():
            resp = await endpoint_fn(fid)
            chunks = []
            async for chunk in resp.body_iterator:
                chunks.append(chunk if isinstance(chunk, bytes) else chunk.encode())
            return b"".join(chunks)

        data = asyncio.run(_run())
        assert data[:6] == b"FCS3.1"
        # All 80 events should be present
        data_start = int(data[26:34].strip())
        exported_n = (len(data) - data_start) // (3 * 4)
        assert exported_n == 80
