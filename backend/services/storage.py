from __future__ import annotations

from typing import Dict, Tuple

import numpy as np

from models.file_models import FileMetadata


# Store current events matrix per file. For MVP, compensation overwrites this
# matrix; we can extend this to track raw vs compensated later.
_files: Dict[str, Tuple[FileMetadata, np.ndarray]] = {}


def register_file(metadata: FileMetadata, events: np.ndarray) -> None:
  _files[metadata.id] = (metadata, events)


def get_file_metadata(file_id: str) -> FileMetadata:
  try:
    metadata, _ = _files[file_id]
  except KeyError as exc:
    raise KeyError(f"Unknown file id: {file_id}") from exc
  return metadata


def get_file_events(file_id: str) -> np.ndarray:
  try:
    _, events = _files[file_id]
  except KeyError as exc:
    raise KeyError(f"Unknown file id: {file_id}") from exc
  return events


def set_file_events(file_id: str, events: np.ndarray) -> None:
  """Replace the stored events matrix for a file."""
  try:
    metadata, _ = _files[file_id]
  except KeyError as exc:
    raise KeyError(f"Unknown file id: {file_id}") from exc
  _files[file_id] = (metadata, events)


def get_file_events_downsampled(file_id: str, max_events: int) -> np.ndarray:
  """Return up to max_events events for a file (randomly downsampled)."""
  events = get_file_events(file_id)
  n_events = events.shape[0]
  if n_events <= max_events:
    return events

  # Randomly choose a subset of rows without replacement
  indices = np.random.choice(n_events, size=max_events, replace=False)
  return events[indices]


