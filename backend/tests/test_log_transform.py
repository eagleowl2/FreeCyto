"""
Tests for the log transform endpoint — focused on edge cases that can crash
the frontend (zero-width range, all-zero channels, NaN/Inf in output).

Run: cd backend && pytest tests/test_log_transform.py -v
"""
import math
import numpy as np
import pytest
from fastapi.testclient import TestClient

from main import app
from models.file_models import ChannelMetadata, FileMetadata
from services import storage, gates as gates_service

client = TestClient(app)

FILE_ID = "log-transform-test"
N_EVENTS = 1000
N_CHANNELS = 3   # FSC-A, SSC-A, BV421-A


def register_test_file(events: np.ndarray, file_id: str = FILE_ID) -> None:
    """Register a synthetic file in the store for testing."""
    channels = [
        ChannelMetadata(name="FSC-A",   index=1, stain=None, display_name="FSC-A",   range=262144.0, amplification=None),
        ChannelMetadata(name="SSC-A",   index=2, stain=None, display_name="SSC-A",   range=262144.0, amplification=None),
        ChannelMetadata(name="BV421-A", index=3, stain="CD19", display_name="BV421-A :: CD19", range=262144.0, amplification=None),
    ]
    meta = FileMetadata(
        id=file_id,
        path=f"/synthetic/{file_id}.fcs",
        sample_name="log-test",
        event_count=events.shape[0],
        channels=channels,
    )
    storage.register_file(meta, events)


@pytest.fixture(autouse=True)
def clean_store():
    yield
    try:
        storage.delete_file(FILE_ID)
    except KeyError:
        pass
    gates_service.delete_all_gates_for_file(FILE_ID)


class TestLogTransformEndpoint:

    def test_log_transform_returns_200_with_normal_fsc_data(self):
        """Log transform on realistic FSC-A (positive, spread) returns valid data."""
        rng = np.random.default_rng(42)
        events = np.column_stack([
            rng.uniform(1000, 250000, N_EVENTS).astype(np.float32),  # FSC-A
            rng.uniform(500,  150000, N_EVENTS).astype(np.float32),  # SSC-A
            rng.uniform(0,    65536,  N_EVENTS).astype(np.float32),  # BV421-A
        ])
        register_test_file(events)

        r = client.get(f"/api/files/{FILE_ID}/events", params={
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "transform_x": "log",
            "transform_y": "linear",
            "max_events": 200,
        })
        assert r.status_code == 200
        data = r.json()
        assert "events" in data
        assert len(data["events"]) > 0

        # All X values must be finite floats (log of positive values)
        x_values = [row[0] for row in data["events"]]
        assert all(math.isfinite(v) for v in x_values), "Log transform produced NaN or Inf"
        # Range must be positive (log10 of spread FSC data is in [3, 5.4])
        assert max(x_values) > min(x_values), "All log-transformed values are identical — zero-width range"

    def test_log_transform_on_all_zero_channel_does_not_crash(self):
        """All-zero channel: log(max(0,1)) = 0 for every event. Backend must not crash."""
        events = np.zeros((N_EVENTS, N_CHANNELS), dtype=np.float32)
        register_test_file(events)

        r = client.get(f"/api/files/{FILE_ID}/events", params={
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "transform_x": "log",
            "transform_y": "log",
            "max_events": 200,
        })
        assert r.status_code == 200
        data = r.json()
        x_values = [row[0] for row in data["events"]]
        # All values must be 0.0 (log10(1) = 0) — finite, no crash
        assert all(v == 0.0 for v in x_values)

    def test_log_transform_on_negative_values_clamps_correctly(self):
        """Negative values in FCS (e.g. from compensation) must be clamped to 1.0 before log."""
        rng = np.random.default_rng(7)
        events = np.column_stack([
            rng.uniform(-50000, 250000, N_EVENTS).astype(np.float32),  # includes negatives
            rng.uniform(500, 150000,    N_EVENTS).astype(np.float32),
            np.zeros(N_EVENTS, dtype=np.float32),
        ])
        register_test_file(events)

        r = client.get(f"/api/files/{FILE_ID}/events", params={
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "transform_x": "log",
            "transform_y": "linear",
            "max_events": 500,
        })
        assert r.status_code == 200
        x_values = [row[0] for row in r.json()["events"]]
        assert all(math.isfinite(v) for v in x_values), "Negative FSC-A produced NaN/Inf under log"
        assert all(v >= 0.0 for v in x_values), "Log of clamped values must be >= 0"

    def test_log_transform_output_range_matches_density_range(self):
        """Events and density endpoints must agree on the transformed axis range."""
        rng = np.random.default_rng(11)
        events = np.column_stack([
            rng.uniform(1000, 262144, N_EVENTS).astype(np.float32),
            rng.uniform(500, 150000,  N_EVENTS).astype(np.float32),
            np.zeros(N_EVENTS, dtype=np.float32),
        ])
        register_test_file(events)

        params = dict(x_channel="FSC-A", y_channel="SSC-A", transform_x="log", transform_y="log")
        ev_r = client.get(f"/api/files/{FILE_ID}/events", params={**params, "max_events": N_EVENTS})
        dn_r = client.get(f"/api/files/{FILE_ID}/density", params={**params, "bins_x": 100, "bins_y": 100})

        assert ev_r.status_code == 200
        assert dn_r.status_code == 200

        ev_data = ev_r.json()
        dn_data = dn_r.json()

        ev_x = [row[0] for row in ev_data["events"]]
        ev_x_min, ev_x_max = min(ev_x), max(ev_x)
        dn_x_min, dn_x_max = dn_data["x_min"], dn_data["x_max"]

        # Density range must contain the events range (within floating point tolerance)
        assert dn_x_min <= ev_x_min + 0.01
        assert dn_x_max >= ev_x_max - 0.01


class TestLogTransformGateMask:

    def test_gate_created_under_log_is_evaluated_correctly(self):
        """A rectangle gate drawn in log space must count correctly on full events."""
        rng = np.random.default_rng(99)
        fsc = rng.uniform(1000, 262144, N_EVENTS).astype(np.float32)
        ssc = rng.uniform(500, 150000,  N_EVENTS).astype(np.float32)
        events = np.column_stack([fsc, ssc, np.zeros(N_EVENTS, dtype=np.float32)])
        register_test_file(events)

        # How many events fall in log10(FSC) ∈ [3.5, 5.0]?
        log_fsc = np.log10(np.maximum(fsc, 1.0))
        expected = int(np.sum((log_fsc >= 3.5) & (log_fsc <= 5.0)))

        from models.gate_models import GateCreateRequest, RectangleGateCreate
        body = GateCreateRequest(
            file_id=FILE_ID,
            name="log-gate",
            x_channel="FSC-A",
            y_channel="SSC-A",
            transform_x="log",
            transform_y="linear",
            params=RectangleGateCreate(type="rectangle", x_min=3.5, y_min=-1e9, x_max=5.0, y_max=1e9),
        )
        resp = gates_service.create_gate(body)
        assert resp.count == expected, (
            f"Gate count {resp.count} != expected {expected} under log transform"
        )
