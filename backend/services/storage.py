from __future__ import annotations

import gc
import os
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Optional

import numpy as np

from models.file_models import FileMetadata
from models.transform_models import ChannelTransform
from services import cache as cache_service


@dataclass
class FileRecord:
  """Metadata plus paths to disk-backed event memmaps."""

  metadata: FileMetadata
  mmap_path_raw: Path
  mmap_path_comp: Optional[Path] = None
  comp_matrix: Optional[np.ndarray] = None
  cond: Optional[float] = None
  is_compensated: bool = False
  active_transforms: Dict[str, ChannelTransform] = field(default_factory=dict)
  _mm_raw: Optional[np.memmap] = field(default=None, repr=False, compare=False)  # type: ignore[type-arg]
  _mm_comp: Optional[np.memmap] = field(default=None, repr=False, compare=False)  # type: ignore[type-arg]

  def open_raw(self) -> np.memmap:
    if self._mm_raw is None:
      self._mm_raw = np.lib.format.open_memmap(str(self.mmap_path_raw), mode="r")
    return self._mm_raw

  def open_comp(self) -> np.memmap:
    if self.mmap_path_comp is None:
      raise ValueError("No compensated events memmap for this file")
    if self._mm_comp is None:
      self._mm_comp = np.lib.format.open_memmap(str(self.mmap_path_comp), mode="r")
    return self._mm_comp

  def close_comp(self) -> None:
    if self._mm_comp is not None:
      del self._mm_comp
      self._mm_comp = None

  def close(self) -> None:
    """Release cached read memmaps (call before deleting cache files on disk)."""
    if self._mm_raw is not None:
      del self._mm_raw
      self._mm_raw = None
    if self._mm_comp is not None:
      del self._mm_comp
      self._mm_comp = None


MAX_CACHE_BYTES = int(os.getenv("OPENCYTO_CACHE_MB", "2048")) * 1024**2


class FileStore:
  """LRU cache of FileRecord objects with a memory cap."""

  def __init__(self) -> None:
    self._records: "OrderedDict[str, FileRecord]" = OrderedDict()
    self._bytes_used: int = 0
    self._evict_callbacks: list[Callable[[str, bool], None]] = []

  def register_evict_callback(self, cb: Callable[[str, bool], None]) -> None:
    """Register a callback invoked when a file leaves the store.

    Second argument is ``hard_delete``: ``True`` when the client called :meth:`delete`
    (explicit removal), ``False`` when the record was dropped due to LRU eviction.
    """
    self._evict_callbacks.append(cb)

  def _notify_evicted(
    self,
    file_id: str,
    record: Optional["FileRecord"] = None,
    *,
    hard_delete: bool,
  ) -> None:
    """Eviction / delete: close this record's read memmaps first, then callbacks, then disk cache.

    ``record.close()`` runs before ``clear_file`` so the store drops its mmap handles first
    (NEW‑CRIT‑2). A following ``gc.collect()`` helps other refcount‑zero memmaps from the same
    file disappear before unlink (NEW‑CRIT‑3 / Windows). Same‑id re‑register never calls this.
    """
    if record is not None:
      record.close()
    gc.collect()
    for cb in self._evict_callbacks:
      try:
        cb(file_id, hard_delete)
      except Exception:
        pass
    gc.collect()
    cache_service.clear_file(file_id)

  def _estimate_size(self, record: FileRecord) -> int:
    # Approximate size based on event count and channel count (4 bytes per float).
    base = record.metadata.event_count * max(len(record.metadata.channels), 1) * 4
    if record.is_compensated and record.mmap_path_comp is not None:
      base *= 2
    return int(base)

  def add(self, file_id: str, record: FileRecord) -> None:
    # Replacing an existing id (re-register) adjusts bytes only; do not treat as eviction.
    if file_id in self._records:
      old = self._records.pop(file_id)
      self._bytes_used -= self._estimate_size(old)
      old.close()
    size = self._estimate_size(record)
    # Evict oldest until we have room
    while self._bytes_used + size > MAX_CACHE_BYTES and self._records:
      evicted_id, evicted = self._records.popitem(last=False)
      self._bytes_used -= self._estimate_size(evicted)
      self._notify_evicted(evicted_id, evicted, hard_delete=False)
    self._records[file_id] = record
    self._records.move_to_end(file_id, last=True)
    self._bytes_used += size

  def get(self, file_id: str) -> FileRecord:
    try:
      record = self._records[file_id]
    except KeyError as exc:
      raise KeyError(f"Unknown file id: {file_id}") from exc
    # mark as recently used
    self._records.move_to_end(file_id, last=True)
    return record

  def delete(self, file_id: str) -> None:
    try:
      record = self._records.pop(file_id)
    except KeyError as exc:
      raise KeyError(f"Unknown file id: {file_id}") from exc
    self._bytes_used -= self._estimate_size(record)
    self._notify_evicted(file_id, record, hard_delete=True)

  def cache_status(self) -> Dict[str, int]:
    return {
      "bytes_used": self._bytes_used,
      "max_bytes": MAX_CACHE_BYTES,
      "file_count": len(self._records),
    }

  def list_file_ids(self) -> list[str]:
    return list(self._records.keys())

  def close_record_mmaps(self, file_id: str) -> None:
    """Release read memmaps for a loaded file (e.g. before replacing its on-disk raw file)."""
    rec = self._records.get(file_id)
    if rec is not None:
      rec.close()


_store = FileStore()


def register_file(metadata: FileMetadata, events: np.ndarray | Path) -> None:
  """Register a file given metadata and raw events or a path to an existing raw .npy.

  For in-memory arrays (e.g. synthetic tests), this helper writes a small
  memmap file into the cache directory so that all accesses go through the
  same disk-backed path.

  Pass a :class:`pathlib.Path` to an existing float32 ``(n_events, n_channels)``
  memmap file (typically ``{file_id}_raw.npy``) so the store only records the
  path and does not hold an extra memmap handle from the parser.
  """
  cache_dir = cache_service.get_cache_dir()
  _store.close_record_mmaps(metadata.id)
  if isinstance(events, Path):
    mmap_path = events
    if not mmap_path.is_file():
      raise FileNotFoundError(f"Raw events memmap not found: {mmap_path}")
  elif isinstance(events, np.memmap):
    events.flush()
    mmap_path = Path(events.filename)  # type: ignore[arg-type]
  else:
    mmap_path = cache_service.raw_mmap_path(metadata.id, cache_dir)
    mm = np.lib.format.open_memmap(
      str(mmap_path),
      mode="w+",
      dtype=np.float32,
      shape=events.shape,
    )
    mm[:] = events.astype(np.float32)
    mm.flush()
    del mm
  record = FileRecord(metadata=metadata, mmap_path_raw=mmap_path)
  _store.add(metadata.id, record)
  from services import gates as gates_service

  gates_service.resume_gates_for_file(metadata.id)


def get_file_metadata(file_id: str) -> FileMetadata:
  record = _store.get(file_id)
  return record.metadata


def _get_record(file_id: str) -> FileRecord:
  return _store.get(file_id)


def get_file_events(file_id: str) -> np.ndarray:
  record = _get_record(file_id)
  if record.is_compensated and record.mmap_path_comp is not None:
    return record.open_comp()
  return record.open_raw()


def get_raw_events(file_id: str) -> np.ndarray:
  record = _get_record(file_id)
  return record.open_raw()


def set_compensation(file_id: str, comp_events: np.ndarray, matrix: np.ndarray, cond: float) -> None:
  record = _get_record(file_id)
  record.close_comp()
  cache_dir = cache_service.get_cache_dir()
  mmap_path = cache_service.comp_mmap_path(file_id, cache_dir)
  mm = np.lib.format.open_memmap(
    str(mmap_path),
    mode="w+",
    dtype=np.float32,
    shape=comp_events.shape,
  )
  mm[:] = comp_events.astype(np.float32)
  mm.flush()
  del mm
  record.mmap_path_comp = mmap_path
  record.comp_matrix = matrix
  record.cond = float(cond)
  record.is_compensated = True


def clear_compensation(file_id: str) -> None:
  record = _get_record(file_id)
  record.close_comp()
  if record.mmap_path_comp is not None and record.mmap_path_comp.exists():
    record.mmap_path_comp.unlink()
  record.mmap_path_comp = None
  record.comp_matrix = None
  record.cond = None
  record.is_compensated = False


def get_compensation_status(file_id: str) -> Dict[str, Optional[float]]:
  record = _get_record(file_id)
  return {
    "file_id": record.metadata.id,
    "is_compensated": record.is_compensated,
    "n_channels": len(record.metadata.channels),
    "cond": record.cond,
  }


def register_evict_callback(cb: Callable[[str, bool], None]) -> None:
  """Register a callback invoked when a file leaves the store (see :meth:`FileStore.register_evict_callback`)."""
  _store.register_evict_callback(cb)


def delete_file(file_id: str) -> None:
  _store.delete(file_id)


def get_cache_status() -> Dict[str, int]:
  return _store.cache_status()


def list_loaded_file_ids() -> list[str]:
  """Return all currently loaded file ids (for workspace save)."""
  return _store.list_file_ids()


def get_compensation_matrix(file_id: str) -> Optional[np.ndarray]:
  """Return the current compensation matrix for a file, or None if not compensated."""
  record = _get_record(file_id)
  return record.comp_matrix


def get_file_metadata_if_loaded(file_id: str) -> Optional[FileMetadata]:
  """Return metadata if file is in store, else None."""
  try:
    return _store.get(file_id).metadata
  except KeyError:
    return None


def get_file_events_downsampled(file_id: str, max_events: int) -> np.ndarray:
  """Return up to max_events events for a file (randomly downsampled).

  Always returns an in-memory array that does **not** alias the on-disk memmap,
  so display-path callers cannot write through to the cache file (guarded by
  ``test_backend_workflow`` — display fetches must never side-effect gate counts).
  """
  events = get_file_events(file_id)
  n_events = events.shape[0]
  if n_events <= max_events:
    return np.array(events)

  # Randomly choose a subset of rows without replacement; sort indices for sequential disk reads
  indices = np.sort(np.random.choice(n_events, size=max_events, replace=False))
  # Fancy indexing already materialises a fresh, owned array — wrapping it in
  # np.array() would duplicate the whole downsample a second time (e.g. an extra
  # 15 MB per density request on a 200k x 19 float32 sample).
  return events[indices]


