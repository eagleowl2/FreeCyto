"""Gate storage and evaluation. All gate coordinates are in TRANSFORMED space
(same units as plot axes). Evaluation applies the stored transform to events
and tests against these coordinates.

Gates are stored in memory only (temporary, not persistent). They are cleared
when the backend process exits or when the file is evicted from the file cache."""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from collections.abc import Iterator
from typing import Any
import numpy as np

from models.gate_models import BooleanGateCreate, ChannelStats, EllipseGateCreate, GateCreateRequest, GateResponse, GateStatsResponse, GateUpdateRequest, IntervalGateCreate, PolygonGateCreate, RectangleGateCreate
from services import storage, transforms as transform_service


# ---------------------------------------------------------------------------
# Boolean expression parser
# ---------------------------------------------------------------------------

_BOOL_KEYWORDS = frozenset({"AND", "OR", "NOT"})


def _tokenize_bool(expr: str) -> list[str]:
  """Tokenize a boolean expression into keywords, parentheses, and gate names.

  Gate names may be backtick-quoted (`` `CD4+` ``) to allow special characters.
  Unquoted tokens that are not AND/OR/NOT/(/) are treated as gate names.
  """
  tokens: list[str] = []
  i = 0
  while i < len(expr):
    if expr[i].isspace():
      i += 1
    elif expr[i] == "(":
      tokens.append("(")
      i += 1
    elif expr[i] == ")":
      tokens.append(")")
      i += 1
    elif expr[i] == "`":
      # Backtick-quoted gate name
      j = expr.find("`", i + 1)
      if j == -1:
        raise ValueError(f"Unclosed backtick in expression near position {i}")
      tokens.append(expr[i + 1 : j])
      i = j + 1
    else:
      m = re.match(r"[^\s()`]+", expr[i:])
      word = m.group() if m else expr[i]
      tokens.append(word)
      i += len(word)
  return tokens


class _BoolParser:
  """Recursive descent parser for boolean gate expressions.

  Grammar (in order of increasing precedence)::

      expr     := or_expr
      or_expr  := and_expr ('OR' and_expr)*
      and_expr := not_expr ('AND' not_expr)*
      not_expr := 'NOT' not_expr | atom
      atom     := '(' expr ')' | GATE_NAME
  """

  def __init__(self, tokens: list[str]) -> None:
    self._tokens = tokens
    self._pos = 0

  def _peek(self) -> str | None:
    return self._tokens[self._pos] if self._pos < len(self._tokens) else None

  def _consume(self) -> str:
    tok = self._tokens[self._pos]
    self._pos += 1
    return tok

  def parse(self) -> Any:
    node = self._or_expr()
    if self._pos < len(self._tokens):
      raise ValueError(f"Unexpected token in boolean expression: {self._tokens[self._pos]!r}")
    return node

  def _or_expr(self) -> Any:
    left = self._and_expr()
    while self._peek() == "OR":
      self._consume()
      right = self._and_expr()
      left = ("OR", left, right)
    return left

  def _and_expr(self) -> Any:
    left = self._not_expr()
    while self._peek() == "AND":
      self._consume()
      right = self._not_expr()
      left = ("AND", left, right)
    return left

  def _not_expr(self) -> Any:
    if self._peek() == "NOT":
      self._consume()
      operand = self._not_expr()
      return ("NOT", operand)
    return self._atom()

  def _atom(self) -> Any:
    tok = self._peek()
    if tok == "(":
      self._consume()
      node = self._or_expr()
      if self._peek() != ")":
        raise ValueError("Expected ')' in boolean expression")
      self._consume()
      return node
    if tok is None or tok in _BOOL_KEYWORDS or tok in ("(", ")"):
      raise ValueError(f"Expected gate name, got {tok!r}")
    self._consume()
    return ("GATE", tok)


def _parse_bool_expr(expression: str) -> Any:
  """Parse *expression* into an AST. Raises ValueError on syntax errors."""
  tokens = _tokenize_bool(expression)
  if not tokens:
    raise ValueError("Empty boolean expression")
  return _BoolParser(tokens).parse()


def _collect_gate_names(ast: Any) -> list[str]:
  """Return all gate names referenced in *ast* (may contain duplicates)."""
  op = ast[0]
  if op == "GATE":
    return [ast[1]]
  if op == "NOT":
    return _collect_gate_names(ast[1])
  return _collect_gate_names(ast[1]) + _collect_gate_names(ast[2])


def _eval_bool_ast(ast: Any, masks: dict[str, np.ndarray]) -> np.ndarray:
  """Evaluate a parsed boolean AST against a mapping of gate-name → mask array."""
  op = ast[0]
  if op == "GATE":
    name = ast[1]
    if name not in masks:
      raise ValueError(f"Gate {name!r} not found in file for boolean evaluation")
    return masks[name].copy()
  if op == "NOT":
    return ~_eval_bool_ast(ast[1], masks)
  if op == "AND":
    return _eval_bool_ast(ast[1], masks) & _eval_bool_ast(ast[2], masks)
  if op == "OR":
    return _eval_bool_ast(ast[1], masks) | _eval_bool_ast(ast[2], masks)
  raise ValueError(f"Unknown AST operator: {op!r}")

# Default logicle parameter values; also used as "not-yet-set" sentinels in auto-derivation.
_DEFAULT_LOGICLE_T = 262144.0
_DEFAULT_LOGICLE_W = 0.5

SUSPENDED_FILE_TTL_SECONDS = 60 * 60


class GateNameExistsError(ValueError):
  """Raised when creating a gate with a name that already exists for the file."""

  def __init__(self, name: str, file_id: str) -> None:
    self.name = name
    self.file_id = file_id
    super().__init__(f"Gate name {name!r} already exists for this file")


def _point_in_rect(x: np.ndarray, y: np.ndarray, x_min: float, y_min: float, x_max: float, y_max: float) -> np.ndarray:
  return (
    (x >= x_min) & (x <= x_max) &
    (y >= y_min) & (y <= y_max)
  )


def _point_in_ellipse(
  x: np.ndarray,
  y: np.ndarray,
  cx: float,
  cy: float,
  rx: float,
  ry: float,
  angle_deg: float = 0.0,
) -> np.ndarray:
  """Test whether each (x[i], y[i]) lies inside the ellipse.

  The ellipse has centre (cx, cy), semi-axes rx (along X) and ry (along Y),
  and is rotated CCW by *angle_deg* degrees.  Boundary points are included.

  Formula: transform point into the ellipse's own frame (rotate CW by angle)
  then test the standard axis-aligned ellipse equation.
  """
  if rx <= 0.0 or ry <= 0.0:
    return np.zeros(x.shape[0], dtype=bool)
  a = np.radians(angle_deg)
  cos_a = np.cos(a)
  sin_a = np.sin(a)
  dx = x - cx
  dy = y - cy
  # Rotate into ellipse-aligned frame (CW = inverse of CCW rotation)
  xr =  cos_a * dx + sin_a * dy
  yr = -sin_a * dx + cos_a * dy
  return (xr / rx) ** 2 + (yr / ry) ** 2 <= 1.0


def _point_in_polygon(x: np.ndarray, y: np.ndarray, vertices: list[list[float]]) -> np.ndarray:
  """Winding-number test. Boundary = inside (GatingML 2.0). No epsilon hack."""
  n = len(vertices)
  if n < 3:
    return np.zeros(x.shape[0], dtype=bool)
  vx = np.array([v[0] for v in vertices] + [vertices[0][0]], dtype=float)
  vy = np.array([v[1] for v in vertices] + [vertices[0][1]], dtype=float)
  winding = np.zeros(x.shape[0], dtype=np.int32)
  on_boundary = np.zeros(x.shape[0], dtype=bool)
  for i in range(n):
    # Upward crossing: vy[i] <= y < vy[i+1]
    up = (vy[i] <= y) & (y < vy[i + 1])
    # Downward crossing: vy[i] > y >= vy[i+1]
    dn = (vy[i] > y) & (y >= vy[i + 1])
    denom = vy[i + 1] - vy[i]
    mask = denom != 0
    cross = np.where(mask, vx[i] + (vx[i + 1] - vx[i]) * (y - vy[i]) / denom, np.nan)
    winding[up & mask & (x < cross)] += 1
    winding[dn & mask & (x < cross)] -= 1
    # Point on segment (any edge): boundary = inside. Tolerance for float.
    dx = vx[i + 1] - vx[i]
    dy = vy[i + 1] - vy[i]
    L2 = dx * dx + dy * dy
    if L2 > 0:
      t = ((x - vx[i]) * dx + (y - vy[i]) * dy) / L2
      dist2 = (x - (vx[i] + t * dx)) ** 2 + (y - (vy[i] + t * dy)) ** 2
      # Segment-relative tolerance so boundary hits are reachable in float64 (GATE-8).
      boundary_eps = max(1e-12, 1e-10 * L2)
      on_boundary |= (t >= 0) & (t <= 1) & (dist2 < boundary_eps)
  return (winding != 0) | on_boundary


@dataclass
class GateRecord:
  id: str
  file_id: str
  name: str
  type: str
  x_channel: str
  y_channel: str
  parent_gate_id: str | None = None
  order: int = 0
  depth: int = 0
  transform_x: str = "linear"
  transform_y: str = "linear"
  arcsinh_cofactor: float = 150.0
  logicle_T: float = 262144.0
  logicle_W: float = 0.5
  logicle_M: float = 4.5
  logicle_A: float = 0.0
  x_min: float | None = None
  y_min: float | None = None
  x_max: float | None = None
  y_max: float | None = None
  vertices: list[list[float]] | None = None
  expression: str | None = None  # L: boolean gate expression
  # N: ellipse gate geometry (all in transformed space)
  center_x: float | None = None
  center_y: float | None = None
  radius_x: float | None = None
  radius_y: float | None = None
  angle: float = 0.0
  _cached_count: int | None = field(default=None, repr=False)
  _cached_pct_total: float | None = field(default=None, repr=False)
  _cached_pct_of_parent: float | None = field(default=None, repr=False)
  _cached_parent_count: int | None = field(default=None, repr=False)
  _cached_mask: np.ndarray | None = field(default=None, repr=False)
  _cache_valid: bool = field(default=False, repr=False)


class GateStore:
  """In-memory gate index (single process). Use :func:`reset_gate_store` in tests."""

  def __init__(self) -> None:
    self.gates_by_id: dict[str, GateRecord] = {}
    # Sibling order is defined by list position in these mappings; GateRecord.order is
    # kept in sync for serialisation/workspace only. Any future reorder operation must
    # update both the lists and the per-record order field.
    self.root_children: dict[str, list[str]] = {}  # file_id -> root-level gate IDs (ordered)
    self.gate_children: dict[str, list[str]] = {}  # gate_id -> child gate IDs (ordered)
    # file_ids evicted by LRU but not explicitly deleted — gate defs kept until reload
    self.suspended_files: set[str] = set()
    self.suspended_at: dict[str, float] = {}

  def reset(self) -> None:
    self.gates_by_id.clear()
    self.root_children.clear()
    self.gate_children.clear()
    self.suspended_files.clear()
    self.suspended_at.clear()


_store = GateStore()


def reset_gate_store() -> None:
  """Clear all gates (pytest autouse fixture, manual teardown)."""
  _store.reset()


def _on_file_evicted(file_id: str, hard_delete: bool = False) -> None:
  """React to a file leaving the storage LRU cache.

  LRU eviction: suspend (keep gate definitions). Explicit :meth:`storage.delete_file`:
  remove all gates for that file.
  """
  if hard_delete:
    _store.suspended_files.discard(file_id)
    _store.suspended_at.pop(file_id, None)
    for gid in list(_store.root_children.pop(file_id, [])):
      _evict_gate_subtree(gid)
    _store.root_children.pop(file_id, None)
  else:
    # Soft eviction (LRU): keep definitions but mark file unavailable and drop cached masks/stats.
    # When the same file id is loaded again, resume_gates_for_file() re-enables and re-evaluates.
    _store.suspended_files.add(file_id)
    _store.suspended_at[file_id] = time.time()
    invalidate_file_caches(file_id)


def resume_gates_for_file(file_id: str) -> None:
  """After the same ``file_id`` is registered again, drop suspension and refresh masks."""
  if file_id in _store.suspended_files:
    _store.suspended_files.discard(file_id)
    _store.suspended_at.pop(file_id, None)
    invalidate_file_caches(file_id)


def _cleanup_expired_suspended_files(now: float | None = None) -> None:
  ts = time.time() if now is None else now
  expired = [
    file_id for file_id in list(_store.suspended_files)
    if ts - _store.suspended_at.get(file_id, ts) >= SUSPENDED_FILE_TTL_SECONDS
  ]
  for file_id in expired:
    _store.suspended_files.discard(file_id)
    _store.suspended_at.pop(file_id, None)
    for gid in list(_store.root_children.pop(file_id, [])):
      _evict_gate_subtree(gid)
    _store.root_children.pop(file_id, None)


def _evict_gate_subtree(gate_id: str) -> None:
  """Remove gate and all descendants from _store.gates_by_id and _store.gate_children."""
  for cid in _store.gate_children.pop(gate_id, []):
    _evict_gate_subtree(cid)
  _store.gates_by_id.pop(gate_id, None)


def _get_ancestor_list(record: GateRecord) -> list[str]:
  """Return list of ancestor gate IDs from root to parent (for depth)."""
  if record.parent_gate_id is None:
    return []
  parent = _store.gates_by_id.get(record.parent_gate_id)
  if not parent or parent.file_id != record.file_id:
    return []
  return _get_ancestor_list(parent) + [record.parent_gate_id]


def get_descendants(gate_id: str) -> list[str]:
  """Return all descendant gate IDs (children, grandchildren, ...)."""
  out: list[str] = []
  for cid in _store.gate_children.get(gate_id, []):
    out.append(cid)
    out.extend(get_descendants(cid))
  return out


def topological_order(file_id: str) -> list[str]:
  """Return gate IDs in topological order (parent before child), sibling order by order field."""
  root_ids = _store.root_children.get(file_id, [])
  ordered: list[str] = []

  def walk(gids: list[str]) -> None:
    for gid in gids:
      rec = _store.gates_by_id.get(gid)
      if rec is None or rec.file_id != file_id:
        continue
      ordered.append(gid)
      walk(_store.gate_children.get(gid, []))

  walk(root_ids)
  return ordered


# Clear gates when a file is evicted from the store
storage.register_evict_callback(_on_file_evicted)


def _channel_name_to_index(file_id: str, channel_name: str) -> int:
  metadata = storage.get_file_metadata(file_id)
  for ch in metadata.channels:
    if ch.name == channel_name:
      return ch.index - 1
  raise ValueError(f"Channel {channel_name!r} not found in file {file_id}")


def _get_channel_values(file_id: str, channel_name: str, events: np.ndarray) -> np.ndarray:
  """Return a 1-D float64 array for *channel_name*, which may be a derived parameter."""
  from services import derived_params as dp_service  # lazy to avoid circular import
  if dp_service.is_derived_param(file_id, channel_name):
    return dp_service.get_derived_param_values(file_id, channel_name)
  idx = _channel_name_to_index(file_id, channel_name)
  return events[:, idx].astype(np.float64)


def _transform_kwargs(record: GateRecord) -> dict:
  """Kwargs for apply_transform (arcsinh_cofactor, logicle_*)."""
  kwargs: dict = {"arcsinh_cofactor": record.arcsinh_cofactor}
  if record.transform_x == "logicle" or record.transform_y == "logicle":
    kwargs["logicle_t"] = record.logicle_T
    kwargs["logicle_w"] = record.logicle_W
    kwargs["logicle_m"] = record.logicle_M
    kwargs["logicle_a"] = record.logicle_A
  return kwargs


def _get_mask(record: GateRecord, _visited: frozenset[str] | None = None) -> np.ndarray:
  """Resolve parent mask, transform channels, test geometry on parent subset, project to full index; cache.

  Uses a visited-set to defend against accidental parent cycles; a cycle raises ValueError.

  Memory (GATE-2): each gate caches a full-length boolean ``_cached_mask`` (~1 byte/event) until
  invalidation (compensation change, delete, etc.); there is no LRU or memory-pressure eviction.
  """
  if record._cache_valid and record._cached_mask is not None:
    return record._cached_mask

  visited = (_visited or frozenset()) | {record.id}
  events = storage.get_file_events(record.file_id)
  n_total = events.shape[0]
  expected = storage.get_file_metadata(record.file_id).event_count
  assert events.shape[0] == expected, (
    f"Gate evaluation must use full events: got {events.shape[0]}, file has {expected}"
  )
  if n_total == 0:
    record._cached_mask = np.zeros(0, dtype=bool)
    record._cache_valid = True
    return record._cached_mask

  parent_mask: np.ndarray | None = None
  if record.parent_gate_id is not None:
    if record.parent_gate_id in visited:
      raise ValueError("Gate hierarchy cycle detected while evaluating masks")
    parent = _store.gates_by_id.get(record.parent_gate_id)
    if parent and parent.file_id == record.file_id:
      parent_mask = _get_mask(parent, visited)

  # Boolean gates don't use channel data directly — skip channel lookup for them.
  kwargs = _transform_kwargs(record)
  if record.type != "boolean":
    x = transform_service.apply_transform(
      _get_channel_values(record.file_id, record.x_channel, events), record.transform_x, **kwargs
    )

  if record.type == "interval":
    # 1-D gate: only x_channel is needed; y_channel is empty string for interval gates.
    if record.x_min is None or record.x_max is None:
      gate_mask = np.zeros(n_total, dtype=bool)
    else:
      gate_mask = (x >= record.x_min) & (x <= record.x_max)
  elif record.type == "boolean":
    # L: Boolean combination of other gates in the same file.
    if not record.expression:
      gate_mask = np.zeros(n_total, dtype=bool)
    else:
      ast = _parse_bool_expr(record.expression)
      referenced_names = _collect_gate_names(ast)
      # Build name→mask for all referenced gates, passing visited for cycle detection.
      name_masks: dict[str, np.ndarray] = {}
      for gid in topological_order(record.file_id):
        ref = _store.gates_by_id.get(gid)
        if ref is None or ref.name not in referenced_names:
          continue
        if ref.id in visited:
          raise ValueError(
            f"Boolean gate cycle detected: gate {record.name!r} references {ref.name!r}"
          )
        name_masks[ref.name] = _get_mask(ref, visited)
      gate_mask = _eval_bool_ast(ast, name_masks)
  else:
    # 2-D gates (rectangle, polygon): also need y channel.
    y = transform_service.apply_transform(
      _get_channel_values(record.file_id, record.y_channel, events), record.transform_y, **kwargs
    )
    if record.type == "rectangle":
      if (
        record.x_min is None or record.y_min is None
        or record.x_max is None or record.y_max is None
      ):
        gate_mask = np.zeros(n_total, dtype=bool)
      else:
        gate_mask = _point_in_rect(
          x, y,
          record.x_min, record.y_min,
          record.x_max, record.y_max,
        )
    elif record.type == "polygon" and record.vertices:
      gate_mask = _point_in_polygon(x, y, record.vertices)
    elif record.type == "ellipse":
      if (
        record.center_x is not None and record.center_y is not None
        and record.radius_x is not None and record.radius_y is not None
      ):
        gate_mask = _point_in_ellipse(
          x, y,
          record.center_x, record.center_y,
          record.radius_x, record.radius_y,
          record.angle,
        )
      else:
        gate_mask = np.zeros(n_total, dtype=bool)
    else:
      gate_mask = np.zeros(n_total, dtype=bool)

  if parent_mask is not None:
    gate_mask = gate_mask & parent_mask

  record._cached_mask = gate_mask
  record._cache_valid = True
  return gate_mask


def _compute_stats(record: GateRecord) -> None:
  """Set count, pct_of_parent, pct_of_total, parent_count from masks; invalidates then fills cache."""
  gate_mask = _get_mask(record)
  n_total = gate_mask.shape[0]
  count = int(np.sum(gate_mask))
  parent_count = n_total
  if record.parent_gate_id is not None:
    parent = _store.gates_by_id.get(record.parent_gate_id)
    if parent and parent.file_id == record.file_id and parent._cached_count is not None:
      parent_count = parent._cached_count
  pct_of_total = 100.0 * count / n_total if n_total else 0.0
  pct_of_parent = 100.0 * count / parent_count if parent_count else 100.0
  record._cached_count = count
  record._cached_pct_total = pct_of_total
  record._cached_pct_of_parent = pct_of_parent
  record._cached_parent_count = parent_count
  record._cache_valid = True


def invalidate_subtree(gate_id: str) -> None:
  """Invalidate mask and stats cache for this gate and all descendants."""
  rec = _store.gates_by_id.get(gate_id)
  if rec is not None:
    rec._cache_valid = False
    rec._cached_mask = None
    rec._cached_count = None
    rec._cached_pct_total = None
    rec._cached_pct_of_parent = None
    rec._cached_parent_count = None
  for cid in _store.gate_children.get(gate_id, []):
    invalidate_subtree(cid)


def _sibling_list(body: GateCreateRequest) -> list[str]:
  """Return a copy of sibling gate IDs (root-level or parent's children) for body."""
  if body.parent_gate_id is None:
    return list(_store.root_children.get(body.file_id, []))
  return list(_store.gate_children.get(body.parent_gate_id, []))

def _all_gate_ids_for_file(file_id: str) -> list[str]:
  """All gate IDs for a file (for name uniqueness)."""
  return topological_order(file_id)


def create_gate(body: GateCreateRequest) -> GateResponse:
  """Create a gate, evaluate it, store and return. Params validated by Pydantic (422 if invalid)."""
  _cleanup_expired_suspended_files()
  storage.get_file_metadata(body.file_id)
  existing_names = set()
  for gid in _all_gate_ids_for_file(body.file_id):
    rec = _store.gates_by_id.get(gid)
    if rec is not None:
      existing_names.add(rec.name)
  if body.name in existing_names:
    raise GateNameExistsError(body.name, body.file_id)

  parent: GateRecord | None = None
  if body.parent_gate_id is not None:
    parent = _store.gates_by_id.get(body.parent_gate_id)
    if parent is None:
      raise ValueError(f"Parent gate {body.parent_gate_id!r} not found")
    if parent.file_id != body.file_id:
      raise ValueError("Parent gate belongs to a different file")
    depth = len(_get_ancestor_list(parent)) + 1
  else:
    depth = 0
  if depth >= 50:
    raise ValueError("Gate hierarchy depth would exceed 50")

  gate_id = str(uuid.uuid4())
  p = body.params
  parent_gate_id = body.parent_gate_id
  sibling_ids = _sibling_list(body)
  # Default (-1) appends at end; otherwise clamp to range
  if body.order < 0 or body.order > len(sibling_ids):
    order = len(sibling_ids)
  else:
    order = body.order

  # Auto-derive logicle T from $PnR (and W from negative data) when the caller
  # left logicle_T at its default sentinel value (262144.0). This ensures the
  # stored gate uses the channel's actual detector range as the scale ceiling,
  # which matches FlowJo / GatingML logicle parameterisation.
  eff_logicle_T = body.logicle_T
  eff_logicle_W = body.logicle_W
  if (body.transform_x == "logicle" or body.transform_y == "logicle") and body.logicle_T == _DEFAULT_LOGICLE_T:
    _meta = storage.get_file_metadata(body.file_id)
    _ch_map = {ch.name: ch for ch in _meta.channels}
    # Primary channel: prefer whichever axis is logicle (x takes precedence over y)
    _pnr_ch_name = body.x_channel if body.transform_x == "logicle" else body.y_channel
    _pnr_ch = _ch_map.get(_pnr_ch_name)
    if _pnr_ch is not None and _pnr_ch.range is not None:
      eff_logicle_T = float(_pnr_ch.range)
      # Also auto-derive W from negative-value distribution when W is at default.
      if body.logicle_W == _DEFAULT_LOGICLE_W:
        _events_for_w = storage.get_file_events(body.file_id)
        _xi = _pnr_ch.index - 1
        if 0 <= _xi < _events_for_w.shape[1]:
          _params = transform_service.estimate_logicle_params(
            _events_for_w[:, _xi], instrument_range=_pnr_ch.range
          )
          eff_logicle_W = _params["W"]

  _common = dict(
    id=gate_id, file_id=body.file_id, name=body.name,
    x_channel=body.x_channel, y_channel=body.y_channel,
    parent_gate_id=parent_gate_id, order=order, depth=depth,
    transform_x=body.transform_x, transform_y=body.transform_y,
    arcsinh_cofactor=body.arcsinh_cofactor,
    logicle_T=eff_logicle_T, logicle_W=eff_logicle_W,
    logicle_M=body.logicle_M, logicle_A=body.logicle_A,
  )
  if p.type == "rectangle":
    record = GateRecord(**_common, type="rectangle",
      x_min=p.x_min, y_min=p.y_min, x_max=p.x_max, y_max=p.y_max)
  elif p.type == "interval":
    record = GateRecord(**_common, type="interval",
      x_min=p.x_min, x_max=p.x_max,
      y_min=None, y_max=None)
  elif p.type == "boolean":
    # Validate expression parses before committing
    _parse_bool_expr(p.expression)
    record = GateRecord(**_common, type="boolean", expression=p.expression)
  elif p.type == "ellipse":
    record = GateRecord(
      **_common, type="ellipse",
      center_x=p.center_x, center_y=p.center_y,
      radius_x=p.radius_x, radius_y=p.radius_y,
      angle=p.angle,
    )
  else:
    record = GateRecord(**_common, type="polygon", vertices=p.vertices)

  _store.gates_by_id[gate_id] = record
  # Insert new gate ID into sibling list and renumber orders
  sibling_ids.insert(order, gate_id)
  if parent_gate_id is None:
    _store.root_children[body.file_id] = sibling_ids
  else:
    _store.gate_children[parent_gate_id] = sibling_ids
  for i, gid in enumerate(sibling_ids):
    r = _store.gates_by_id.get(gid)
    if r is not None:
      r.order = i
  try:
    if parent is not None:
      _compute_stats(parent)
    _compute_stats(record)
  except Exception:
    _store.gates_by_id.pop(gate_id, None)
    sibling_ids.remove(gate_id)
    if parent_gate_id is None:
      _store.root_children[body.file_id] = sibling_ids
    else:
      _store.gate_children[parent_gate_id] = sibling_ids
    for i, gid in enumerate(sibling_ids):
      r = _store.gates_by_id.get(gid)
      if r is not None:
        r.order = i
    raise
  return _record_to_response(record)


def _record_to_response(record: GateRecord) -> GateResponse:
  """Build response from record; cache must already be filled (e.g. via _compute_stats)."""
  count = record._cached_count if record._cached_count is not None else 0
  pct_total = record._cached_pct_total if record._cached_pct_total is not None else 0.0
  pct_of_parent = (
    record._cached_pct_of_parent if record._cached_pct_of_parent is not None else 0.0
  )
  parent_count = (
    record._cached_parent_count if record._cached_parent_count is not None else 0
  )
  return GateResponse(
    id=record.id,
    file_id=record.file_id,
    name=record.name,
    type=record.type,
    x_channel=record.x_channel,
    y_channel=record.y_channel,
    parent_gate_id=record.parent_gate_id,
    depth=record.depth,
    order=record.order,
    transform_x=record.transform_x,
    transform_y=record.transform_y,
    arcsinh_cofactor=record.arcsinh_cofactor,
    logicle_T=record.logicle_T,
    logicle_W=record.logicle_W,
    logicle_M=record.logicle_M,
    logicle_A=record.logicle_A,
    x_min=record.x_min,
    y_min=record.y_min,
    x_max=record.x_max,
    y_max=record.y_max,
    vertices=record.vertices,
    expression=record.expression,
    center_x=record.center_x,
    center_y=record.center_y,
    radius_x=record.radius_x,
    radius_y=record.radius_y,
    angle=record.angle,
    count=count,
    pct_total=round(pct_total, 2),
    pct_of_parent=round(pct_of_parent, 2),
    pct_of_total=round(pct_total, 2),
    parent_count=parent_count,
    children=[],
  )


def invalidate_file_caches(file_id: str) -> None:
  """Invalidate gate caches for a file (e.g. after compensation change)."""
  for gid in topological_order(file_id):
    record = _store.gates_by_id.get(gid)
    if record is not None:
      record._cache_valid = False
      record._cached_mask = None
      record._cached_count = None
      record._cached_pct_total = None
      record._cached_pct_of_parent = None
      record._cached_parent_count = None


def get_gate_defs(file_id: str) -> list[GateRecord]:
  """Return gate records in tree order without evaluating masks or stats (e.g. workspace save)."""
  _cleanup_expired_suspended_files()
  storage.get_file_metadata(file_id)
  ordered = topological_order(file_id)
  out: list[GateRecord] = []
  for gid in ordered:
    rec = _store.gates_by_id.get(gid)
    if rec is not None:
      out.append(rec)
  return out


def list_gates(file_id: str) -> list[GateResponse]:
  """List all gates for a file with current counts. Uses cache when valid."""
  _cleanup_expired_suspended_files()
  # Guard: storage.get_file_metadata raises KeyError (→ 404 at router) if the file is not loaded.
  storage.get_file_metadata(file_id)
  ordered = topological_order(file_id)
  out: list[GateResponse] = []
  for gid in ordered:
    record = _store.gates_by_id.get(gid)
    if record is None:
      continue
    _compute_stats(record)
    out.append(_record_to_response(record))
  return out


def delete_gate(gate_id: str) -> list[str]:
  """Remove a gate and all descendants; remove from parent's child list. Returns list of deleted gate IDs."""
  record = _store.gates_by_id.get(gate_id)
  if record is None:
    return []
  file_id = record.file_id
  parent_id = record.parent_gate_id
  deleted_ids = [gate_id] + get_descendants(gate_id)
  if parent_id is not None:
    lst = _store.gate_children.get(parent_id, [])
    _store.gate_children[parent_id] = [g for g in lst if g != gate_id]
  else:
    lst = _store.root_children.get(file_id, [])
    _store.root_children[file_id] = [g for g in lst if g != gate_id]
  _evict_gate_subtree(gate_id)
  return deleted_ids


def update_gate(gate_id: str, body: GateUpdateRequest) -> GateResponse:
  """Update gate geometry in-place; invalidates mask/stats for the gate and all descendants.
  If body.name is provided the gate is also renamed (uniqueness enforced within the file).
  Name changes do not affect gate geometry or cached masks."""
  record = _store.gates_by_id.get(gate_id)
  if record is None:
    raise KeyError(f"Gate {gate_id!r} not found")
  if record.file_id in _store.suspended_files:
    raise KeyError(f"File for gate {gate_id!r} is not currently loaded")
  # O: gate rename — apply before geometry changes so errors surface early.
  if body.name is not None:
    new_name = body.name.strip()
    if not new_name:
      raise ValueError("Gate name must not be empty or blank")
    if new_name != record.name:
      for gid in _all_gate_ids_for_file(record.file_id):
        r = _store.gates_by_id.get(gid)
        if r is not None and r.id != gate_id and r.name == new_name:
          raise GateNameExistsError(new_name, record.file_id)
      record.name = new_name
      # Name change does not affect geometry or mask — no cache invalidation needed.
  if record.type == "rectangle":
    if body.x_min is not None:
      record.x_min = body.x_min
    if body.y_min is not None:
      record.y_min = body.y_min
    if body.x_max is not None:
      record.x_max = body.x_max
    if body.y_max is not None:
      record.y_max = body.y_max
  elif record.type == "polygon":
    if body.vertices is not None:
      if len(body.vertices) < 3:
        raise ValueError("Polygon gate must have at least 3 vertices")
      record.vertices = body.vertices
  elif record.type == "interval":
    if body.x_min is not None:
      record.x_min = body.x_min
    if body.x_max is not None:
      record.x_max = body.x_max
  elif record.type == "ellipse":
    if body.center_x is not None:
      record.center_x = body.center_x
    if body.center_y is not None:
      record.center_y = body.center_y
    if body.radius_x is not None:
      if body.radius_x <= 0:
        raise ValueError("radius_x must be > 0")
      record.radius_x = body.radius_x
    if body.radius_y is not None:
      if body.radius_y <= 0:
        raise ValueError("radius_y must be > 0")
      record.radius_y = body.radius_y
    if body.angle is not None:
      record.angle = body.angle
  else:
    raise ValueError(f"Unsupported gate type for update: {record.type!r}")
  invalidate_subtree(gate_id)
  _compute_stats(record)
  return _record_to_response(record)


def get_gate_tree(file_id: str) -> list[GateResponse]:
  """Return nested gate tree for a file.

  First call after cache invalidation evaluates stats for all N nodes
  (O(n) mask evaluations via _get_mask/_compute_stats). Subsequent calls
  reuse cached masks/stats and are O(n) cheap reads. Cache is invalidated
  by create_gate, delete_gate, and invalidate_file_caches.
  """
  _cleanup_expired_suspended_files()
  storage.get_file_metadata(file_id)
  root_ids = _store.root_children.get(file_id, [])

  def build_node(gid: str) -> GateResponse | None:
    record = _store.gates_by_id.get(gid)
    if record is None or record.file_id != file_id:
      return None
    _compute_stats(record)
    child_responses: list[GateResponse] = []
    for cid in _store.gate_children.get(gid, []):
      child_node = build_node(cid)
      if child_node is not None:
        child_responses.append(child_node)
    base = _record_to_response(record)
    return base.model_copy(update={"children": child_responses})

  out: list[GateResponse] = []
  for gid in root_ids:
    node = build_node(gid)
    if node is not None:
      out.append(node)
  return out


def get_gate_events(
  gate_id: str,
  max_events: int = 50_000,
  x_channel: str | None = None,
  y_channel: str | None = None,
  transform_x: str | None = None,
  transform_y: str | None = None,
  arcsinh_cofactor: float = 150.0,
  logicle_t: float | None = None,
  logicle_w: float | None = None,
  logicle_m: float | None = None,
  logicle_a: float | None = None,
) -> tuple[str, list[str], list[list[float]]]:
  """Return downsampled events inside the gate population. Returns (file_id, channel_names, events rows)."""
  _cleanup_expired_suspended_files()
  record = _store.gates_by_id.get(gate_id)
  if record is None:
    raise KeyError(f"Gate {gate_id!r} not found")
  file_id = record.file_id
  storage.get_file_metadata(file_id)
  mask = _get_mask(record)
  events = storage.get_file_events(file_id)
  subset = events[mask]
  n = subset.shape[0]
  if n > max_events:
    row_indices = np.random.choice(n, size=max_events, replace=False)
    subset = subset[row_indices]
  if x_channel is None and y_channel is None:
    channel_names = [ch.name for ch in storage.get_file_metadata(file_id).channels]
    events_list = subset.astype(np.float64).tolist()
    return (file_id, channel_names, events_list)
  metadata = storage.get_file_metadata(file_id)
  ch_by_name = {ch.name: (ch.index - 1) for ch in metadata.channels}
  wanted = [x_channel, y_channel] if (x_channel and y_channel) else [c for c in (x_channel, y_channel) if c]
  col_indices = [ch_by_name[n] for n in wanted if n in ch_by_name]
  names = [n for n in wanted if n in ch_by_name]
  if not col_indices:
    raise ValueError("Requested channel(s) not found")
  sub = subset[:, col_indices].astype(np.float64)
  tx = transform_x if transform_x and transform_x in transform_service.TRANSFORMS else record.transform_x
  ty = transform_y if transform_y and transform_y in transform_service.TRANSFORMS else record.transform_y
  kwargs: dict = {"arcsinh_cofactor": arcsinh_cofactor}
  if tx == "logicle" or ty == "logicle":
    kwargs["logicle_t"] = logicle_t if logicle_t is not None else record.logicle_T
    kwargs["logicle_w"] = logicle_w if logicle_w is not None else record.logicle_W
    kwargs["logicle_m"] = logicle_m if logicle_m is not None else record.logicle_M
    kwargs["logicle_a"] = logicle_a if logicle_a is not None else record.logicle_A
  if sub.shape[1] >= 1:
    sub[:, 0] = transform_service.apply_transform(sub[:, 0], tx, **kwargs)
  if sub.shape[1] >= 2:
    sub[:, 1] = transform_service.apply_transform(sub[:, 1], ty, **kwargs)
  return (file_id, names, sub.tolist())


def get_gate_density(
  gate_id: str,
  bins_x: int = 200,
  bins_y: int = 200,
  max_events: int = 200_000,
  x_channel: str | None = None,
  y_channel: str | None = None,
  transform_x: str | None = None,
  transform_y: str | None = None,
  arcsinh_cofactor: float | None = None,
  logicle_t: float | None = None,
  logicle_w: float | None = None,
  logicle_m: float | None = None,
  logicle_a: float | None = None,
) -> tuple[str, str, str, str | None, str | None, float, float, float, float, int, int, list[list[float]]]:
  """Return a 2D density histogram for events inside a gate population.

  The histogram is computed in transformed space so that overlays and axes
  align with the gate's stored transform settings.
  """
  _cleanup_expired_suspended_files()
  record = _store.gates_by_id.get(gate_id)
  if record is None:
    raise KeyError(f"Gate {gate_id!r} not found")

  file_id = record.file_id
  storage.get_file_metadata(file_id)

  # Determine effective channels and transforms (fallback to gate defaults).
  x_name = x_channel or record.x_channel
  y_name = y_channel or record.y_channel
  tx = transform_x if transform_x and transform_x in transform_service.TRANSFORMS else record.transform_x
  ty = transform_y if transform_y and transform_y in transform_service.TRANSFORMS else record.transform_y

  # Apply gate mask first to restrict to the population.
  mask = _get_mask(record)
  events = storage.get_file_events(file_id)
  events = events[mask]
  if events.size == 0:
    # Degenerate population: return an empty histogram with a minimal range.
    x_min = y_min = -1.0
    x_max = y_max = 1.0
    counts = np.zeros((bins_y, bins_x), dtype=float)
    return (
      file_id,
      x_name,
      y_name,
      tx,
      ty,
      x_min,
      x_max,
      y_min,
      y_max,
      bins_x,
      bins_y,
      counts.tolist(),
    )

  # Downsample within the gate population if needed.
  n_events = events.shape[0]
  if n_events > max_events:
    row_indices = np.sort(np.random.choice(n_events, size=max_events, replace=False))
    events = events[row_indices]

  xi = _channel_name_to_index(file_id, x_name)
  yi = _channel_name_to_index(file_id, y_name)

  # Use gate's transform parameters unless overrides are provided.
  eff_arcsinh = arcsinh_cofactor if arcsinh_cofactor is not None else record.arcsinh_cofactor
  kwargs: dict = {"arcsinh_cofactor": eff_arcsinh}
  if tx == "logicle" or ty == "logicle":
    kwargs["logicle_t"] = logicle_t if logicle_t is not None else record.logicle_T
    kwargs["logicle_w"] = logicle_w if logicle_w is not None else record.logicle_W
    kwargs["logicle_m"] = logicle_m if logicle_m is not None else record.logicle_M
    kwargs["logicle_a"] = logicle_a if logicle_a is not None else record.logicle_A

  x = events[:, xi].astype(float)
  y = events[:, yi].astype(float)

  if tx in transform_service.TRANSFORMS:
    x = transform_service.apply_transform(x, tx, **kwargs)
  if ty in transform_service.TRANSFORMS:
    y = transform_service.apply_transform(y, ty, **kwargs)

  x_min = float(np.min(x))
  x_max = float(np.max(x))
  y_min = float(np.min(y))
  y_max = float(np.max(y))

  if x_max == x_min:
    delta = 1.0 if x_min == 0 else abs(x_min) * 0.01
    x_min -= delta
    x_max += delta
  if y_max == y_min:
    delta = 1.0 if y_min == 0 else abs(y_min) * 0.01
    y_min -= delta
    y_max += delta

  counts, x_edges, y_edges = np.histogram2d(
    y,
    x,
    bins=(bins_y, bins_x),
    range=[[y_min, y_max], [x_min, x_max]],
  )

  return (
    file_id,
    x_name,
    y_name,
    tx,
    ty,
    x_min,
    x_max,
    y_min,
    y_max,
    bins_x,
    bins_y,
    counts.tolist(),
  )


def get_gate_stats(gate_id: str) -> GateStatsResponse:
  """Return descriptive statistics (MFI, median, SD, CV) for all channels inside a gate's population.

  All statistics are computed in **raw (untransformed) channel space** — this matches the FlowJo
  convention for MFI reporting. The gate mask is reused from the cache when valid.
  """
  _cleanup_expired_suspended_files()
  record = _store.gates_by_id.get(gate_id)
  if record is None:
    raise KeyError(f"Gate {gate_id!r} not found")

  # Ensure stats cache is warm before reading cached pct values.
  if not record._cache_valid:
    _compute_stats(record)

  mask = _get_mask(record)
  raw_events = storage.get_file_events(record.file_id)  # always raw / compensated-raw, but not log-transformed
  metadata = storage.get_file_metadata(record.file_id)

  gate_events = raw_events[mask]  # shape (count, n_channels)
  count = int(gate_events.shape[0])

  channel_stats: list[ChannelStats] = []
  for ch in metadata.channels:
    idx = ch.index - 1
    if idx < 0 or idx >= raw_events.shape[1]:
      continue
    if count == 0:
      channel_stats.append(ChannelStats(
        channel_name=ch.name,
        display_name=ch.display_name or ch.name,
        mean=0.0,
        median=0.0,
        sd=0.0,
        cv=None,
      ))
      continue
    vals = gate_events[:, idx].astype(float)
    mean = float(np.mean(vals))
    median = float(np.median(vals))
    sd = float(np.std(vals, ddof=1)) if count > 1 else 0.0
    cv = round(sd / mean * 100, 2) if mean > 0 else None
    channel_stats.append(ChannelStats(
      channel_name=ch.name,
      display_name=ch.display_name or ch.name,
      mean=round(mean, 2),
      median=round(median, 2),
      sd=round(sd, 2),
      cv=cv,
    ))

  return GateStatsResponse(
    gate_id=gate_id,
    file_id=record.file_id,
    gate_name=record.name,
    count=count,
    pct_of_parent=round(record._cached_pct_of_parent or 0.0, 2),
    pct_total=round(record._cached_pct_total or 0.0, 2),
    channel_stats=channel_stats,
  )


def delete_all_gates_for_file(file_id: str) -> None:
  """Clear all gates for a file (e.g. on compensation reset or re-load)."""
  _store.suspended_files.discard(file_id)
  _store.suspended_at.pop(file_id, None)
  for gid in list(_store.root_children.get(file_id, [])):
    _evict_gate_subtree(gid)
  _store.root_children.pop(file_id, None)


# P-1: gate population CSV export


def export_gate_csv_stream(
  gate_id: str,
  max_events: int = 0,
) -> tuple[Iterator[str], str, int]:
  """Stream CSV rows for all raw events inside a gate population.

  Args:
    gate_id:    Gate to export.
    max_events: Maximum number of events to include; 0 = no limit (full gate).

  Returns:
    (row_generator, filename, count)
    - *row_generator* yields the header line then one data line per event.
    - *filename* is a safe download name derived from the gate name.
    - *count* is the number of data rows (after optional down-sampling).

  Raises:
    KeyError: gate not found.
  """
  _cleanup_expired_suspended_files()
  record = _store.gates_by_id.get(gate_id)
  if record is None:
    raise KeyError(f"Gate {gate_id!r} not found")

  mask = _get_mask(record)
  raw_events = storage.get_file_events(record.file_id)
  metadata = storage.get_file_metadata(record.file_id)

  gate_events = raw_events[mask]
  if max_events > 0 and gate_events.shape[0] > max_events:
    idx = np.random.choice(gate_events.shape[0], size=max_events, replace=False)
    gate_events = gate_events[np.sort(idx)]

  count = int(gate_events.shape[0])
  col_names = [ch.display_name or ch.name for ch in metadata.channels]
  safe_name = record.name.replace('"', "").replace("/", "_").replace("\\", "_").strip() or "gate"
  filename = f"{safe_name}_events.csv"

  # Capture as float64 array now so the generator doesn't hold a reference to the memmap
  data = gate_events.astype(np.float64)

  def _rows() -> Iterator[str]:
    yield ",".join(col_names) + "\n"
    for row in data:
      yield ",".join(f"{v:.6g}" for v in row) + "\n"

  return _rows(), filename, count


# Q-1: Batch gate copy


def copy_gates_between_files(
  source_file_id: str,
  target_file_ids: list[str],
) -> dict:
  """Copy the entire gate tree from one file to one or more target files.

  Creates new gates on target files with the same parameters. Preserves parent-child
  relationships and ordering.

  Returns:
    {
      "source_file_id": str,
      "target_file_ids": [str, ...],
      "gates_copied": int (per target),
      "results": { "target_file_id": int count, ... }
    }
  """
  _cleanup_expired_suspended_files()

  # Validate source file has gates
  source_gates = get_gate_tree(source_file_id)
  if not source_gates:
    raise ValueError(f"Source file {source_file_id!r} has no gates to copy")

  # Flatten source tree to get all gates in topological order
  def flatten_gates(nodes: list[GateResponse]) -> list[GateResponse]:
    out = []
    for node in nodes:
      out.append(node)
      out.extend(flatten_gates(node.children))
    return out

  all_source_gates = flatten_gates(source_gates)

  results = {}

  # For each target file
  for target_file_id in target_file_ids:
    # Verify target file exists
    try:
      storage.get_file_metadata(target_file_id)
    except KeyError:
      raise KeyError(f"Target file {target_file_id!r} not found")

    # Map source gate IDs to newly created gate IDs on target
    id_map: dict[str, str] = {}
    gates_count = 0

    # Create each gate on target (in topological order, so parents exist before children)
    for src_gate in all_source_gates:
      # Look up the mapped parent ID on target (or None if no parent)
      target_parent_id = id_map.get(src_gate.parent_gate_id) if src_gate.parent_gate_id else None

      # Build create request with source parameters
      if src_gate.type == "rectangle":
        params = RectangleGateCreate(
          type="rectangle",
          x_min=src_gate.x_min or 0.0,
          y_min=src_gate.y_min or 0.0,
          x_max=src_gate.x_max or 1000.0,
          y_max=src_gate.y_max or 1000.0,
        )
      elif src_gate.type == "polygon":
        params = PolygonGateCreate(
          type="polygon",
          vertices=src_gate.vertices or [[0, 0], [100, 0], [50, 100]],
        )
      elif src_gate.type == "interval":
        params = IntervalGateCreate(
          type="interval",
          x_min=src_gate.x_min or 0.0,
          x_max=src_gate.x_max or 1000.0,
        )
      elif src_gate.type == "boolean":
        params = BooleanGateCreate(
          type="boolean",
          expression=src_gate.expression or "",
        )
      elif src_gate.type == "ellipse":
        params = EllipseGateCreate(
          type="ellipse",
          center_x=src_gate.center_x or 500.0,
          center_y=src_gate.center_y or 500.0,
          radius_x=src_gate.radius_x or 100.0,
          radius_y=src_gate.radius_y or 100.0,
          angle=src_gate.angle or 0.0,
        )
      else:
        raise ValueError(f"Unknown gate type: {src_gate.type}")

      create_req = GateCreateRequest(
        file_id=target_file_id,
        name=src_gate.name,
        x_channel=src_gate.x_channel,
        y_channel=src_gate.y_channel,
        parent_gate_id=target_parent_id,
        order=src_gate.order,
        transform_x=src_gate.transform_x,
        transform_y=src_gate.transform_y,
        arcsinh_cofactor=src_gate.arcsinh_cofactor,
        logicle_T=src_gate.logicle_T,
        logicle_W=src_gate.logicle_W,
        logicle_M=src_gate.logicle_M,
        logicle_A=src_gate.logicle_A,
        params=params,
      )

      new_gate = create_gate(create_req)
      id_map[src_gate.id] = new_gate.id
      gates_count += 1

    results[target_file_id] = gates_count

  return {
    "source_file_id": source_file_id,
    "target_file_ids": target_file_ids,
    "results": results,
    "total_gates_copied": sum(results.values()),
  }
