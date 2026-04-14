"""
Simple gate flow test without UI. Run from repo root:
  cd backend && python -m scripts.test_gates_flow
Or from backend: python -m scripts.test_gates_flow

Requires: storage has no dependency on fcs_parser for this test; we register a minimal file.
"""
from __future__ import annotations

import sys

# Ensure backend is on path
if __name__ == "__main__":
    sys.path.insert(0, "")

import numpy as np

try:
    # When imported under pytest, treat this as a helper script, not a test module.
    # This avoids collection errors in environments that do not configure the backend on sys.path.
    import pytest  # type: ignore

    pytest.skip("Legacy manual gate-flow script; run via 'python -m scripts.test_gates_flow'", allow_module_level=True)
except Exception:
    # Normal script execution path (no pytest in sys.modules).
    pass

from models.file_models import ChannelMetadata, FileMetadata
from models.gate_models import GateCreateRequest, RectangleGateCreate
from services import gates, storage


def main() -> int:
    file_id = "test-file-gates-1"
    # Minimal file: 2 channels, 100 events
    metadata = FileMetadata(
        id=file_id,
        path="/fake/test.fcs",
        sample_name="Test",
        event_count=100,
        channels=[
            ChannelMetadata(index=1, name="FSC-A", display_name="FSC-A"),
            ChannelMetadata(index=2, name="SSC-A", display_name="SSC-A"),
        ],
    )
    rng = np.random.default_rng(0)
    events = rng.uniform(0, 1000, size=(100, 2)).astype(np.float64)
    storage.register_file(metadata, events)

    try:
        # 1) No gates initially
        tree0 = gates.get_gate_tree(file_id)
        assert tree0 == [], f"Expected no gates, got {len(tree0)}"

        # 2) Create first gate
        body = GateCreateRequest(
            file_id=file_id,
            name="gate1",
            x_channel="FSC-A",
            y_channel="SSC-A",
            parent_gate_id=None,
            params=RectangleGateCreate(
                type="rectangle",
                x_min=0, y_min=0, x_max=500, y_max=500,
            ),
        )
        resp1 = gates.create_gate(body)
        assert resp1.name == "gate1", resp1.name
        assert 15 <= resp1.count <= 40, f"Expected ~25 events in [0,500]x[0,500] gate, got {resp1.count}"

        # 3) Tree should show one root gate
        tree1 = gates.get_gate_tree(file_id)
        assert len(tree1) == 1, f"Expected 1 root gate, got {len(tree1)}"
        assert tree1[0].name == "gate1", tree1[0].name

        # 4) Create same name again -> must raise
        try:
            gates.create_gate(body)
            print("FAIL: expected GateNameExistsError on duplicate name")
            return 1
        except gates.GateNameExistsError as e:
            assert "gate1" in str(e), str(e)
            print("OK: duplicate name correctly rejected")

        # 5) Tree still one gate
        tree2 = gates.get_gate_tree(file_id)
        assert len(tree2) == 1, f"After duplicate attempt expected 1 root gate, got {len(tree2)}"

        print("All gate flow checks passed.")
        return 0
    finally:
        # Cleanup: evict file so storage and gates are cleared for this file
        try:
            storage.delete_file(file_id)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
