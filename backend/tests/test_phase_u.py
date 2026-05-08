"""Phase U — Layout Editor backend tests.

Tests cover:
  U-1  Save layout → 201, correct fields
  U-2  List layouts → LayoutListItem with metadata & strategy_step_count
  U-3  Get layout detail → LayoutDetailResponse with metadata + strategy
  U-4  Update layout name only
  U-5  Update layout metadata only (description, author, tags)
  U-6  Update both name + metadata together
  U-7  Delete layout → 204
  U-8  Get strategy → []
  U-9  PUT strategy → steps persisted
  U-10 GET strategy after update → steps returned
  U-11 Update strategy again (replace) → old steps gone
  U-12 GET /layouts returns updated strategy_step_count
  U-13 Apply layout to another file
  U-14 Apply layout to non-existent file → 404
  U-15 GET non-existent layout → 404
  U-16 PUT non-existent layout → 404
  U-17 DELETE non-existent layout → 404
  U-18 Save layout with empty name → 400
  U-19 Update layout with empty name → 400
  U-20 compatible_channels auto-populated from gate tree
  U-21 Disk persistence — reload layout store from disk
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

# ── app bootstrap ──────────────────────────────────────────────────────────────
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from main import app
from services import layouts as layouts_service
import services.storage as storage_svc

client = TestClient(app)

# ─── test helpers ──────────────────────────────────────────────────────────────

def make_file(n_events: int = 500) -> str:
    """Register a synthetic FCS file in storage and return its file_id."""
    import uuid
    from models.file_models import ChannelMetadata, FileMetadata

    fid = str(uuid.uuid4())
    n_ch = 3
    channels = [
        ChannelMetadata(
            name=f"CH{i+1}",
            index=i + 1,
            stain=None,
            display_name=f"Channel {i+1}",
            range=1024.0,
            amplification=None,
        )
        for i in range(n_ch)
    ]
    meta = FileMetadata(
        id=fid,
        path=f"test_{fid[:6]}.fcs",
        event_count=n_events,
        channels=channels,
    )
    events = np.random.uniform(100, 900, (n_events, n_ch)).astype(np.float32)
    storage_svc.register_file(meta, events)
    return fid


def make_rect_gate(file_id: str, name: str = "TestGate") -> str:
    """Create a rectangle gate via the API and return the gate_id."""
    resp = client.post(
        "/api/gates",
        json={
            "file_id": file_id,
            "name": name,
            "x_channel": "CH1",
            "y_channel": "CH2",
            "params": {
                "type": "rectangle",
                "x_min": 100.0,
                "x_max": 900.0,
                "y_min": 100.0,
                "y_max": 900.0,
            },
        },
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


def make_layout(source_file_id: str, name: str = "MyLayout") -> str:
    """Save a layout and return layout_id."""
    resp = client.post(
        "/api/layouts",
        json={"name": name, "source_file_id": source_file_id},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.fixture(autouse=True)
def clean_layouts():
    """Reset layout store between tests."""
    layouts_service.reset_layout_store()
    yield
    layouts_service.reset_layout_store()


# ─── U-1  Save layout ─────────────────────────────────────────────────────────

def test_u1_save_layout_201():
    fid = make_file()
    make_rect_gate(fid, "Gate1")
    resp = client.post("/api/layouts", json={"name": "LayoutA", "source_file_id": fid})
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "LayoutA"
    assert body["source_file_id"] == fid
    assert body["gate_count"] >= 1
    assert "id" in body


# ─── U-2  List layouts ────────────────────────────────────────────────────────

def test_u2_list_layouts_list_item_fields():
    fid = make_file()
    make_rect_gate(fid)
    lid = make_layout(fid, "L1")

    resp = client.get("/api/layouts")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    item = items[0]
    assert item["id"] == lid
    assert item["name"] == "L1"
    assert "description" in item
    assert "author" in item
    assert "tags" in item
    assert "created_date" in item
    assert "modified_date" in item
    assert item["strategy_step_count"] == 0


# ─── U-3  Get layout detail ───────────────────────────────────────────────────

def test_u3_get_layout_detail():
    fid = make_file()
    make_rect_gate(fid)
    lid = make_layout(fid, "DetailLayout")

    resp = client.get(f"/api/layouts/{lid}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == lid
    assert body["name"] == "DetailLayout"
    assert "metadata" in body
    meta = body["metadata"]
    assert "description" in meta
    assert "author" in meta
    assert "compatible_channels" in meta
    assert "tags" in meta
    assert isinstance(body["strategy"], list)


# ─── U-4  Update layout name only ────────────────────────────────────────────

def test_u4_update_name_only():
    fid = make_file()
    make_rect_gate(fid)
    lid = make_layout(fid, "OldName")

    resp = client.put(f"/api/layouts/{lid}", json={"name": "NewName"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "NewName"


# ─── U-5  Update metadata only ───────────────────────────────────────────────

def test_u5_update_metadata_only():
    fid = make_file()
    make_rect_gate(fid)
    lid = make_layout(fid, "LayoutMeta")

    metadata = {
        "description": "CD4 T-cell profiling panel",
        "author": "Lab A",
        "compatible_channels": ["CD4", "CD8"],
        "tags": ["T-cells", "PBMC"],
    }
    resp = client.put(f"/api/layouts/{lid}", json={"metadata": metadata})
    assert resp.status_code == 200
    body = resp.json()
    assert body["metadata"]["description"] == "CD4 T-cell profiling panel"
    assert body["metadata"]["author"] == "Lab A"
    assert "T-cells" in body["metadata"]["tags"]
    # name unchanged
    assert body["name"] == "LayoutMeta"


# ─── U-6  Update both name and metadata ──────────────────────────────────────

def test_u6_update_name_and_metadata():
    fid = make_file()
    make_rect_gate(fid)
    lid = make_layout(fid, "Orig")

    resp = client.put(
        f"/api/layouts/{lid}",
        json={
            "name": "Renamed",
            "metadata": {
                "description": "desc",
                "author": "Alice",
                "compatible_channels": [],
                "tags": ["flow"],
            },
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Renamed"
    assert body["metadata"]["author"] == "Alice"
    assert body["metadata"]["description"] == "desc"


# ─── U-7  Delete layout ───────────────────────────────────────────────────────

def test_u7_delete_layout():
    fid = make_file()
    make_rect_gate(fid)
    lid = make_layout(fid)

    resp = client.delete(f"/api/layouts/{lid}")
    assert resp.status_code == 204

    # confirm gone from list
    list_resp = client.get("/api/layouts")
    assert all(i["id"] != lid for i in list_resp.json())


# ─── U-8  GET strategy empty ─────────────────────────────────────────────────

def test_u8_get_strategy_initially_empty():
    fid = make_file()
    make_rect_gate(fid)
    lid = make_layout(fid)

    resp = client.get(f"/api/layouts/{lid}/strategy")
    assert resp.status_code == 200
    assert resp.json() == []


# ─── U-9  PUT strategy → persisted ───────────────────────────────────────────

def test_u9_put_strategy():
    fid = make_file()
    make_rect_gate(fid, "GateA")
    lid = make_layout(fid)

    steps = [
        {
            "gate_name": "GateA",
            "condition_type": "always",
            "threshold": 0.0,
            "notes": "Primary gate",
        }
    ]
    resp = client.put(f"/api/layouts/{lid}/strategy", json={"steps": steps})
    assert resp.status_code == 200
    result = resp.json()
    assert len(result) == 1
    assert result[0]["gate_name"] == "GateA"
    assert result[0]["notes"] == "Primary gate"


# ─── U-10 GET strategy after update ──────────────────────────────────────────

def test_u10_get_strategy_after_update():
    fid = make_file()
    make_rect_gate(fid, "GateB")
    lid = make_layout(fid)

    client.put(
        f"/api/layouts/{lid}/strategy",
        json={
            "steps": [
                {
                    "gate_name": "GateB",
                    "condition_type": "if_parent_count_gt",
                    "threshold": 50.0,
                    "notes": "conditional",
                }
            ]
        },
    )

    resp = client.get(f"/api/layouts/{lid}/strategy")
    assert resp.status_code == 200
    steps = resp.json()
    assert len(steps) == 1
    assert steps[0]["condition_type"] == "if_parent_count_gt"
    assert steps[0]["threshold"] == 50.0


# ─── U-11 Replace strategy ────────────────────────────────────────────────────

def test_u11_replace_strategy():
    fid = make_file()
    make_rect_gate(fid, "G1")
    make_rect_gate(fid, "G2")
    lid = make_layout(fid)

    client.put(
        f"/api/layouts/{lid}/strategy",
        json={"steps": [{"gate_name": "G1", "condition_type": "always", "threshold": 0, "notes": ""}]},
    )
    # Replace with G2 only
    resp = client.put(
        f"/api/layouts/{lid}/strategy",
        json={"steps": [{"gate_name": "G2", "condition_type": "always", "threshold": 0, "notes": "step2"}]},
    )
    assert resp.status_code == 200
    steps = resp.json()
    assert len(steps) == 1
    assert steps[0]["gate_name"] == "G2"


# ─── U-12 List returns strategy_step_count ───────────────────────────────────

def test_u12_list_strategy_step_count():
    fid = make_file()
    make_rect_gate(fid, "G1")
    make_rect_gate(fid, "G2")
    lid = make_layout(fid)

    client.put(
        f"/api/layouts/{lid}/strategy",
        json={
            "steps": [
                {"gate_name": "G1", "condition_type": "always", "threshold": 0, "notes": ""},
                {"gate_name": "G2", "condition_type": "always", "threshold": 0, "notes": ""},
            ]
        },
    )

    items = client.get("/api/layouts").json()
    match = next(i for i in items if i["id"] == lid)
    assert match["strategy_step_count"] == 2


# ─── U-13 Apply layout ────────────────────────────────────────────────────────

def test_u13_apply_layout():
    fid = make_file()
    make_rect_gate(fid, "ApplyGate")
    lid = make_layout(fid)

    target_fid = make_file()
    resp = client.post(f"/api/layouts/{lid}/apply?target_file_id={target_fid}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "applied"
    assert body["gates_applied"] >= 1


# ─── U-14 Apply to non-existent file → 404 ───────────────────────────────────

def test_u14_apply_to_missing_file():
    fid = make_file()
    make_rect_gate(fid)
    lid = make_layout(fid)

    resp = client.post(f"/api/layouts/{lid}/apply?target_file_id=no-such-file")
    assert resp.status_code == 404


# ─── U-15 GET missing layout → 404 ───────────────────────────────────────────

def test_u15_get_missing_layout():
    resp = client.get("/api/layouts/no-such-id")
    assert resp.status_code == 404


# ─── U-16 PUT missing layout → 404 ───────────────────────────────────────────

def test_u16_put_missing_layout():
    resp = client.put("/api/layouts/no-such-id", json={"name": "X"})
    assert resp.status_code == 404


# ─── U-17 DELETE missing layout → 404 ────────────────────────────────────────

def test_u17_delete_missing_layout():
    resp = client.delete("/api/layouts/no-such-id")
    assert resp.status_code == 404


# ─── U-18 Save empty name → 400 ──────────────────────────────────────────────

def test_u18_save_empty_name():
    fid = make_file()
    resp = client.post("/api/layouts", json={"name": "   ", "source_file_id": fid})
    assert resp.status_code == 400


# ─── U-19 Update with empty name → 400 ───────────────────────────────────────

def test_u19_update_empty_name():
    fid = make_file()
    make_rect_gate(fid)
    lid = make_layout(fid)

    resp = client.put(f"/api/layouts/{lid}", json={"name": ""})
    assert resp.status_code == 400


# ─── U-20 compatible_channels auto-populated ─────────────────────────────────

def test_u20_compatible_channels_auto_populated():
    fid = make_file()
    make_rect_gate(fid, "MyGate")  # uses CH1 + CH2
    lid = make_layout(fid)

    resp = client.get(f"/api/layouts/{lid}")
    body = resp.json()
    channels = body["metadata"]["compatible_channels"]
    assert "CH1" in channels
    assert "CH2" in channels


# ─── U-21 Disk persistence ────────────────────────────────────────────────────

def test_u21_disk_persistence(tmp_path, monkeypatch):
    """Layout store survives a reload from disk."""
    monkeypatch.setenv("OPENCYTO_DATA_DIR", str(tmp_path))

    import services.gates as gs
    from models.layout_models import GatingStep
    from services.layouts import LayoutStore

    # Build a fresh store pointing at tmp_path
    store1 = LayoutStore()
    fid = make_file()
    make_rect_gate(fid, "PersistGate")
    tree = gs.get_gate_tree(fid)
    layout = store1.save("PersistLayout", tree, fid)
    store1.update_strategy(
        layout.id,
        [GatingStep(gate_name="PersistGate", condition_type="always", threshold=0.0, notes="step1")],
    )

    # Reload from disk — simulates application restart
    store2 = LayoutStore()
    loaded = store2.get(layout.id)
    assert loaded is not None
    assert loaded.name == "PersistLayout"
    assert len(loaded.strategy) == 1
    assert loaded.strategy[0].gate_name == "PersistGate"
