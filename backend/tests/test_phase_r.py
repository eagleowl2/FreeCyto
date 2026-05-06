"""Phase R — FlowJo Core Features (R-1: Quadrant gates, R-2: Stats labels, R-3: Backgating).

Covers:
  - Quadrant gate creates 4 rectangles atomically
  - Q1/Q2/Q3/Q4 counts sum to parent count
  - Naming convention {prefix}_Q1..Q4
  - Crosshair position correctly splits
  - Rollback on partial failure (duplicate name)
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


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def quad_test_file():
    """Create a file with events distributed in all 4 quadrants for testing."""
    gates_service.reset_gate_store()
    rng = np.random.default_rng(42)
    # 1000 events: 250 in each quadrant relative to (500, 500) split
    n_per_quad = 250
    q1 = rng.uniform([501, 501], [1000, 1000], size=(n_per_quad, 2))  # top-right
    q2 = rng.uniform([0, 501], [499, 1000], size=(n_per_quad, 2))     # top-left
    q3 = rng.uniform([0, 0], [499, 499], size=(n_per_quad, 2))        # bottom-left
    q4 = rng.uniform([501, 0], [1000, 499], size=(n_per_quad, 2))     # bottom-right
    events_2d = np.vstack([q1, q2, q3, q4])
    rng.shuffle(events_2d)
    # Add a third channel for completeness
    third = rng.uniform(0, 1000, size=(n_per_quad * 4, 1))
    events = np.hstack([events_2d, third]).astype(np.float32)
    fid = "test_quad_file"
    channels = [
        ChannelMetadata(name="FSC-A", index=1, stain=None, display_name="FSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="SSC-A", index=2, stain=None, display_name="SSC-A", range=1024.0, amplification=None),
        ChannelMetadata(name="FL1-A", index=3, stain=None, display_name="CD3", range=1024.0, amplification=None),
    ]
    meta = FileMetadata(id=fid, path=f"/test/{fid}.fcs", sample_name=fid, event_count=n_per_quad * 4, channels=channels)
    storage.register_file(meta, events)
    return fid


class TestQuadrantGate:
    """R-1: Quadrant gate creates 4 rectangle gates split by crosshair."""

    def test_creates_four_gates(self, client, quad_test_file):
        """POST /api/gates/quadrant should create exactly 4 rectangle gates."""
        body = {
            "file_id": quad_test_file,
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "x_split": 500.0,
            "y_split": 500.0,
            "name_prefix": "Test",
        }
        res = client.post("/api/gates/quadrant", json=body)
        assert res.status_code == 200, res.text
        data = res.json()
        assert "q1" in data and "q2" in data and "q3" in data and "q4" in data

    def test_naming_convention(self, client, quad_test_file):
        """Quad gates should be named {prefix}_Q1, _Q2, _Q3, _Q4."""
        body = {
            "file_id": quad_test_file,
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "x_split": 500.0,
            "y_split": 500.0,
            "name_prefix": "Lymph",
        }
        res = client.post("/api/gates/quadrant", json=body)
        assert res.status_code == 200
        data = res.json()
        assert data["q1"]["name"] == "Lymph_Q1"
        assert data["q2"]["name"] == "Lymph_Q2"
        assert data["q3"]["name"] == "Lymph_Q3"
        assert data["q4"]["name"] == "Lymph_Q4"

    def test_quadrant_counts_sum_to_total(self, client, quad_test_file):
        """Sum of Q1+Q2+Q3+Q4 counts should equal total event count."""
        body = {
            "file_id": quad_test_file,
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "x_split": 500.0,
            "y_split": 500.0,
            "name_prefix": "Sum",
        }
        res = client.post("/api/gates/quadrant", json=body)
        assert res.status_code == 200
        data = res.json()
        total = data["q1"]["count"] + data["q2"]["count"] + data["q3"]["count"] + data["q4"]["count"]
        # All 1000 events should be classified into one of 4 quadrants
        assert total == 1000, f"Expected 1000, got {total} (Q1={data['q1']['count']}, Q2={data['q2']['count']}, Q3={data['q3']['count']}, Q4={data['q4']['count']})"

    def test_quadrant_split_position(self, client, quad_test_file):
        """Each quadrant should have approx 250 events when split at (500, 500)."""
        body = {
            "file_id": quad_test_file,
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "x_split": 500.0,
            "y_split": 500.0,
            "name_prefix": "Even",
        }
        res = client.post("/api/gates/quadrant", json=body)
        assert res.status_code == 200
        data = res.json()
        # Each quadrant ~250 events (allow 10% tolerance for boundary effects)
        for q in ["q1", "q2", "q3", "q4"]:
            assert 200 <= data[q]["count"] <= 300, f"{q} count out of expected range: {data[q]['count']}"

    def test_response_includes_split_coords(self, client, quad_test_file):
        """Response should echo the x_split and y_split values."""
        body = {
            "file_id": quad_test_file,
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "x_split": 250.5,
            "y_split": 750.5,
            "name_prefix": "Echo",
        }
        res = client.post("/api/gates/quadrant", json=body)
        assert res.status_code == 200
        data = res.json()
        assert data["x_split"] == 250.5
        assert data["y_split"] == 750.5

    def test_duplicate_name_rolls_back(self, client, quad_test_file):
        """If creating a quad gate fails partway (name collision), all should be rolled back."""
        body = {
            "file_id": quad_test_file,
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "x_split": 500.0,
            "y_split": 500.0,
            "name_prefix": "First",
        }
        res = client.post("/api/gates/quadrant", json=body)
        assert res.status_code == 200

        # Now try again with same prefix - should fail
        res2 = client.post("/api/gates/quadrant", json=body)
        assert res2.status_code == 409  # name conflict

        # Verify the original 4 still exist (no leak from failed second attempt)
        gate_tree = gates_service.get_gate_tree(quad_test_file)
        assert len(gate_tree) == 4

    def test_quadrants_are_rectangle_type(self, client, quad_test_file):
        """All 4 created gates should be of type 'rectangle'."""
        body = {
            "file_id": quad_test_file,
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "x_split": 500.0,
            "y_split": 500.0,
            "name_prefix": "Rect",
        }
        res = client.post("/api/gates/quadrant", json=body)
        assert res.status_code == 200
        data = res.json()
        for q in ["q1", "q2", "q3", "q4"]:
            assert data[q]["type"] == "rectangle", f"{q} should be type 'rectangle'"

    def test_q1_is_top_right(self, client, quad_test_file):
        """Q1 should have x_min=x_split, y_min=y_split (top-right)."""
        body = {
            "file_id": quad_test_file,
            "x_channel": "FSC-A",
            "y_channel": "SSC-A",
            "x_split": 500.0,
            "y_split": 500.0,
            "name_prefix": "Pos",
        }
        res = client.post("/api/gates/quadrant", json=body)
        data = res.json()
        # Q1 is top-right: x>=500, y>=500
        assert data["q1"]["x_min"] == 500.0
        assert data["q1"]["y_min"] == 500.0
        # Q3 is bottom-left: x<=500, y<=500
        assert data["q3"]["x_max"] == 500.0
        assert data["q3"]["y_max"] == 500.0
