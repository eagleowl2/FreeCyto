"""Gate layout storage and management.

Layouts capture a complete gate tree from a file and can be applied (cloned) to other files.
Stored in-memory per session; does not persist across restarts.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Optional

from models.gate_models import GateResponse


@dataclass
class Layout:
  """A saved gate tree snapshot with metadata."""

  id: str
  name: str
  gate_tree: list[GateResponse]
  source_file_id: str
  gate_count: int


class LayoutStore:
  """In-memory storage for gate layouts (session-scoped)."""

  def __init__(self) -> None:
    self._layouts: dict[str, Layout] = {}

  def save(self, name: str, gate_tree: list[GateResponse], source_file_id: str) -> Layout:
    """Save a gate tree as a layout. Returns the created layout."""
    if not name.strip():
      raise ValueError("Layout name must not be empty")

    layout_id = str(uuid.uuid4())[:8]
    layout = Layout(
      id=layout_id,
      name=name.strip(),
      gate_tree=gate_tree,
      source_file_id=source_file_id,
      gate_count=len(self._flatten(gate_tree)),
    )
    self._layouts[layout_id] = layout
    return layout

  def list_all(self) -> list[Layout]:
    """Return all saved layouts."""
    return list(self._layouts.values())

  def get(self, layout_id: str) -> Optional[Layout]:
    """Retrieve a layout by ID."""
    return self._layouts.get(layout_id)

  def delete(self, layout_id: str) -> bool:
    """Delete a layout. Returns True if found."""
    if layout_id in self._layouts:
      del self._layouts[layout_id]
      return True
    return False

  @staticmethod
  def _flatten(nodes: list[GateResponse]) -> list[GateResponse]:
    """Flatten a tree of gates into a list."""
    out = []
    for node in nodes:
      out.append(node)
      out.extend(LayoutStore._flatten(node.children))
    return out


_layout_store = LayoutStore()


def save_layout(name: str, gate_tree: list[GateResponse], source_file_id: str) -> Layout:
  """Save a gate tree as a layout."""
  return _layout_store.save(name, gate_tree, source_file_id)


def list_layouts() -> list[Layout]:
  """List all saved layouts."""
  return _layout_store.list_all()


def get_layout(layout_id: str) -> Layout:
  """Get a layout by ID. Raises KeyError if not found."""
  layout = _layout_store.get(layout_id)
  if layout is None:
    raise KeyError(f"Layout {layout_id!r} not found")
  return layout


def delete_layout(layout_id: str) -> bool:
  """Delete a layout. Returns True if found."""
  return _layout_store.delete(layout_id)
