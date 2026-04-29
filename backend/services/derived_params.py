"""Derived (formula-based) virtual parameters.

A derived parameter is a named array computed by evaluating a math expression
over a file's raw channel data.  The result is cached after the first evaluation
and invalidated when the file is evicted or re-registered.

Expression evaluation uses a restricted ``eval()`` sandbox exposing only NumPy
math functions.  No Python builtins are available, so code injection is not
possible beyond basic math.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field

import numpy as np

from models.derived_param_models import DerivedParamCreate, DerivedParamResponse
from services import storage


# ---------------------------------------------------------------------------
# Safe expression evaluator
# ---------------------------------------------------------------------------

_SAFE_NS: dict = {
  "__builtins__": {},
  # NumPy functions exposed to the expression
  "log": np.log,
  "log10": np.log10,
  "log2": np.log2,
  "exp": np.exp,
  "sqrt": np.sqrt,
  "abs": np.abs,
  "arcsinh": np.arcsinh,
  "arctan2": np.arctan2,
  "clip": np.clip,
  "where": np.where,
  "nan": np.nan,
  "inf": np.inf,
  "pi": float(np.pi),
}


def _sanitize_varname(name: str) -> str:
  """Convert a channel name (e.g. 'FSC-A') to a valid Python identifier."""
  return "_ch_" + re.sub(r"[^a-zA-Z0-9]", "_", name)


def _preprocess_expression(expr: str, channel_names: list[str]) -> tuple[str, dict[str, str]]:
  """Replace channel names in *expr* with safe Python identifiers.

  Returns the rewritten expression and a mapping of {sanitized_name: original_name}.
  Channel names are replaced longest-first to avoid partial matches.
  """
  mapping: dict[str, str] = {}  # sanitized → original
  sorted_names = sorted(channel_names, key=len, reverse=True)
  processed = expr
  for name in sorted_names:
    sanitized = _sanitize_varname(name)
    # Replace exact occurrences of channel name in the expression.
    # Using re.escape so special chars like FSC-A are treated literally.
    processed = re.sub(re.escape(name), sanitized, processed)
    mapping[sanitized] = name
  return processed, mapping


def evaluate_expression(expr: str, channel_names: list[str], events: np.ndarray) -> np.ndarray:
  """Evaluate *expr* over *events* columns, returning a 1-D float64 array.

  ``channel_names`` must be in the same order as *events* columns.
  Raises ValueError on parse/evaluation errors.
  """
  processed_expr, mapping = _preprocess_expression(expr, channel_names)
  ns = dict(_SAFE_NS)
  # Build namespace: sanitized_name → column array
  for sanitized, original in mapping.items():
    try:
      idx = channel_names.index(original)
    except ValueError as exc:
      raise ValueError(f"Channel {original!r} not found") from exc
    ns[sanitized] = events[:, idx].astype(np.float64)
  try:
    result = eval(processed_expr, ns)  # noqa: S307 — restricted namespace, local app only
  except Exception as exc:
    raise ValueError(f"Expression evaluation error: {exc}") from exc
  result = np.asarray(result, dtype=np.float64)
  if result.ndim == 0:
    # Scalar result (e.g. constant expression) — broadcast to all events
    result = np.full(events.shape[0], float(result))
  elif result.shape != (events.shape[0],):
    raise ValueError(
      f"Expression produced shape {result.shape}, expected ({events.shape[0]},)"
    )
  return result


# ---------------------------------------------------------------------------
# In-memory store
# ---------------------------------------------------------------------------


@dataclass
class DerivedParamRecord:
  id: str
  file_id: str
  name: str
  expression: str
  _cached_values: np.ndarray | None = field(default=None, repr=False)


_store: dict[str, DerivedParamRecord] = {}  # param_id → record
_by_file: dict[str, list[str]] = {}  # file_id → [param_id, ...]


def reset_derived_param_store() -> None:
  """Clear all records (for tests)."""
  _store.clear()
  _by_file.clear()


# ---------------------------------------------------------------------------
# Service functions
# ---------------------------------------------------------------------------


def create_derived_param(body: DerivedParamCreate) -> DerivedParamResponse:
  """Create a derived parameter for *body.file_id*, evaluating the expression immediately."""
  meta = storage.get_file_metadata(body.file_id)
  events = storage.get_file_events(body.file_id)
  channel_names = [ch.name for ch in meta.channels]

  # Check name uniqueness per file
  existing_names = {_store[pid].name for pid in _by_file.get(body.file_id, [])}
  if body.name in existing_names:
    raise ValueError(f"Derived parameter {body.name!r} already exists for this file")

  # Evaluate expression eagerly to catch errors at creation time
  values = evaluate_expression(body.expression, channel_names, events)

  param_id = str(uuid.uuid4())
  record = DerivedParamRecord(
    id=param_id,
    file_id=body.file_id,
    name=body.name,
    expression=body.expression,
    _cached_values=values,
  )
  _store[param_id] = record
  _by_file.setdefault(body.file_id, []).append(param_id)
  return DerivedParamResponse(id=param_id, file_id=body.file_id, name=body.name, expression=body.expression)


def list_derived_params(file_id: str) -> list[DerivedParamResponse]:
  return [
    DerivedParamResponse(id=_store[pid].id, file_id=file_id, name=_store[pid].name, expression=_store[pid].expression)
    for pid in _by_file.get(file_id, [])
    if pid in _store
  ]


def delete_derived_param(file_id: str, param_id: str) -> None:
  if param_id not in _store or _store[param_id].file_id != file_id:
    raise KeyError(f"Derived parameter {param_id!r} not found for file {file_id!r}")
  del _store[param_id]
  if file_id in _by_file:
    _by_file[file_id] = [pid for pid in _by_file[file_id] if pid != param_id]


def get_derived_param_values(file_id: str, param_name: str) -> np.ndarray:
  """Return cached evaluation array for *param_name*; raises KeyError if not found."""
  for pid in _by_file.get(file_id, []):
    rec = _store.get(pid)
    if rec and rec.name == param_name:
      if rec._cached_values is None:
        # Re-evaluate (e.g. after cache invalidation)
        meta = storage.get_file_metadata(file_id)
        events = storage.get_file_events(file_id)
        channel_names = [ch.name for ch in meta.channels]
        rec._cached_values = evaluate_expression(rec.expression, channel_names, events)
      return rec._cached_values
  raise KeyError(f"Derived parameter {param_name!r} not found for file {file_id!r}")


def is_derived_param(file_id: str, param_name: str) -> bool:
  """Return True if *param_name* is a derived parameter for *file_id*."""
  return any(
    _store[pid].name == param_name
    for pid in _by_file.get(file_id, [])
    if pid in _store
  )


def invalidate_file_caches(file_id: str) -> None:
  """Clear cached evaluation arrays when file events change (e.g. compensation)."""
  for pid in _by_file.get(file_id, []):
    rec = _store.get(pid)
    if rec:
      rec._cached_values = None
