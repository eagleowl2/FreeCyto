"""Gate layout storage and management — Phase U (enhanced).

Layouts capture a complete gate tree from a file and can be applied (cloned)
to other files.  Phase U adds:
  - Rich metadata (description, author, compatible_channels, tags)
  - Gating strategy (ordered list of GatingStep)
  - Disk persistence at ~/.freecyto/layouts.json
  - Full CRUD (update metadata, update strategy, delete)
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import List, Optional

from models.gate_models import GateResponse
from models.layout_models import GatingStep, LayoutMetadata, LayoutUpdateRequest

logger = logging.getLogger("opencyto")

# ─── persistence path ─────────────────────────────────────────────────────────

def _layouts_path() -> Path:
    base = Path(os.getenv("OPENCYTO_DATA_DIR", Path.home() / ".freecyto"))
    base.mkdir(parents=True, exist_ok=True)
    return base / "layouts.json"


# ─── domain model ─────────────────────────────────────────────────────────────

@dataclass
class Layout:
    """A saved gate tree snapshot with rich metadata and gating strategy."""

    id: str
    name: str
    gate_tree: list[GateResponse]
    source_file_id: str
    gate_count: int
    description: str = ""
    author: str = ""
    compatible_channels: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    strategy: list[GatingStep] = field(default_factory=list)
    created_date: datetime = field(default_factory=datetime.utcnow)
    modified_date: datetime = field(default_factory=datetime.utcnow)

    def to_metadata(self) -> LayoutMetadata:
        return LayoutMetadata(
            description=self.description,
            author=self.author,
            compatible_channels=self.compatible_channels,
            tags=self.tags,
        )


# ─── helpers ──────────────────────────────────────────────────────────────────

def _collect_channels(nodes: list[GateResponse]) -> set[str]:
    """Collect all unique channel names from a gate tree."""
    channels: set[str] = set()
    for node in nodes:
        if node.x_channel:
            channels.add(node.x_channel)
        if node.y_channel:
            channels.add(node.y_channel)
        channels.update(_collect_channels(node.children))
    return channels


def _flatten(nodes: list[GateResponse]) -> list[GateResponse]:
    """Flatten a tree of gates into a list."""
    out: list[GateResponse] = []
    for node in nodes:
        out.append(node)
        out.extend(_flatten(node.children))
    return out


# ─── serialisation helpers ────────────────────────────────────────────────────

def _gate_response_to_dict(g: GateResponse) -> dict:
    """Recursively convert GateResponse to a JSON-serialisable dict."""
    d = g.model_dump()
    d["children"] = [_gate_response_to_dict(c) for c in g.children]
    return d


def _gate_response_from_dict(d: dict) -> GateResponse:
    children = [_gate_response_from_dict(c) for c in d.pop("children", [])]
    gr = GateResponse(**d)
    gr.children = children
    return gr


def _layout_to_dict(layout: Layout) -> dict:
    return {
        "id": layout.id,
        "name": layout.name,
        "source_file_id": layout.source_file_id,
        "gate_count": layout.gate_count,
        "description": layout.description,
        "author": layout.author,
        "compatible_channels": layout.compatible_channels,
        "tags": layout.tags,
        "strategy": [s.model_dump() for s in layout.strategy],
        "created_date": layout.created_date.isoformat(),
        "modified_date": layout.modified_date.isoformat(),
        "gate_tree": [_gate_response_to_dict(g) for g in layout.gate_tree],
    }


def _layout_from_dict(d: dict) -> Layout:
    gate_tree = [_gate_response_from_dict(g) for g in d.get("gate_tree", [])]
    strategy = [GatingStep(**s) for s in d.get("strategy", [])]
    return Layout(
        id=d["id"],
        name=d["name"],
        gate_tree=gate_tree,
        source_file_id=d["source_file_id"],
        gate_count=d.get("gate_count", len(_flatten(gate_tree))),
        description=d.get("description", ""),
        author=d.get("author", ""),
        compatible_channels=d.get("compatible_channels", []),
        tags=d.get("tags", []),
        strategy=strategy,
        created_date=datetime.fromisoformat(d["created_date"]) if "created_date" in d else datetime.utcnow(),
        modified_date=datetime.fromisoformat(d["modified_date"]) if "modified_date" in d else datetime.utcnow(),
    )


# ─── store ────────────────────────────────────────────────────────────────────

class LayoutStore:
    """Thread-safe in-memory store with JSON persistence."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._layouts: dict[str, Layout] = {}
        self._load_from_disk()

    # ── persistence ──────────────────────────────────────────────────────────

    def _load_from_disk(self) -> None:
        path = _layouts_path()
        if not path.exists():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            for item in raw.get("layouts", []):
                layout = _layout_from_dict(item)
                self._layouts[layout.id] = layout
            logger.info("Loaded %d layouts from %s", len(self._layouts), path)
        except Exception:
            logger.exception("Failed to load layouts from disk — starting fresh")

    def _save_to_disk(self) -> None:
        path = _layouts_path()
        try:
            data = {
                "version": 2,
                "layouts": [_layout_to_dict(l) for l in self._layouts.values()],
            }
            path.write_text(json.dumps(data, default=str, indent=2), encoding="utf-8")
        except Exception:
            logger.exception("Failed to persist layouts to disk")

    # ── CRUD ─────────────────────────────────────────────────────────────────

    def save(self, name: str, gate_tree: list[GateResponse], source_file_id: str) -> Layout:
        """Save a gate tree as a new layout (creates new record, does not update)."""
        if not name.strip():
            raise ValueError("Layout name must not be empty")

        layout_id = str(uuid.uuid4())[:8]
        channels = sorted(_collect_channels(gate_tree))
        layout = Layout(
            id=layout_id,
            name=name.strip(),
            gate_tree=gate_tree,
            source_file_id=source_file_id,
            gate_count=len(_flatten(gate_tree)),
            compatible_channels=channels,
        )
        with self._lock:
            self._layouts[layout_id] = layout
            self._save_to_disk()
        return layout

    def list_all(self) -> list[Layout]:
        with self._lock:
            return list(self._layouts.values())

    def get(self, layout_id: str) -> Optional[Layout]:
        with self._lock:
            return self._layouts.get(layout_id)

    def update_metadata(self, layout_id: str, req: LayoutUpdateRequest) -> Layout:
        with self._lock:
            layout = self._layouts.get(layout_id)
            if layout is None:
                raise KeyError(f"Layout {layout_id!r} not found")
            if req.name is not None:
                if not req.name.strip():
                    raise ValueError("Layout name must not be empty")
                layout.name = req.name.strip()
            if req.metadata is not None:
                layout.description = req.metadata.description
                layout.author = req.metadata.author
                layout.compatible_channels = req.metadata.compatible_channels
                layout.tags = req.metadata.tags
            layout.modified_date = datetime.utcnow()
            self._save_to_disk()
            return layout

    def update_strategy(self, layout_id: str, steps: list[GatingStep]) -> Layout:
        with self._lock:
            layout = self._layouts.get(layout_id)
            if layout is None:
                raise KeyError(f"Layout {layout_id!r} not found")
            layout.strategy = steps
            layout.modified_date = datetime.utcnow()
            self._save_to_disk()
            return layout

    def delete(self, layout_id: str) -> bool:
        with self._lock:
            if layout_id in self._layouts:
                del self._layouts[layout_id]
                self._save_to_disk()
                return True
            return False

    def clear(self) -> None:
        """Remove all layouts (testing helper)."""
        with self._lock:
            self._layouts.clear()


# ─── module-level singleton ───────────────────────────────────────────────────

_layout_store = LayoutStore()


def save_layout(name: str, gate_tree: list[GateResponse], source_file_id: str) -> Layout:
    return _layout_store.save(name, gate_tree, source_file_id)


def list_layouts() -> list[Layout]:
    return _layout_store.list_all()


def get_layout(layout_id: str) -> Layout:
    layout = _layout_store.get(layout_id)
    if layout is None:
        raise KeyError(f"Layout {layout_id!r} not found")
    return layout


def update_layout(layout_id: str, req: LayoutUpdateRequest) -> Layout:
    return _layout_store.update_metadata(layout_id, req)


def update_strategy(layout_id: str, steps: list[GatingStep]) -> Layout:
    return _layout_store.update_strategy(layout_id, steps)


def delete_layout(layout_id: str) -> bool:
    return _layout_store.delete(layout_id)


def reset_layout_store() -> None:
    """Clear all layouts (for testing)."""
    _layout_store.clear()
