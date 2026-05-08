"""Phase T — Experiment hierarchy, table endpoints, and CSV export.

Covers:
  T-1: Experiment CRUD (create, list, get, update, delete)
  T-2: Group CRUD (within an experiment)
  T-3: Sample CRUD (within a group) + move between groups
  T-4: Batch stats table (/api/tables/batch-stats/{exp_id})
  T-5: Plate well table (/api/tables/plate-wells/{plate_id})
  T-6: Population stats table (/api/tables/population/{gate_id})
  T-7: Generic CSV export (/api/tables/export)
"""

from __future__ import annotations

import io
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
from services import experiment_service, gates as gates_service, storage
from services import plate_service


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def clean_stores():
    """Reset all stores before/after each test to prevent leakage."""
    experiment_service.reset_experiment_store()
    gates_service.reset_gate_store()
    plate_service.reset_plate_store()
    for fid in list(storage.list_loaded_file_ids()):
        try:
            storage.delete_file(fid)
        except KeyError:
            pass
    yield
    experiment_service.reset_experiment_store()
    gates_service.reset_gate_store()
    plate_service.reset_plate_store()
    for fid in list(storage.list_loaded_file_ids()):
        try:
            storage.delete_file(fid)
        except KeyError:
            pass


# ─── helpers ──────────────────────────────────────────────────────────────────

_file_counter = 0


def make_rect_gate(client, fid: str, name: str, x_min=100.0, x_max=900.0, y_min=100.0, y_max=900.0,
                   x_channel="Ch1", y_channel="Ch2") -> dict:
    """Create a rectangle gate in raw event-space coordinates (events are uniform 10-1000).
    Returns the httpx Response object."""
    r = client.post("/api/gates", json={
        "file_id": fid,
        "name": name,
        "x_channel": x_channel,
        "y_channel": y_channel,
        "params": {"type": "rectangle", "x_min": x_min, "x_max": x_max, "y_min": y_min, "y_max": y_max},
    })
    return r


def make_file(n_events: int = 300, n_channels: int = 3, seed: int = 1) -> str:
    """Register a synthetic file and return its file_id."""
    global _file_counter
    _file_counter += 1
    fid = f"test_file_{seed}_{_file_counter}"

    rng = np.random.default_rng(seed)
    events = rng.uniform(10, 1000, size=(n_events, n_channels)).astype(np.float32)
    channels = [
        ChannelMetadata(
            name=f"Ch{i + 1}",
            index=i + 1,
            stain=None,
            display_name=f"Channel {i + 1}",
            range=1024.0,
            amplification=None,
        )
        for i in range(n_channels)
    ]
    meta = FileMetadata(
        id=fid,
        path=f"/fake/file_{seed}.fcs",
        sample_name=f"Sample{seed}",
        event_count=n_events,
        channels=channels,
    )
    storage.register_file(meta, events)
    return fid


# ─── T-1: Experiment CRUD ─────────────────────────────────────────────────────

class TestExperimentCRUD:
    def test_create_experiment(self, client):
        r = client.post("/api/experiments", json={"name": "MyExp"})
        assert r.status_code == 201
        data = r.json()
        assert data["name"] == "MyExp"
        assert "id" in data
        assert data["group_count"] == 0
        assert data["sample_count"] == 0

    def test_create_experiment_with_meta(self, client):
        r = client.post("/api/experiments", json={
            "name": "CD4 Study",
            "description": "Testing CD4 T cells",
            "meta": {"instrument": "FACSAria", "operator": "Alice"},
        })
        assert r.status_code == 201
        data = r.json()
        assert data["description"] == "Testing CD4 T cells"
        assert data["meta"]["instrument"] == "FACSAria"

    def test_list_experiments_empty(self, client):
        r = client.get("/api/experiments")
        assert r.status_code == 200
        assert r.json() == []

    def test_list_experiments_after_create(self, client):
        client.post("/api/experiments", json={"name": "Exp A"})
        client.post("/api/experiments", json={"name": "Exp B"})
        r = client.get("/api/experiments")
        assert r.status_code == 200
        names = [e["name"] for e in r.json()]
        assert set(names) == {"Exp A", "Exp B"}

    def test_get_experiment(self, client):
        created = client.post("/api/experiments", json={"name": "E1"}).json()
        r = client.get(f"/api/experiments/{created['id']}")
        assert r.status_code == 200
        assert r.json()["name"] == "E1"

    def test_get_experiment_not_found(self, client):
        r = client.get("/api/experiments/nonexistent-id")
        assert r.status_code == 404

    def test_update_experiment(self, client):
        created = client.post("/api/experiments", json={"name": "Old Name"}).json()
        r = client.put(f"/api/experiments/{created['id']}", json={"name": "New Name"})
        assert r.status_code == 200
        assert r.json()["name"] == "New Name"

    def test_delete_experiment(self, client):
        created = client.post("/api/experiments", json={"name": "ToDelete"}).json()
        r = client.delete(f"/api/experiments/{created['id']}")
        assert r.status_code == 204
        r2 = client.get(f"/api/experiments/{created['id']}")
        assert r2.status_code == 404

    def test_delete_experiment_not_found(self, client):
        r = client.delete("/api/experiments/no-such-id")
        assert r.status_code == 404


# ─── T-2: Group CRUD ─────────────────────────────────────────────────────────

class TestGroupCRUD:
    def setup_exp(self, client) -> str:
        return client.post("/api/experiments", json={"name": "E"}).json()["id"]

    def test_add_group(self, client):
        exp_id = self.setup_exp(client)
        r = client.post(f"/api/experiments/{exp_id}/groups", json={"name": "CD4"})
        assert r.status_code == 201
        data = r.json()
        assert data["name"] == "CD4"
        assert data["sample_count"] == 0

    def test_add_multiple_groups(self, client):
        exp_id = self.setup_exp(client)
        client.post(f"/api/experiments/{exp_id}/groups", json={"name": "G1"})
        client.post(f"/api/experiments/{exp_id}/groups", json={"name": "G2"})
        r = client.get(f"/api/experiments/{exp_id}")
        assert r.json()["group_count"] == 2

    def test_delete_group(self, client):
        exp_id = self.setup_exp(client)
        grp = client.post(f"/api/experiments/{exp_id}/groups", json={"name": "G"}).json()
        r = client.delete(f"/api/experiments/{exp_id}/groups/{grp['id']}")
        assert r.status_code == 204
        r2 = client.get(f"/api/experiments/{exp_id}")
        assert r2.json()["group_count"] == 0

    def test_update_group(self, client):
        exp_id = self.setup_exp(client)
        grp = client.post(f"/api/experiments/{exp_id}/groups", json={"name": "Old"}).json()
        r = client.put(f"/api/experiments/{exp_id}/groups/{grp['id']}", json={"name": "New"})
        assert r.status_code == 200
        assert r.json()["name"] == "New"


# ─── T-3: Sample CRUD + move ─────────────────────────────────────────────────

class TestSampleCRUD:
    def setup_exp_group(self, client) -> tuple[str, str]:
        exp_id = client.post("/api/experiments", json={"name": "E"}).json()["id"]
        grp_id = client.post(f"/api/experiments/{exp_id}/groups", json={"name": "G"}).json()["id"]
        return exp_id, grp_id

    def test_add_sample(self, client):
        exp_id, grp_id = self.setup_exp_group(client)
        r = client.post(
            f"/api/experiments/{exp_id}/groups/{grp_id}/samples",
            json={"name": "S1"},
        )
        assert r.status_code == 201
        data = r.json()
        assert data["name"] == "S1"
        assert data["load_status"] == "pending"

    def test_add_sample_with_file(self, client):
        exp_id, grp_id = self.setup_exp_group(client)
        fid = make_file()
        r = client.post(
            f"/api/experiments/{exp_id}/groups/{grp_id}/samples",
            json={"name": "S1", "file_id": fid},
        )
        assert r.status_code == 201
        assert r.json()["file_id"] == fid

    def test_update_sample(self, client):
        exp_id, grp_id = self.setup_exp_group(client)
        s = client.post(
            f"/api/experiments/{exp_id}/groups/{grp_id}/samples",
            json={"name": "S1"},
        ).json()
        r = client.put(
            f"/api/experiments/{exp_id}/groups/{grp_id}/samples/{s['id']}",
            json={"name": "S1-renamed", "load_status": "loaded"},
        )
        assert r.status_code == 200
        assert r.json()["name"] == "S1-renamed"
        assert r.json()["load_status"] == "loaded"

    def test_delete_sample(self, client):
        exp_id, grp_id = self.setup_exp_group(client)
        s = client.post(
            f"/api/experiments/{exp_id}/groups/{grp_id}/samples",
            json={"name": "S"},
        ).json()
        r = client.delete(f"/api/experiments/{exp_id}/groups/{grp_id}/samples/{s['id']}")
        assert r.status_code == 204
        # Verify it's gone
        r2 = client.get(f"/api/experiments/{exp_id}")
        groups = r2.json()["groups"]
        samples = next(g["samples"] for g in groups if g["id"] == grp_id)
        assert all(s2["id"] != s["id"] for s2 in samples)

    def test_move_sample_between_groups(self, client):
        exp_id = client.post("/api/experiments", json={"name": "E"}).json()["id"]
        g1_id = client.post(f"/api/experiments/{exp_id}/groups", json={"name": "G1"}).json()["id"]
        g2_id = client.post(f"/api/experiments/{exp_id}/groups", json={"name": "G2"}).json()["id"]
        s = client.post(
            f"/api/experiments/{exp_id}/groups/{g1_id}/samples",
            json={"name": "S"},
        ).json()
        r = client.post(
            f"/api/experiments/{exp_id}/groups/{g1_id}/samples/{s['id']}/move",
            json={"destination_group_id": g2_id},
        )
        assert r.status_code == 200
        # Check it's in G2 now
        exp = client.get(f"/api/experiments/{exp_id}").json()
        g2_samples = next(g["samples"] for g in exp["groups"] if g["id"] == g2_id)
        assert any(s2["id"] == s["id"] for s2 in g2_samples)
        g1_samples = next(g["samples"] for g in exp["groups"] if g["id"] == g1_id)
        assert all(s2["id"] != s["id"] for s2 in g1_samples)

    def test_sample_count_in_response(self, client):
        exp_id, grp_id = self.setup_exp_group(client)
        client.post(f"/api/experiments/{exp_id}/groups/{grp_id}/samples", json={"name": "A"})
        client.post(f"/api/experiments/{exp_id}/groups/{grp_id}/samples", json={"name": "B"})
        r = client.get(f"/api/experiments/{exp_id}")
        assert r.json()["sample_count"] == 2


# ─── T-4: Batch stats table ───────────────────────────────────────────────────

class TestBatchStatsTable:
    def _setup(self, client):
        """Create exp → group → 2 samples (one with a real file)."""
        fid = make_file(n_events=500, n_channels=3)
        exp_id = client.post("/api/experiments", json={"name": "BatchExp"}).json()["id"]
        grp_id = client.post(
            f"/api/experiments/{exp_id}/groups", json={"name": "G1"}
        ).json()["id"]
        client.post(
            f"/api/experiments/{exp_id}/groups/{grp_id}/samples",
            json={"name": "S-with-file", "file_id": fid, "load_status": "loaded"},
        )
        client.post(
            f"/api/experiments/{exp_id}/groups/{grp_id}/samples",
            json={"name": "S-no-file"},
        )
        return exp_id, grp_id, fid

    def test_batch_stats_basic(self, client):
        exp_id, _, _ = self._setup(client)
        r = client.get(f"/api/tables/batch-stats/{exp_id}")
        assert r.status_code == 200
        data = r.json()
        assert data["experiment_id"] == exp_id
        assert len(data["rows"]) == 2

    def test_batch_stats_row_fields(self, client):
        exp_id, grp_id, fid = self._setup(client)
        r = client.get(f"/api/tables/batch-stats/{exp_id}")
        rows = {row["sample_name"]: row for row in r.json()["rows"]}
        assert "S-with-file" in rows
        assert "S-no-file" in rows
        # The row with a file should have total_events > 0 (file has 500 events)
        assert rows["S-with-file"]["total_events"] == 500
        # The row without a file has 0 events
        assert rows["S-no-file"]["total_events"] == 0

    def test_batch_stats_no_gates_empty_columns(self, client):
        exp_id, _, _ = self._setup(client)
        r = client.get(f"/api/tables/batch-stats/{exp_id}")
        # No gates registered → gate_names is empty list
        assert r.json()["gate_names"] == []

    def test_batch_stats_with_gates(self, client):
        fid = make_file(n_events=300, n_channels=3)
        exp_id = client.post("/api/experiments", json={"name": "GatedExp"}).json()["id"]
        grp_id = client.post(
            f"/api/experiments/{exp_id}/groups", json={"name": "G"}
        ).json()["id"]
        client.post(
            f"/api/experiments/{exp_id}/groups/{grp_id}/samples",
            json={"name": "S1", "file_id": fid, "load_status": "loaded"},
        )
        # Create a gate via the gates API
        rg = make_rect_gate(client, fid, "Lymphocytes")
        assert rg.status_code in (200, 201)

        r = client.get(f"/api/tables/batch-stats/{exp_id}")
        assert r.status_code == 200
        data = r.json()
        assert "Lymphocytes" in data["gate_names"]
        row = data["rows"][0]
        assert row["gate_stats"][0]["gate_name"] == "Lymphocytes"
        assert row["gate_stats"][0]["count"] >= 0

    def test_batch_stats_filter_gates(self, client):
        fid = make_file(n_events=300, n_channels=3)
        exp_id = client.post("/api/experiments", json={"name": "E"}).json()["id"]
        grp_id = client.post(
            f"/api/experiments/{exp_id}/groups", json={"name": "G"}
        ).json()["id"]
        client.post(
            f"/api/experiments/{exp_id}/groups/{grp_id}/samples",
            json={"name": "S", "file_id": fid},
        )
        make_rect_gate(client, fid, "A", x_max=0.5, y_max=0.5)
        make_rect_gate(client, fid, "B", x_min=0.5, x_max=1.0, y_min=0.5, y_max=1.0)
        # Request only gate "A"
        r = client.get(f"/api/tables/batch-stats/{exp_id}?gate_names=A")
        assert r.status_code == 200
        assert r.json()["gate_names"] == ["A"]

    def test_batch_stats_experiment_not_found(self, client):
        r = client.get("/api/tables/batch-stats/no-such-exp")
        assert r.status_code == 404


# ─── T-5: Plate well table ────────────────────────────────────────────────────

class TestPlateWellTable:
    def _make_plate(self, client, name="TestPlate", fmt="96"):
        r = client.post("/api/plates", json={"name": name, "format": fmt})
        assert r.status_code in (200, 201), r.text
        return r.json()["id"]

    def test_plate_well_table_basic(self, client):
        plate_id = self._make_plate(client)
        r = client.get(f"/api/tables/plate-wells/{plate_id}")
        assert r.status_code == 200
        data = r.json()
        assert data["plate_id"] == plate_id
        assert data["rows"] == 8
        assert data["cols"] == 12
        assert len(data["wells"]) > 0

    def test_plate_well_table_not_found(self, client):
        r = client.get("/api/tables/plate-wells/no-such-plate")
        assert r.status_code == 404

    def test_plate_well_table_with_gate(self, client):
        plate_id = self._make_plate(client)
        fid = make_file(n_events=300, n_channels=3)
        # Assign a file to well A1
        client.put(f"/api/plates/{plate_id}/wells/A1", json={"file_id": fid, "label": "Control"})
        # Create a gate
        make_rect_gate(client, fid, "Live", x_max=0.8, y_max=0.8)
        r = client.get(f"/api/tables/plate-wells/{plate_id}?gate_name=Live")
        assert r.status_code == 200
        data = r.json()
        assert data["gate_name"] == "Live"
        a1 = next((w for w in data["wells"] if w["well_id"] == "A1"), None)
        assert a1 is not None
        assert a1["gate_count"] >= 0

    def test_48_well_plate(self, client):
        plate_id = self._make_plate(client, fmt="48")
        r = client.get(f"/api/tables/plate-wells/{plate_id}")
        assert r.status_code == 200
        data = r.json()
        assert data["rows"] == 6
        assert data["cols"] == 8


# ─── T-6: Population stats table ─────────────────────────────────────────────

class TestPopulationStatsTable:
    def _create_gate(self, client):
        fid = make_file(n_events=500, n_channels=3, seed=42)
        r = make_rect_gate(client, fid, "Pop1")
        assert r.status_code in (200, 201), r.text
        gate_id = r.json()["id"]
        return fid, gate_id

    def test_population_stats_basic(self, client):
        fid, gate_id = self._create_gate(client)
        r = client.get(f"/api/tables/population/{gate_id}")
        assert r.status_code == 200
        data = r.json()
        assert data["gate_id"] == gate_id
        assert data["gate_name"] == "Pop1"
        assert data["count"] > 0
        # 3 channels → 3 rows
        assert len(data["rows"]) == 3

    def test_population_stats_fields(self, client):
        _, gate_id = self._create_gate(client)
        r = client.get(f"/api/tables/population/{gate_id}")
        row = r.json()["rows"][0]
        for field in ("channel", "display_name", "mfi", "median", "sd", "cv_pct", "geo_mean"):
            assert field in row, f"Missing field: {field}"
        # MFI and geo_mean should be positive for uniform [10,1000] data
        assert row["mfi"] > 0
        assert row["geo_mean"] > 0

    def test_population_stats_not_found(self, client):
        r = client.get("/api/tables/population/no-such-gate")
        assert r.status_code == 404

    def test_population_stats_percentages(self, client):
        fid, gate_id = self._create_gate(client)
        r = client.get(f"/api/tables/population/{gate_id}")
        data = r.json()
        # pct_of_parent and pct_of_total should be in [0, 100]
        assert 0.0 <= data["pct_of_parent"] <= 100.0
        assert 0.0 <= data["pct_of_total"] <= 100.0


# ─── T-7: Generic CSV export ─────────────────────────────────────────────────

class TestTableExport:
    def _setup_exp_with_gate(self, client):
        fid = make_file(n_events=300, n_channels=3)
        exp_id = client.post("/api/experiments", json={"name": "ExportExp"}).json()["id"]
        grp_id = client.post(
            f"/api/experiments/{exp_id}/groups", json={"name": "G"}
        ).json()["id"]
        client.post(
            f"/api/experiments/{exp_id}/groups/{grp_id}/samples",
            json={"name": "S1", "file_id": fid},
        )
        make_rect_gate(client, fid, "Live")
        return exp_id, fid

    def test_export_batch_stats_csv(self, client):
        exp_id, _ = self._setup_exp_with_gate(client)
        r = client.post("/api/tables/export", json={
            "table_type": "batch_stats",
            "experiment_id": exp_id,
        })
        assert r.status_code == 200
        assert "text/csv" in r.headers["content-type"]
        csv_text = r.text
        assert "Sample" in csv_text
        assert "Group" in csv_text
        assert "S1" in csv_text

    def test_export_batch_stats_has_gate_columns(self, client):
        exp_id, _ = self._setup_exp_with_gate(client)
        r = client.post("/api/tables/export", json={
            "table_type": "batch_stats",
            "experiment_id": exp_id,
        })
        csv_text = r.text
        assert "Live Count" in csv_text

    def test_export_batch_stats_missing_experiment_id(self, client):
        r = client.post("/api/tables/export", json={"table_type": "batch_stats"})
        assert r.status_code == 400

    def test_export_plate_wells_csv(self, client):
        r_plate = client.post("/api/plates", json={"name": "P", "format": "96"})
        assert r_plate.status_code in (200, 201)
        plate_id = r_plate.json()["id"]
        r = client.post("/api/tables/export", json={
            "table_type": "plate_wells",
            "plate_id": plate_id,
        })
        assert r.status_code == 200
        assert "text/csv" in r.headers["content-type"]
        csv_text = r.text
        assert "Well" in csv_text
        assert "A1" in csv_text

    def test_export_plate_wells_missing_plate_id(self, client):
        r = client.post("/api/tables/export", json={"table_type": "plate_wells"})
        assert r.status_code == 400

    def test_export_population_csv(self, client):
        fid = make_file(n_events=300, n_channels=3)
        r_gate = make_rect_gate(client, fid, "Lymph")
        gate_id = r_gate.json()["id"]
        r = client.post("/api/tables/export", json={
            "table_type": "population",
            "gate_id": gate_id,
        })
        assert r.status_code == 200
        assert "text/csv" in r.headers["content-type"]
        csv_text = r.text
        assert "Gate:" in csv_text or "gate" in csv_text.lower()
        assert "Channel" in csv_text

    def test_export_population_missing_gate_id(self, client):
        r = client.post("/api/tables/export", json={"table_type": "population"})
        assert r.status_code == 400

    def test_export_unknown_table_type(self, client):
        r = client.post("/api/tables/export", json={"table_type": "foobar"})
        assert r.status_code == 400

    def test_export_csv_filename_header(self, client):
        exp_id, _ = self._setup_exp_with_gate(client)
        r = client.post("/api/tables/export", json={
            "table_type": "batch_stats",
            "experiment_id": exp_id,
        })
        cd = r.headers.get("content-disposition", "")
        assert "batch_stats_" in cd
        assert ".csv" in cd
