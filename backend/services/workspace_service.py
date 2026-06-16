"""Workspace save and load."""

from __future__ import annotations

import warnings
from collections import deque
from typing import Any, Dict, List

from models.workspace_models import (
  WorkspaceFileEntry,
  WorkspaceGateDef,
  WorkspaceLoadResult,
  WorkspaceSave,
)
from services import compensation as compensation_service, fcs_parser, gates as gates_service, storage
import numpy as np


def build_workspace_save(file_ids: List[str] | None = None) -> WorkspaceSave:
  """Build workspace JSON from current in-memory state. If file_ids is None, use all loaded files."""
  if file_ids is None:
    file_ids = storage.list_loaded_file_ids()

  files: List[WorkspaceFileEntry] = []
  compensation: Dict[str, List[List[float]]] = {}
  gate_defs: List[WorkspaceGateDef] = []
  default_axes: Dict[str, Dict[str, Any]] = {}

  for fid in file_ids:
    meta = storage.get_file_metadata_if_loaded(fid)
    if meta is None:
      continue
    files.append(
      WorkspaceFileEntry(path=meta.path, id=meta.id, n_channels=len(meta.channels)),
    )
    comp_matrix = storage.get_compensation_matrix(fid)
    if comp_matrix is not None:
      compensation[fid] = comp_matrix.tolist()
    for gate in gates_service.get_gate_defs(fid):
      gate_defs.append(
        WorkspaceGateDef(
          file_id=gate.file_id,
          name=gate.name,
          type=gate.type,
          x_channel=gate.x_channel,
          y_channel=gate.y_channel,
          transform_x=gate.transform_x,
          transform_y=gate.transform_y,
          arcsinh_cofactor=gate.arcsinh_cofactor,
          logicle_T=gate.logicle_T,
          logicle_W=gate.logicle_W,
          logicle_M=gate.logicle_M,
          logicle_A=gate.logicle_A,
          parent_gate_id=gate.parent_gate_id,
          order=gate.order,
          original_id=gate.id,
          x_min=gate.x_min,
          y_min=gate.y_min,
          x_max=gate.x_max,
          y_max=gate.y_max,
          vertices=gate.vertices,
          expression=gate.expression,
          center_x=gate.center_x,
          center_y=gate.center_y,
          radius_x=gate.radius_x,
          radius_y=gate.radius_y,
          angle=gate.angle,
          x_threshold=gate.x_threshold,
          y_threshold=gate.y_threshold,
        )
      )

  return WorkspaceSave(
    version=2,
    files=files,
    compensation=compensation,
    gates=gate_defs,
    default_axes=default_axes,
  )


def load_workspace(ws: WorkspaceSave) -> WorkspaceLoadResult:
  """Load workspace: load files by path, apply compensation, create gates. Returns summary and data for frontend."""
  from models.file_models import ChannelMetadata, FileMetadata
  from models.gate_models import BooleanGateCreate, EllipseGateCreate, GateCreateRequest, IntervalGateCreate, PolygonGateCreate, QuadGateCreate, RectangleGateCreate

  if not ws.files:
    return WorkspaceLoadResult(files_loaded=0, compensation_applied=0, gates_created=0, gate_errors=[])

  # Support synthetic in-memory files used in tests (paths like /synthetic/{n}_{seed}.fcs)
  loaded: List[FileMetadata] = []
  real_paths: List[str] = []
  for entry in ws.files:
    norm_path = entry.path.replace("\\", "/")
    if norm_path.startswith("/synthetic/") and entry.id and entry.id.startswith("synthetic_"):
      try:
        _, n_str, seed_str = entry.id.split("_", 2)
        n_events = int(n_str)
        seed = int(seed_str)
      except Exception as exc:
        raise ValueError(f"Invalid synthetic id format: {entry.id}") from exc
      n_ch = entry.n_channels if entry.n_channels is not None else 4
      if n_ch < 1:
        raise ValueError(f"Invalid n_channels for synthetic file: {entry.n_channels!r}")
      rng = np.random.default_rng(seed)
      events = rng.uniform(0, 1000, size=(n_events, n_ch)).astype(np.float32)
      channels = [
        ChannelMetadata(
          name=f"CH{i+1}",
          index=i + 1,
          stain=None,
          range=1024.0,
          amplification=None,
          display_name=f"CH{i+1}",
        )
        for i in range(n_ch)
      ]
      meta = FileMetadata(
        id=entry.id,
        path=entry.path,
        sample_name="synthetic",
        event_count=n_events,
        channels=channels,
      )
      storage.register_file(meta, events)
      loaded.append(meta)
    else:
      real_paths.append(entry.path)

  if real_paths:
    try:
      real_loaded = fcs_parser.load_and_register_files(real_paths)
    except Exception as e:
      raise ValueError(f"Failed to load files: {e}") from e
    loaded.extend(real_loaded)

  file_metadata: List[Dict[str, Any]] = [m.model_dump() for m in loaded]
  loaded_ids = {m.id for m in loaded}
  compensation_applied = 0
  for fid, matrix in ws.compensation.items():
    if fid not in loaded_ids:
      continue
    try:
      compensation_service.apply_compensation(fid, matrix)
      compensation_applied += 1
    except (KeyError, ValueError):
      pass

  gates_created = 0
  gates_out: List[Dict[str, Any]] = []
  gate_errors: List[str] = []

  def sorted_gates(gates: List[WorkspaceGateDef]) -> List[WorkspaceGateDef]:
    """Kahn topological sort: parents before children (O(n + edges)); cycles appended last."""
    n = len(gates)
    orig_to_idx: Dict[str, int] = {}
    for i, g in enumerate(gates):
      if g.original_id and g.original_id not in orig_to_idx:
        orig_to_idx[g.original_id] = i
    children_by_idx: dict[int, list[int]] = {i: [] for i in range(n)}
    indeg = [0] * n
    for i, g in enumerate(gates):
      pid = g.parent_gate_id
      if pid and pid in orig_to_idx:
        p = orig_to_idx[pid]
        children_by_idx[p].append(i)
        indeg[i] += 1
    queue: deque[int] = deque(i for i in range(n) if indeg[i] == 0)
    ordered_idx: list[int] = []
    while queue:
      i = queue.popleft()
      ordered_idx.append(i)
      for j in children_by_idx[i]:
        indeg[j] -= 1
        if indeg[j] == 0:
          queue.append(j)
    unresolved = [i for i in range(n) if indeg[i] > 0]
    if unresolved:
      warnings.warn(
        f"[Workspace] {len(unresolved)} gate(s) unresolved (cycle or missing parent in file); "
        "appending in arbitrary order.",
      )
    return [gates[i] for i in ordered_idx] + [gates[i] for i in unresolved]

  id_map: Dict[str, str] = {}
  for g in sorted_gates(ws.gates):
    if g.file_id not in loaded_ids:
      continue
    try:
      if (
        g.type == "rectangle"
        and g.x_min is not None
        and g.y_min is not None
        and g.x_max is not None
        and g.y_max is not None
      ):
        params = RectangleGateCreate(
          type="rectangle",
          x_min=g.x_min,
          y_min=g.y_min,
          x_max=g.x_max,
          y_max=g.y_max,
        )
      elif g.type == "polygon" and g.vertices and len(g.vertices) >= 3:
        params = PolygonGateCreate(type="polygon", vertices=g.vertices)
      elif g.type == "interval" and g.x_min is not None and g.x_max is not None:
        params = IntervalGateCreate(type="interval", x_min=g.x_min, x_max=g.x_max)
      elif g.type == "boolean" and g.expression:
        params = BooleanGateCreate(type="boolean", expression=g.expression)
      elif (
        g.type == "ellipse"
        and g.center_x is not None and g.center_y is not None
        and g.radius_x is not None and g.radius_y is not None
      ):
        params = EllipseGateCreate(
          type="ellipse",
          center_x=g.center_x,
          center_y=g.center_y,
          radius_x=g.radius_x,
          radius_y=g.radius_y,
          angle=g.angle,
        )
      elif g.type == "quad" and g.x_threshold is not None and g.y_threshold is not None:
        params = QuadGateCreate(
          type="quad",
          x_threshold=g.x_threshold,
          y_threshold=g.y_threshold,
        )
      else:
        continue
      new_parent_id = id_map.get(g.parent_gate_id) if g.parent_gate_id else None
      body = GateCreateRequest(
        file_id=g.file_id,
        name=g.name,
        x_channel=g.x_channel,
        y_channel=g.y_channel,
        parent_gate_id=new_parent_id,
        order=g.order,
        transform_x=g.transform_x,
        transform_y=g.transform_y,
        arcsinh_cofactor=g.arcsinh_cofactor,
        logicle_T=g.logicle_T,
        logicle_W=g.logicle_W,
        logicle_M=g.logicle_M,
        logicle_A=g.logicle_A,
        params=params,
      )
      resp = gates_service.create_gate(body)
      gates_created += 1
      gates_out.append(resp.model_dump())
      if g.original_id:
        id_map[g.original_id] = resp.id
    except (KeyError, ValueError) as exc:
      gate_errors.append(f"Gate {g.name!r} (file {g.file_id}): {exc}")

  return WorkspaceLoadResult(
    files_loaded=len(loaded),
    compensation_applied=compensation_applied,
    gates_created=gates_created,
    gate_errors=gate_errors,
    file_metadata=file_metadata,
    gates=gates_out,
  )
