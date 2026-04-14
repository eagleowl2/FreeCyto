"""
Simulate the exact HTTP sequence triggered by the frontend on each UI interaction.
Each test method = one user action.
"""
import numpy as np
import pytest
from fastapi.testclient import TestClient
from main import app
from models.file_models import ChannelMetadata, FileMetadata
from services import storage, gates as gates_service

client = TestClient(app)
FILE_ID = "click-seq-test"


def make_file():
    rng = np.random.default_rng(1)
    events = np.column_stack([
        rng.uniform(1000, 262144, 5000).astype(np.float32),
        rng.uniform(500, 150000, 5000).astype(np.float32),
        rng.uniform(0, 65536, 5000).astype(np.float32),
    ])
    channels = [
        ChannelMetadata(name="FSC-A", index=1, stain=None, display_name="FSC-A", range=262144.0, amplification=None),
        ChannelMetadata(name="SSC-A", index=2, stain=None, display_name="SSC-A", range=262144.0, amplification=None),
        ChannelMetadata(name="BV421-A", index=3, stain="CD19", display_name="BV421-A :: CD19", range=262144.0, amplification=None),
    ]
    meta = FileMetadata(id=FILE_ID, path=f"/s/{FILE_ID}.fcs",
                        sample_name="click-test", event_count=5000, channels=channels)
    storage.register_file(meta, events)
    return meta


@pytest.fixture(autouse=True)
def clean():
    yield
    try:
        storage.delete_file(FILE_ID)
    except KeyError:
        pass
    gates_service.delete_all_gates_for_file(FILE_ID)


class TestClickSequence:

    def test_step1_load_file(self):
        """POST /api/files/load — simulates Browse FCS click."""
        # (In production this loads by path; here we pre-register and verify /channels)
        make_file()
        r = client.get(f"/api/files/{FILE_ID}/channels")
        assert r.status_code == 200
        assert r.json()["event_count"] == 5000
        assert any(c["name"] == "FSC-A" for c in r.json()["channels"])

    def test_step2_fetch_scatter_linear(self):
        """GET /api/files/{id}/events?transform_x=linear — initial plot load."""
        make_file()
        r = client.get(f"/api/files/{FILE_ID}/events", params={
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "transform_x": "linear", "transform_y": "linear", "max_events": 15000,
        })
        assert r.status_code == 200
        assert len(r.json()["events"]) > 0

    def test_step3_switch_to_log(self):
        """GET /api/files/{id}/events?transform_x=log — user clicks Log."""
        make_file()
        r = client.get(f"/api/files/{FILE_ID}/events", params={
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "transform_x": "log", "transform_y": "linear", "max_events": 15000,
        })
        assert r.status_code == 200
        events = r.json()["events"]
        x_vals = [e[0] for e in events]
        assert all(isinstance(v, float) for v in x_vals)
        assert all(v >= 0 for v in x_vals), "Log of positive FSC-A must be >= 0"

    def test_step4_draw_gate_after_log(self):
        """POST /api/gates with log transform params — draw rect gate."""
        make_file()
        r = client.post("/api/gates", json={
            "file_id": FILE_ID,
            "name": "Log gate",
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "transform_x": "log",
            "transform_y": "linear",
            "arcsinh_cofactor": 150,
            "params": {"type": "rectangle", "x_min": 3.5, "y_min": 0, "x_max": 5.0, "y_max": 200000},
        })
        assert r.status_code == 200
        gate = r.json()
        assert gate["count"] > 0
        assert gate["count"] < 5000

    def test_step5_switch_back_to_linear_clears_gates(self):
        """DELETE /api/files/{id}/gates — transform change clears gates."""
        make_file()
        # Create a gate
        client.post("/api/gates", json={
            "file_id": FILE_ID, "name": "g1",
            "x_channel": "FSC-A", "y_channel": "SSC-A",
            "transform_x": "log", "transform_y": "linear",
            "arcsinh_cofactor": 150,
            "params": {"type": "rectangle", "x_min": 3.5, "y_min": 0, "x_max": 5.0, "y_max": 200000},
        })
        # Simulate transform change → frontend calls DELETE
        r = client.delete(f"/api/files/{FILE_ID}/gates")
        assert r.status_code == 200
        # Verify gates are cleared
        tree = client.get(f"/api/files/{FILE_ID}/gates").json()
        assert tree == []

    def test_step6_full_sequence_linear_log_arcsinh(self):
        """Simulate rapid transform switching — all three must return 200."""
        make_file()
        for tx in ("linear", "log", "arcsinh"):
            r = client.get(f"/api/files/{FILE_ID}/events", params={
                "x_channel": "FSC-A", "y_channel": "SSC-A",
                "transform_x": tx, "transform_y": "linear", "max_events": 100,
            })
            assert r.status_code == 200, f"transform_x={tx!r} returned {r.status_code}"
