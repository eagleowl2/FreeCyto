"""Sample group management, gating template extraction/application, and batch statistics."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from models.gate_models import (
  GateCreateRequest,
  IntervalGateCreate,
  PolygonGateCreate,
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


def reset_group_store() -> None:
  """Clear all groups and templates (for tests)."""
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
  return template


def apply_template(template_id: str, target_file_id: str) -> list[str]:
  """Apply gating template to *target_file_id*, creating gates in tree order.

  Duplicate-name gates are silently skipped (idempotent). Returns a list of
  newly created gate IDs.
  """
  if template_id not in _templates:
    raise KeyError(f"Template {template_id!r} not found")
  template = _templates[template_id]

  name_to_id: dict[str, str] = {}
  created_ids: list[str] = []

  for tg in template.gates:
    parent_gate_id = name_to_id.get(tg.parent_name) if tg.parent_name else None

    # Build discriminated gate params
    if tg.type == "rectangle":
      if any(v is None for v in (tg.x_min, tg.y_min, tg.x_max, tg.y_max)):
        continue
      params: RectangleGateCreate | PolygonGateCreate | IntervalGateCreate = RectangleGateCreate(
        type="rectangle",
        x_min=tg.x_min,  # type: ignore[arg-type]
        y_min=tg.y_min,  # type: ignore[arg-type]
        x_max=tg.x_max,  # type: ignore[arg-type]
        y_max=tg.y_max,  # type: ignore[arg-type]
      )
    elif tg.type == "interval":
      if tg.x_min is None or tg.x_max is None:
        continue
      params = IntervalGateCreate(
        type="interval",
        x_min=tg.x_min,
        x_max=tg.x_max,
      )
    elif tg.type == "polygon":
      if not tg.vertices or len(tg.vertices) < 3:
        continue
      params = PolygonGateCreate(type="polygon", vertices=tg.vertices)
    else:
      continue  # unknown type

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
