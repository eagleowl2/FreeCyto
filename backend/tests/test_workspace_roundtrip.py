"""Workspace save/load round-trip (no committed FCS binary required)."""

from __future__ import annotations

import os
import sys

import numpy as np

HERE = os.path.dirname(__file__)
BACKEND_ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
if BACKEND_ROOT not in sys.path:
  sys.path.insert(0, BACKEND_ROOT)

from models.file_models import ChannelMetadata, FileMetadata
from models.gate_models import GateCreateRequest, PolygonGateCreate, RectangleGateCreate
from services import gates as gates_service, storage, workspace_service


def _register_workspace_synthetic() -> str:
  """Register the same synthetic layout `load_workspace` rebuilds from `/synthetic/…` paths."""
  file_id = "synthetic_100_42"
  path = "/synthetic/100_42.fcs"
  rng = np.random.default_rng(42)
  events = rng.uniform(0, 1000, size=(100, 4)).astype(np.float32)
  channels = [
    ChannelMetadata(
      name=f"CH{i + 1}",
      index=i + 1,
      stain=None,
      range=1024.0,
      amplification=None,
      display_name=f"CH{i + 1}",
    )
    for i in range(4)
  ]
  meta = FileMetadata(
    id=file_id,
    path=path,
    sample_name="synthetic",
    event_count=100,
    channels=channels,
  )
  storage.register_file(meta, events)
  return file_id


def test_workspace_roundtrip_hierarchy() -> None:
  file_id = _register_workspace_synthetic()

  rect_params = RectangleGateCreate(type="rectangle", x_min=0.0, y_min=0.0, x_max=1.0, y_max=1.0)
  g1 = gates_service.create_gate(
    GateCreateRequest(
      file_id=file_id,
      name="G1",
      x_channel="CH1",
      y_channel="CH2",
      params=rect_params,
    )
  )
  poly_params = PolygonGateCreate(type="polygon", vertices=[[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]])
  gates_service.create_gate(
    GateCreateRequest(
      file_id=file_id,
      name="G2",
      x_channel="CH1",
      y_channel="CH2",
      parent_gate_id=g1.id,
      params=poly_params,
    )
  )

  tree_before = gates_service.get_gate_tree(file_id)
  assert len(tree_before) == 1
  assert tree_before[0].name == "G1"
  assert len(tree_before[0].children) == 1
  assert tree_before[0].children[0].name == "G2"

  ws = workspace_service.build_workspace_save([file_id])
  assert ws.files and ws.files[0].n_channels == 4

  gates_service.delete_all_gates_for_file(file_id)
  res = workspace_service.load_workspace(ws)
  assert res.gates_created == 2
  assert res.gate_errors == []

  tree_after = gates_service.get_gate_tree(file_id)
  assert len(tree_after) == 1
  assert tree_after[0].name == "G1"
  assert len(tree_after[0].children) == 1
  assert tree_after[0].children[0].name == "G2"


def test_workspace_synthetic_ws4_channel_count_roundtrip() -> None:
  """WS-4: saved n_channels restores synthetic event matrix width after reload."""
  file_id = "synthetic_50_7"
  path = "/synthetic/50_7.fcs"
  n_ch = 6
  rng = np.random.default_rng(7)
  events = rng.uniform(0, 1000, size=(50, n_ch)).astype(np.float32)
  channels = [
    ChannelMetadata(
      name=f"CH{i + 1}",
      index=i + 1,
      stain=None,
      range=1024.0,
      amplification=None,
      display_name=f"CH{i + 1}",
    )
    for i in range(n_ch)
  ]
  meta = FileMetadata(
    id=file_id,
    path=path,
    sample_name="synthetic",
    event_count=50,
    channels=channels,
  )
  storage.register_file(meta, events)
  gates_service.create_gate(
    GateCreateRequest(
      file_id=file_id,
      name="R",
      x_channel="CH1",
      y_channel="CH2",
      params=RectangleGateCreate(type="rectangle", x_min=0.0, y_min=0.0, x_max=500.0, y_max=500.0),
    )
  )
  ws = workspace_service.build_workspace_save([file_id])
  assert ws.files[0].n_channels == n_ch
  gates_service.delete_all_gates_for_file(file_id)
  storage.delete_file(file_id)

  res = workspace_service.load_workspace(ws)
  assert res.gate_errors == []
  assert res.file_metadata[0]["channels"][5]["name"] == "CH6"
  ev = storage.get_file_events(file_id)
  assert ev.shape == (50, n_ch)
