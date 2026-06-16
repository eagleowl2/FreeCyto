"""Sample group management, gating template extraction/application, and batch statistics.

Groups and their attached gating templates persist to ``~/.freecyto/groups.json``
(overridable via ``OPENCYTO_DATA_DIR``), mirroring the layout and experiment stores so
multi-sample setups survive a restart.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("opencyto")

from models.gate_models import (
  BooleanGateCreate,
  EllipseGateCreate,
  GateCreateRequest,
  IntervalGateCreate,
  PolygonGateCreate,
  QuadGateCreate,
  RectangleGateCreate,
)
from models.group_models import (
  BatchStatRow,
  BatchStatsResponse,
  GatingTemplate,
  GroupResponse,
  SampleInfo,
  TemplateGate,
)
from services import gates as gates_service, storage


# ---------------------------------------------------------------------------
# In-memory stores
# ---------------------------------------------------------------------------

_groups: dict[str, dict[str, Any]] = {}  # group_id -> {id, name, file_ids, template_id}
_templates: dict[str, GatingTemplate] = {}  # template_id -> GatingTemplate


# ---------------------------------------------------------------------------
# Disk persistence (mirrors services/layouts.py)
# ---------------------------------------------------------------------------


def _groups_path() -> Path:
  base = Path(os.getenv("OPENCYTO_DATA_DIR", Path.home() / ".freecyto"))
  base.mkdir(parents=True, exist_ok=True)
  return base / "groups.json"


def _save_to_disk() -> None:
  """Persist groups + templates to disk. Best-effort; never raises."""
  try:
    data = {
      "version": 1,
      "groups": list(_groups.values()),
      "templates": [t.model_dump() for t in _templates.values()],
    }
    _groups_path().write_text(json.dumps(data, default=str, indent=2), encoding="utf-8")
  except Exception:
    logger.exception("Failed to persist groups to disk")


def _load_from_disk() -> None:
  """Load groups + templates from disk into the in-memory stores (best-effort)."""
  path = _groups_path()
  if not path.exists():
    return
  try:
    raw = json.loads(path.read_text(encoding="utf-8"))
    for grp in raw.get("groups", []):
      _groups[grp["id"]] = {
        "id": grp["id"],
        "name": grp["name"],
        "file_ids": list(grp.get("file_ids", [])),
        "template_id": grp.get("template_id"),
      }
    for tpl in raw.get("templates", []):
      template = GatingTemplate(**tpl)
      _templates[template.id] = template
    logger.info("Loaded %d groups, %d templates from %s", len(_groups), len(_templates), path)
  except Exception:
    logger.exception("Failed to load groups from disk — starting fresh")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _file_label(file_id: str) -> str:
  """Return a human-readable label for a file (path basename, or file_id on error)."""
  try:
    meta = storage.get_file_metadata(file_id)
    return Path(meta.path).name
  except Exception:
    return file_id


def _build_group_response(group_id: str) -> GroupResponse:
  grp = _groups[group_id]
  samples = [SampleInfo(file_id=fid, label=_file_label(fid)) for fid in grp["file_ids"]]
  return GroupResponse(
    id=grp["id"],
    name=grp["name"],
    samples=samples,
    template_id=grp["template_id"],
  )


# ---------------------------------------------------------------------------
# Group CRUD
# ---------------------------------------------------------------------------


def create_group(name: str, file_ids: list[str]) -> GroupResponse:
  """Create a new group containing the given file_ids."""
  group_id = str(uuid.uuid4())
  _groups[group_id] = {
    "id": group_id,
    "name": name,
    "file_ids": list(file_ids),
    "template_id": None,
  }
  _save_to_disk()
  return _build_group_response(group_id)


def get_group(group_id: str) -> GroupResponse:
  if group_id not in _groups:
    raise KeyError(f"Group {group_id!r} not found")
  return _build_group_response(group_id)


def list_groups() -> list[GroupResponse]:
  return [_build_group_response(gid) for gid in _groups]


def delete_group(group_id: str) -> None:
  if group_id not in _groups:
    raise KeyError(f"Group {group_id!r} not found")
  del _groups[group_id]
  _save_to_disk()


def reset_group_store() -> None:
  """Clear all groups and templates in memory (for tests).

  Like the layout store's clear(), this does NOT touch the disk file, so a test
  teardown never wipes a real user's groups.json.
  """
  _groups.clear()
  _templates.clear()


# ---------------------------------------------------------------------------
# Gating templates
# ---------------------------------------------------------------------------


def create_template(group_id: str, source_file_id: str, template_name: str) -> GatingTemplate:
  """Extract gate definitions from *source_file_id* and attach the resulting template to *group_id*."""
  if group_id not in _groups:
    raise KeyError(f"Group {group_id!r} not found")

  gate_defs = gates_service.get_gate_defs(source_file_id)
  id_to_name: dict[str, str] = {g.id: g.name for g in gate_defs}

  template_gates: list[TemplateGate] = []
  for g in gate_defs:
    parent_name = id_to_name.get(g.parent_gate_id) if g.parent_gate_id else None
    template_gates.append(
      TemplateGate(
        name=g.name,
        type=g.type,
        parent_name=parent_name,
        x_channel=g.x_channel,
        y_channel=g.y_channel,
        transform_x=g.transform_x,
        transform_y=g.transform_y,
        arcsinh_cofactor=g.arcsinh_cofactor,
        logicle_T=g.logicle_T,
        logicle_W=g.logicle_W,
        logicle_M=g.logicle_M,
        logicle_A=g.logicle_A,
        x_min=g.x_min,
        y_min=g.y_min,
        x_max=g.x_max,
        y_max=g.y_max,
        vertices=g.vertices,
        expression=g.expression,
        center_x=g.center_x,
        center_y=g.center_y,
        radius_x=g.radius_x,
        radius_y=g.radius_y,
        angle=g.angle,
        x_threshold=g.x_threshold,
        y_threshold=g.y_threshold,
      )
    )

  template_id = str(uuid.uuid4())
  template = GatingTemplate(
    id=template_id,
    name=template_name,
    source_file_id=source_file_id,
    gates=template_gates,
  )
  _templates[template_id] = template
  _groups[group_id]["template_id"] = template_id
  _save_to_disk()
  return template


def _template_gate_to_params(tg: TemplateGate):
  """Build the discriminated gate-params object for a template gate, or None if incomplete.

  Handles every gate type FreeCyto supports (rectangle, interval, polygon, boolean,
  ellipse, quad). A quad node is recreated as a bare node — its four child rectangles
  appear in the template as separate gates (parented by name) and are recreated normally.
  """
  if tg.type == "rectangle":
    if any(v is None for v in (tg.x_min, tg.y_min, tg.x_max, tg.y_max)):
      return None
    return RectangleGateCreate(
      type="rectangle",
      x_min=tg.x_min, y_min=tg.y_min, x_max=tg.x_max, y_max=tg.y_max,  # type: ignore[arg-type]
    )
  if tg.type == "interval":
    if tg.x_min is None or tg.x_max is None:
      return None
    return IntervalGateCreate(type="interval", x_min=tg.x_min, x_max=tg.x_max)
  if tg.type == "polygon":
    if not tg.vertices or len(tg.vertices) < 3:
      return None
    return PolygonGateCreate(type="polygon", vertices=tg.vertices)
  if tg.type == "boolean":
    if not tg.expression:
      return None
    return BooleanGateCreate(type="boolean", expression=tg.expression)
  if tg.type == "ellipse":
    if any(v is None for v in (tg.center_x, tg.center_y, tg.radius_x, tg.radius_y)):
      return None
    return EllipseGateCreate(
      type="ellipse",
      center_x=tg.center_x, center_y=tg.center_y,  # type: ignore[arg-type]
      radius_x=tg.radius_x, radius_y=tg.radius_y, angle=tg.angle,  # type: ignore[arg-type]
    )
  if tg.type == "quad":
    if tg.x_threshold is None or tg.y_threshold is None:
      return None
    return QuadGateCreate(type="quad", x_threshold=tg.x_threshold, y_threshold=tg.y_threshold)
  return None  # unknown type


def apply_template(template_id: str, target_file_id: str) -> list[str]:
  """Apply gating template to *target_file_id*, creating gates in tree order.

  Duplicate-name gates are silently skipped (idempotent). Returns a list of
  newly created gate IDs. All gate types are supported (see _template_gate_to_params).
  """
  if template_id not in _templates:
    raise KeyError(f"Template {template_id!r} not found")
  template = _templates[template_id]

  name_to_id: dict[str, str] = {}
  created_ids: list[str] = []

  for tg in template.gates:
    parent_gate_id = name_to_id.get(tg.parent_name) if tg.parent_name else None

    params = _template_gate_to_params(tg)
    if params is None:
      continue  # incomplete or unknown gate type

    req = GateCreateRequest(
      file_id=target_file_id,
      name=tg.name,
      x_channel=tg.x_channel,
      y_channel=tg.y_channel,
      parent_gate_id=parent_gate_id,
      transform_x=tg.transform_x,
      transform_y=tg.transform_y,
      arcsinh_cofactor=tg.arcsinh_cofactor,
      logicle_T=tg.logicle_T,
      logicle_W=tg.logicle_W,
      logicle_M=tg.logicle_M,
      logicle_A=tg.logicle_A,
      params=params,
    )
    try:
      response = gates_service.create_gate(req)
      name_to_id[tg.name] = response.id
      created_ids.append(response.id)
    except Exception:
      # Skip duplicate names, missing channels, etc. — continue with siblings/children.
      pass

  return created_ids


# ---------------------------------------------------------------------------
# Batch statistics
# ---------------------------------------------------------------------------


def get_batch_stats(group_id: str, gate_name: str) -> BatchStatsResponse:
  """Compute gate statistics for *gate_name* across all files in *group_id*."""
  if group_id not in _groups:
    raise KeyError(f"Group {group_id!r} not found")
  grp = _groups[group_id]
  rows: list[BatchStatRow] = []

  for file_id in grp["file_ids"]:
    label = _file_label(file_id)
    try:
      gate_list = gates_service.list_gates(file_id)
    except Exception:
      rows.append(
        BatchStatRow(
          file_id=file_id,
          label=label,
          gate_name=gate_name,
          count=0,
          pct_of_parent=0.0,
          pct_of_total=0.0,
          parent_count=0,
        )
      )
      continue

    matched = next((gate for gate in gate_list if gate.name == gate_name), None)
    if matched is None:
      rows.append(
        BatchStatRow(
          file_id=file_id,
          label=label,
          gate_name=gate_name,
          count=0,
          pct_of_parent=0.0,
          pct_of_total=0.0,
          parent_count=0,
        )
      )
    else:
      rows.append(
        BatchStatRow(
          file_id=file_id,
          label=label,
          gate_name=gate_name,
          count=matched.count,
          pct_of_parent=matched.pct_of_parent,
          pct_of_total=matched.pct_of_total,
          parent_count=matched.parent_count,
        )
      )

  return BatchStatsResponse(group_id=group_id, gate_name=gate_name, rows=rows)


# Load any persisted groups/templates at import (cleared per-test by conftest).
_load_from_disk()
