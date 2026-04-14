"""Auto-save workspace JSON for session restore (Sprint: persistent gate cache layer 1)."""

from __future__ import annotations

import json
import threading
import warnings
from pathlib import Path

_SESSION_FILE = Path.home() / ".freecyto" / "session.json"
_lock = threading.Lock()


def save_session(ws_dict: dict) -> None:
  """Write workspace JSON to disk (atomic tmp + replace). Non-blocking (daemon thread)."""

  def _write() -> None:
    with _lock:
      try:
        _SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _SESSION_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(ws_dict, indent=2), encoding="utf-8")
        tmp.replace(_SESSION_FILE)
      except OSError as e:
        warnings.warn(f"[Session] Failed to save session: {e}", stacklevel=1)

  threading.Thread(target=_write, daemon=True).start()


def load_session() -> dict | None:
  """Return the last session dict, or None if missing/invalid."""
  if not _SESSION_FILE.exists():
    return None
  try:
    return json.loads(_SESSION_FILE.read_text(encoding="utf-8"))
  except (OSError, json.JSONDecodeError):
    return None


def clear_session() -> None:
  """Remove persisted session file."""
  try:
    if _SESSION_FILE.exists():
      _SESSION_FILE.unlink()
  except OSError:
    pass
