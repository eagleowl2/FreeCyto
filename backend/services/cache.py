from __future__ import annotations

"""
Cache directory management for memory-mapped FCS event files.

Layout (default):
    ~/.freecyto/cache/
        {file_id}_raw.npy   — raw float32 events, shape (n_events, n_channels)
        {file_id}_comp.npy  — compensated float32 events (same shape), optional

The cache is persistent across sessions. Files are only re-created if missing.
Eviction is handled via `clear_file(file_id)` or `clear_all()`.
"""

import gc
import shutil
import time
from pathlib import Path

import numpy as np

_DEFAULT_CACHE_DIR = Path.home() / ".freecyto" / "cache"


def get_cache_dir(override: Path | None = None) -> Path:
  """Return the cache directory, creating it if necessary."""
  d = override or _DEFAULT_CACHE_DIR
  d.mkdir(parents=True, exist_ok=True)
  return d


def raw_mmap_path(file_id: str, cache_dir: Path | None = None) -> Path:
  """Path to the raw events memmap file for a given file id."""
  return get_cache_dir(cache_dir) / f"{file_id}_raw.npy"


def raw_mmap_tmp_path(file_id: str, cache_dir: Path | None = None) -> Path:
  """Path to the in-progress raw memmap (atomic write: commit via :func:`os.replace`)."""
  return get_cache_dir(cache_dir) / f"{file_id}_raw.npy.tmp"


def comp_mmap_path(file_id: str, cache_dir: Path | None = None) -> Path:
  """Path to the compensated events memmap file for a given file id."""
  return get_cache_dir(cache_dir) / f"{file_id}_comp.npy"


def raw_exists(file_id: str, cache_dir: Path | None = None) -> bool:
  """Return True if a raw memmap file exists for this file id (path only; see :func:`raw_mmap_is_readable`)."""
  return raw_mmap_path(file_id, cache_dir).exists()


def raw_mmap_is_readable(
  file_id: str,
  cache_dir: Path | None = None,
  *,
  expected_n_channels: int | None = None,
) -> bool:
  """True if raw ``.npy`` exists, is non-trivial size, and opens as float32 2D (GAP-1)."""
  p = raw_mmap_path(file_id, cache_dir)
  if not p.exists() or p.stat().st_size < 128:
    return False
  try:
    mm = np.lib.format.open_memmap(str(p), mode="r")
    try:
      if mm.ndim != 2 or mm.shape[0] < 1:
        return False
      if mm.dtype != np.float32:
        return False
      if expected_n_channels is not None and mm.shape[1] != expected_n_channels:
        return False
      return True
    finally:
      del mm
  except Exception:
    return False


def comp_exists(file_id: str, cache_dir: Path | None = None) -> bool:
  """Return True if a compensated memmap file exists for this file id."""
  return comp_mmap_path(file_id, cache_dir).exists()


def clear_file(file_id: str, cache_dir: Path | None = None) -> None:
  """Remove all cached memmap files for a given file id.

  Retries unlink after :func:`gc.collect` and short sleeps so Windows can drop
  handles that other threads or request scopes released only recently (NEW‑CRIT‑3).
  """
  for p in (
    raw_mmap_path(file_id, cache_dir),
    raw_mmap_tmp_path(file_id, cache_dir),
    comp_mmap_path(file_id, cache_dir),
  ):
    if not p.exists():
      continue
    for attempt in range(6):
      try:
        p.unlink(missing_ok=True)
        break
      except OSError:
        gc.collect()
        if attempt < 5:
          time.sleep(0.01 * (attempt + 1))


def clear_all(cache_dir: Path | None = None) -> None:
  """Wipe the entire cache directory. Use with caution."""
  d = get_cache_dir(cache_dir)
  shutil.rmtree(d, ignore_errors=True)
  d.mkdir(parents=True, exist_ok=True)

