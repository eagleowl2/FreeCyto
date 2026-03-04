from __future__ import annotations

import os
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

import numpy as np

from models.file_models import FileMetadata
from models.transform_models import ChannelTransform


@dataclass
class FileRecord:
  metadata: FileMetadata
  raw_events: np.ndarray  # never mutated after load
  comp_events: Optional[np.ndarray] = None
  comp_matrix: Optional[np.ndarray] = None
  cond: Optional[float] = None
  is_compensated: bool = False
  active_transforms: Dict[str, ChannelTransform] = field(default_factory=dict)


MAX_CACHE_BYTES = int(os.getenv("OPENCYTO_CACHE_MB", "2048")) * 1024**2


class FileStore:
  """LRU cache of FileRecord objects with a memory cap."""

  def __init__(self) -> None:
    self._records: "OrderedDict[str, FileRecord]" = OrderedDict()
    self._bytes_used: int = 0

  def _estimate_size(self, record: FileRecord) -> int:
    return int(record.raw_events.nbytes)

  def add(self, file_id: str, record: FileRecord) -> None:
    size = self._estimate_size(record)
    # Evict oldest until we have room
    while self._bytes_used + size > MAX_CACHE_BYTES and self._records:
      _, evicted = self._records.popitem(last=False)
      self._bytes_used -= self._estimate_size(evicted)
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

  def cache_status(self) -> Dict[str, int]:
    return {
      "bytes_used": self._bytes_used,
      "max_bytes": MAX_CACHE_BYTES,
      "file_count": len(self._records),
    }


_store = FileStore()


def register_file(metadata: FileMetadata, events: np.ndarray) -> None:
  record = FileRecord(metadata=metadata, raw_events=events)
  _store.add(metadata.id, record)


def get_file_metadata(file_id: str) -> FileMetadata:
  record = _store.get(file_id)
  return record.metadata


def _get_record(file_id: str) -> FileRecord:
  return _store.get(file_id)


def get_file_events(file_id: str) -> np.ndarray:
  record = _get_record(file_id)
  if record.is_compensated and record.comp_events is not None:
    return record.comp_events
  return record.raw_events


def get_raw_events(file_id: str) -> np.ndarray:
  record = _get_record(file_id)
  return record.raw_events


def set_compensation(file_id: str, comp_events: np.ndarray, matrix: np.ndarray, cond: float) -> None:
  record = _get_record(file_id)
  record.comp_events = comp_events
  record.comp_matrix = matrix
  record.cond = float(cond)
  record.is_compensated = True


def clear_compensation(file_id: str) -> None:
  record = _get_record(file_id)
  record.comp_events = None
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


def delete_file(file_id: str) -> None:
  _store.delete(file_id)


def get_cache_status() -> Dict[str, int]:
  return _store.cache_status()


def get_file_events_downsampled(file_id: str, max_events: int) -> np.ndarray:
  """Return up to max_events events for a file (randomly downsampled)."""
  events = get_file_events(file_id)
  n_events = events.shape[0]
  if n_events <= max_events:
    return events

  # Randomly choose a subset of rows without replacement
  indices = np.random.choice(n_events, size=max_events, replace=False)
  return events[indices]


